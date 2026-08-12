//! Remote mode — one machine browsing another's library over the LAN.
//!
//! Both ends live here, because they are two ends of one wire and describing
//! the protocol twice is how the two halves drift apart.
//!
//! ```text
//! client (Session)                        host (Sharing)
//!   invoke ─▶ remote_call ──POST /rpc──▶  api::dispatch, against the host index
//!   luma://?path=… ────────GET /file──▶   protocol::serve, host's allowlist
//!
//! browser client (a phone on the same network)
//!   GET /            ─────────────────▶   the built SPA, embedded in the binary
//!   POST /login      ─────────────────▶   passphrase in, session cookie out
//!   fetch /rpc, <img src=/file?…>  ──▶    the same two routes, cookie instead
//!                                         of the header
//! ```
//!
//! # Why the page never talks to the peer itself
//!
//! The webview's CSP forbids it from reaching any remote origin, and that is
//! what makes the `luma://` allowlist worth having: an allowlisted read cannot
//! be exfiltrated by a page with nowhere to send it. Remote mode must not be
//! the hole in that, so the page keeps talking only to the IPC and to
//! `luma://`, and Rust does the network. It also means the whole frontend is
//! unchanged by this feature — one seam decides where a call goes.
//!
//! The browser client does not weaken that argument, though it looks like it
//! should: there the page *is* served by the host and talks straight back to
//! it. But that page runs on a machine with no library, no `luma://`, and no
//! filesystem access at all — the only thing it could exfiltrate is what the
//! host already chose to serve it, and the page itself is pinned to `'self'`
//! by the CSP header the static route sends.
//!
//! # What protects the port
//!
//! - Sharing is off until somebody turns it on, on that machine.
//! - Turning it on requires a passphrase, and **every** data request carries a
//!   credential — the file route as much as the RPC one. The desktop client
//!   sends the passphrase itself in a header; a browser session sends the
//!   cookie `POST /login` traded it for. The cookie exists because an
//!   `<img src>` cannot carry a custom header, and it is a fresh random token
//!   per sharing start, so stopping the server ends every browser session.
//! - The SPA shell and the login route answer without a credential — a login
//!   page nobody can load is not a login page — but they only ever hand out
//!   the app's own static bytes.
//! - Only private addresses are answered, and only private addresses may be
//!   connected to. A library cannot be published to the internet by typing an
//!   address into a box.
//!
//! Given the passphrase, a session can do everything a person sitting at the
//! machine can, deletions included. That is the point of it and also the whole
//! risk: the passphrase is the only thing between the LAN and the library.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::protocol::{extract_path, FileReply, ProtocolRoots};
use crate::types::{RemoteStatus, ShareStatus};

/// Next to Forge's 7860 and well clear of the two dev servers (4330, 4340).
pub const DEFAULT_PORT: u16 = 7870;

pub const SHARE_SETTING: &str = "share_enabled";
pub const LAST_ADDRESS_SETTING: &str = "remote_last_address";

/// Not beside the index: this is a bearer credential for the whole library,
/// and SQLite would put it in plaintext in a file that gets copied around with
/// backups. Same store the DeviantArt refresh token uses.
const KEYCHAIN_SERVICE: &str = "net.glitchvector.luma-vault.remote";
/// What this machine demands of anyone connecting to it.
const HOST_PASSPHRASE: &str = "share-passphrase";
/// What it last used to connect *out*, so reconnecting is one click.
const CLIENT_PASSPHRASE: &str = "last-passphrase";

const PASSPHRASE_HEADER: &str = "x-luma-passphrase";
const HELLO_ROUTE: &str = "/luma/v1/hello";
const RPC_ROUTE: &str = "/luma/v1/rpc";
const FILE_ROUTE: &str = "/luma/v1/file";
const LOGIN_ROUTE: &str = "/luma/v1/login";
const LOGOUT_ROUTE: &str = "/luma/v1/logout";

/// The cookie a browser session holds instead of the passphrase.
const SESSION_COOKIE: &str = "luma_session";

/// Everything under here is the API; everything else is the static SPA.
const API_PREFIX: &str = "/luma/";

/// How the API's answers are cached: not at all. The file route advertises
/// `immutable` because its content is content-addressed; an RPC answer or a
/// greeting is neither, and a browser that cached a 200 from `/hello` would
/// keep reporting a session that logging out already ended.
const CACHE_NONE: &str = "no-store";
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// What the served page may reach: itself and nothing else. This is the
/// browser-client counterpart of the webview CSP in `tauri.conf.json` — the
/// page can read what the host serves it, and has nowhere else to send it.
/// `'unsafe-inline'` for styles because React writes `style=` attributes.
const STATIC_CSP: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; \
    connect-src 'self'";

/// How many requests the shared library answers at once.
///
/// A grid scrolling through a large folder issues dozens of thumbnail requests
/// in a burst, and Chromium holds about six connections per origin — so eight
/// threads covers a saturated client with one to spare for the RPC that is
/// waiting behind them. They are threads rather than tasks because everything
/// they do is blocking: a SQLite query and a file read.
const WORKERS: usize = 8;

/// How long an ordinary remote operation may take before the caller is told the
/// peer is not answering.
///
/// Generous rather than snappy: a query against a 160,000-row index on a machine
/// that is mid-scan is seconds, and timing that out would be a bug of its own.
/// What it rules out is the *unbounded* wait.
const CALL_TIMEOUT: Duration = Duration::from_secs(25);

/// Operations that genuinely run for minutes, and would be broken by the limit
/// above. Each reports progress separately, so a person is never watching a
/// still window while one of these runs.
const SLOW_OPERATIONS: [&str; 4] = [
    "upscale_media",
    "find_duplicates",
    "deviantart_send",
    "import_image_browser_db",
];

/// A ceiling for those, so even they cannot hang the session for ever.
const SLOW_CALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/// True for the address ranges a home network actually uses.
///
/// Loopback is in deliberately — it is how this is tested, and a machine
/// reaching itself is not an escape. Everything else public is refused at both
/// ends: the client will not dial it and the host will not answer it.
pub fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            // A dual-stack listener reports an IPv4 peer as ::ffff:192.168.x.y,
            // so the v4 rules have to be applied to it rather than the v6 ones.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_lan(IpAddr::V4(mapped));
            }
            let segments = v6.segments();
            // fc00::/7 (unique local) and fe80::/10 (link local). The stdlib
            // predicates for both are still unstable.
            v6.is_loopback()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
        }
    }
}

/// `192.168.1.9`, `192.168.1.9:7870` and `http://192.168.1.9:7870/` are all the
/// same machine. Returns the canonical `ip:port` form.
///
/// IP literals only, deliberately. A hostname would have to be resolved before
/// the private-address rule could be applied to it, which turns a typo into a
/// lookup against whatever the network's resolver is — and not reaching past
/// the LAN is the entire rule.
pub fn parse_address(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let trimmed = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("type the address the other machine shows, like 192.168.1.42".to_string());
    }

    let (ip, port) = if let Ok(socket) = trimmed.parse::<SocketAddr>() {
        (socket.ip(), socket.port())
    } else if let Ok(ip) = trimmed.parse::<IpAddr>() {
        (ip, DEFAULT_PORT)
    } else if let Some((host, port)) = trimmed.rsplit_once(':') {
        let ip = host
            .trim_matches(|c| c == '[' || c == ']')
            .parse::<IpAddr>()
            .map_err(|_| not_an_address(host))?;
        let port = port
            .parse::<u16>()
            .map_err(|_| format!("{port} is not a port number"))?;
        (ip, port)
    } else {
        return Err(not_an_address(trimmed));
    };

    if !is_lan(ip) {
        return Err(format!(
            "{ip} is not a local address — remote mode only reaches machines on this network"
        ));
    }
    Ok(socket_string(ip, port))
}

fn not_an_address(value: &str) -> String {
    format!("{value} is not an IP address — type the numbers the other machine shows")
}

fn socket_string(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    }
}

/// The address this machine appears to be on, to read out to the other one.
///
/// Asked of the routing table rather than of the interface list: a UDP socket
/// that is `connect`ed sends nothing — connecting only fixes a peer, which
/// makes the OS pick the interface it *would* route through and then report
/// that interface's address. Enumerating interfaces means a platform crate and
/// then guessing which of six answers (Hyper-V, WSL, Docker, a VPN) is the one
/// somebody can actually reach.
pub fn local_addresses(port: u16) -> Vec<String> {
    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
        return Vec::new();
    };
    // Any off-link address will do; no packet is sent to it.
    if socket.connect(("10.254.254.254", 1)).is_err() {
        return Vec::new();
    }
    match socket.local_addr() {
        Ok(addr) if is_lan(addr.ip()) => vec![socket_string(addr.ip(), port)],
        _ => Vec::new(),
    }
}

/// What to call this machine in the other one's status bar.
///
/// From the environment rather than a syscall: `COMPUTERNAME` is always set on
/// Windows, which is where both ends of this run. Elsewhere it may be missing —
/// a GUI app does not inherit a login shell's variables — and the address is
/// then the only label, which is honest rather than wrong.
pub fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The passphrase
// ---------------------------------------------------------------------------

/// Whether two passphrases match, without leaking where they stopped matching.
///
/// Digests rather than the strings themselves. Comparing bytes pairwise returns
/// on the first difference, and a few thousand attempts against a LAN service
/// is enough to read a passphrase off those timings one character at a time.
/// Two 32-byte digests always take the same time to compare, and equal digests
/// mean equal inputs.
fn same_passphrase(offered: &str, expected: &str) -> bool {
    if expected.is_empty() {
        // An empty expectation matching an empty offer would mean an
        // unprotected port looked exactly like a protected one.
        return false;
    }
    let left = Sha256::digest(offered.as_bytes());
    let right = Sha256::digest(expected.as_bytes());
    let mut difference = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

fn secret(name: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name)
        .ok()?
        .get_password()
        .ok()
        .filter(|value| !value.is_empty())
}

fn set_secret(name: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name)
        .map_err(|error| format!("cannot reach the credential store: {error}"))?
        .set_password(value)
        .map_err(|error| format!("cannot save the passphrase: {error}"))
}

pub fn stored_host_passphrase() -> Option<String> {
    secret(HOST_PASSPHRASE)
}

pub fn store_host_passphrase(value: &str) -> Result<(), String> {
    set_secret(HOST_PASSPHRASE, value)
}

pub fn stored_client_passphrase() -> Option<String> {
    secret(CLIENT_PASSPHRASE)
}

pub fn store_client_passphrase(value: &str) -> Result<(), String> {
    set_secret(CLIENT_PASSPHRASE, value)
}

// ---------------------------------------------------------------------------
// The client half
// ---------------------------------------------------------------------------

/// A live connection to another machine's library.
pub struct Session {
    address: String,
    passphrase: String,
    host: String,
    folders: i64,
    items: i64,
    client: reqwest::Client,
}

impl Session {
    /// Dial a machine and read its greeting, which is also the passphrase check.
    ///
    /// Failing here rather than on the first query is the point: "connected" has
    /// to mean something, and the dialog needs a reason to show when it did not
    /// work.
    pub async fn connect(address: &str, passphrase: &str) -> Result<Session, String> {
        if passphrase.trim().is_empty() {
            return Err("the other machine needs a passphrase".to_string());
        }
        let client = reqwest::Client::builder()
            // A short *connect* timeout, because somebody is watching a button.
            // No read timeout: this same client carries an upscale that takes
            // minutes to answer.
            .connect_timeout(Duration::from_secs(4))
            .build()
            .map_err(|error| error.to_string())?;

        let response = client
            .get(format!("http://{address}{HELLO_ROUTE}"))
            .header(PASSPHRASE_HEADER, passphrase)
            .timeout(Duration::from_secs(6))
            .send()
            .await
            .map_err(|error| format!("cannot reach {address}: {}", cause(&error)))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("that is not the passphrase the other machine is sharing with".to_string());
        }
        if !response.status().is_success() {
            return Err(format!(
                "{address} answered HTTP {} — is Luma Vault sharing there?",
                response.status().as_u16()
            ));
        }
        let hello: Value = response.json().await.map_err(|_| {
            format!("something is answering on {address}, but it is not Luma Vault")
        })?;
        if hello.get("app").and_then(Value::as_str) != Some("luma-vault") {
            return Err(format!(
                "something is answering on {address}, but it is not Luma Vault"
            ));
        }

        Ok(Session {
            address: address.to_string(),
            passphrase: passphrase.to_string(),
            host: hello
                .get("host")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            folders: hello.get("folders").and_then(Value::as_i64).unwrap_or(0),
            items: hello.get("items").and_then(Value::as_i64).unwrap_or(0),
            client,
        })
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    /// Run one operation on the peer, by the name the frontend would have
    /// invoked locally.
    pub async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        // Per-request, because the client itself deliberately has no read
        // timeout — it also carries the upscale, which runs for minutes.
        //
        // Finite is the point. Without a limit here, a peer that accepts the
        // connection and then never answers leaves this future pending for
        // ever: the grid keeps its old rows, every later filter change queues
        // behind the same hang, and the window looks frozen with nothing in the
        // log. A limit turns all of that into one toast naming the machine.
        let limit = if SLOW_OPERATIONS.contains(&name) {
            SLOW_CALL_TIMEOUT
        } else {
            CALL_TIMEOUT
        };
        let response = self
            .client
            .post(format!("http://{}{RPC_ROUTE}", self.address))
            .header(PASSPHRASE_HEADER, &self.passphrase)
            .json(&json!({ "name": name, "args": args }))
            .timeout(limit)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    format!(
                        "{} did not answer {name} within {}s — it may be busy, or sharing may have stopped there",
                        self.address,
                        limit.as_secs()
                    )
                } else {
                    format!("{} is not answering: {}", self.address, cause(&error))
                }
            })?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("the other machine no longer accepts this passphrase".to_string());
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("{} answered something unreadable: {error}", self.address))?;

        // The peer reports a failed operation in the body, not in the status:
        // "that file is no longer in the library" is an answer, not a transport
        // error, and it has to reach the toast verbatim.
        if let Some(message) = body.get("error").and_then(Value::as_str) {
            return Err(message.to_string());
        }
        Ok(body.get("ok").cloned().unwrap_or(Value::Null))
    }

    /// Fetch one file, or a range of one.
    ///
    /// Returns a reply rather than a `Result` because the caller is the protocol
    /// handler, which must always answer something: a thumbnail that could not
    /// be fetched is a broken tile, never an exception that takes the grid down.
    pub async fn file(&self, path: &str, range: Option<&str>) -> FileReply {
        let encoded = utf8_percent_encode(path, NON_ALPHANUMERIC);
        let mut request = self
            .client
            .get(format!(
                "http://{}{FILE_ROUTE}?path={encoded}",
                self.address
            ))
            .header(PASSPHRASE_HEADER, &self.passphrase)
            // Generous but finite: a 4MB chunk over a LAN is milliseconds, and a
            // request that will never finish should free its worker.
            .timeout(Duration::from_secs(30));
        if let Some(range) = range {
            request = request.header("Range", range);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return FileReply::failure(504, &format!("cannot reach {}: {}", self.address, cause(&error)))
            }
        };

        let status = response.status().as_u16();
        let mime = header(&response, reqwest::header::CONTENT_TYPE)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let content_range = header(&response, reqwest::header::CONTENT_RANGE);

        match response.bytes().await {
            Ok(bytes) => FileReply {
                status,
                mime,
                bytes: bytes.to_vec(),
                content_range,
            },
            Err(error) => FileReply::failure(504, &format!("the transfer stopped: {error}")),
        }
    }
}

fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// The innermost reason, because reqwest's outer message is always the same
/// sentence about a request having failed.
fn cause(error: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = error;
    while let Some(next) = source.source() {
        source = next;
    }
    source.to_string()
}

// ---------------------------------------------------------------------------
// The host half
// ---------------------------------------------------------------------------

/// One operation, by name, run the way the IPC dispatcher would run it.
pub type RpcHandler = Arc<dyn Fn(String, Value) -> Result<Value, String> + Send + Sync>;
/// What this machine says about itself when asked.
pub type Greeting = Arc<dyn Fn() -> Value + Send + Sync>;
/// One static file of the built SPA, by its path relative to the bundle root
/// (`index.html`, `assets/index-CAxT2q.js`). A closure rather than the
/// `include_dir` type so tests can serve a bundle they made up.
pub type AssetLookup = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// Everything a shared library answers with. Assembled by `lib.rs`, the only
/// place holding the app handle the dispatcher needs.
pub struct Shared {
    /// The same allowlist the local protocol handler applies — a shared library
    /// serves exactly the files the webview beside it could see, and no others.
    pub roots: Arc<ProtocolRoots>,
    pub rpc: RpcHandler,
    pub greeting: Greeting,
    pub passphrase: String,
    /// The built SPA, for a browser with no desktop app — a phone.
    pub assets: AssetLookup,
}

/// What the workers actually hold: the configuration plus the one secret that
/// exists only while the server runs.
struct Live {
    shared: Shared,
    /// The session-cookie value. Minted fresh on every `start`, so it is not
    /// derivable from anything stored, and stopping the server — including the
    /// stop inside a passphrase change — ends every browser session at once.
    token: String,
}

/// 32 bytes from the OS CSPRNG, URL-safe. A guessable session cookie would be
/// a second, weaker passphrase; this one is not guessable and never persisted.
fn session_token() -> Result<String, String> {
    use base64::Engine;
    let mut buffer = [0_u8; 32];
    getrandom::fill(&mut buffer)
        .map_err(|error| format!("no system randomness for the session cookie: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer))
}

struct Running {
    server: Arc<tiny_http::Server>,
    workers: Vec<std::thread::JoinHandle<()>>,
}

/// Take the port, waiting a moment for it if it was only just given up.
///
/// A stopped server releases its listener on its own accept thread's schedule —
/// `Drop` wakes that thread and returns without waiting for it — so switching
/// sharing off, changing the passphrase and switching it back on can arrive
/// while the port is still held. Failing there would turn a working sequence
/// into "something else may already have that port", which is both wrong and
/// unactionable. A second of patience, then the honest error.
fn bind(port: u16) -> Result<tiny_http::Server, String> {
    let mut last = String::new();
    for attempt in 0..20 {
        match tiny_http::Server::http(("0.0.0.0", port)) {
            Ok(server) => return Ok(server),
            Err(error) => last = error.to_string(),
        }
        if attempt < 19 {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    Err(format!(
        "cannot listen on port {port} — something else may already have it: {last}"
    ))
}

/// The server, when this machine is answering for others.
pub struct Sharing {
    port: u16,
    running: Mutex<Option<Running>>,
}

impl Sharing {
    pub fn new(port: u16) -> Self {
        Sharing {
            port,
            running: Mutex::new(None),
        }
    }

    pub fn is_sharing(&self) -> bool {
        self.running.lock().is_ok_and(|slot| slot.is_some())
    }

    /// The port actually in use, which is only interesting when 0 was asked for.
    pub fn bound_port(&self) -> u16 {
        self.running
            .lock()
            .ok()
            .and_then(|slot| {
                slot.as_ref()
                    .and_then(|running| running.server.server_addr().to_ip())
                    .map(|addr| addr.port())
            })
            .unwrap_or(self.port)
    }

    pub fn start(&self, shared: Shared) -> Result<(), String> {
        let mut slot = self
            .running
            .lock()
            .map_err(|_| "the sharing state is wedged".to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        if shared.passphrase.trim().is_empty() {
            return Err("set a passphrase before sharing".to_string());
        }

        let live = Arc::new(Live {
            shared,
            token: session_token()?,
        });
        let server = Arc::new(bind(self.port)?);

        let workers = (0..WORKERS)
            .map(|_| {
                let server = Arc::clone(&server);
                let live = Arc::clone(&live);
                std::thread::spawn(move || {
                    // Ends when the server is unblocked, which is how `stop`
                    // collects these.
                    for request in server.incoming_requests() {
                        // A panic must not cost a worker. Unwinding out of this
                        // loop retires the thread for good, and there are only
                        // eight of them — so eight bad requests, or one
                        // poisoned lock hit eight times, leave a server that
                        // still *accepts* connections (the listener outlives
                        // its workers) and never answers one again. The peer
                        // then hangs on every call with nothing to show.
                        //
                        // Whatever went wrong belongs to that one request. The
                        // caller gets a 500 it can put in a toast, and the
                        // worker takes the next request.
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                            || answer(&live, request),
                        ));
                        if outcome.is_err() {
                            eprintln!("[luma] a remote request panicked; worker continuing");
                        }
                    }
                })
            })
            .collect();

        *slot = Some(Running { server, workers });
        Ok(())
    }

    pub fn stop(&self) {
        // The lock is released before the join, so nothing else can be waiting
        // on it while this waits on the workers.
        let taken = self.running.lock().ok().and_then(|mut slot| slot.take());
        let Some(Running { server, workers }) = taken else {
            return;
        };
        let port = server.server_addr().to_ip().map(|addr| addr.port());

        // Once per worker, and that is not belt-and-braces: `unblock` pushes a
        // single marker onto the request queue and wakes exactly one waiter, so
        // seven of eight threads would sit in `recv` forever — and the join
        // below would wait with them.
        for _ in 0..workers.len() {
            server.unblock();
        }
        // And then wait for them. Each holds a reference to the listener, so the
        // port stays bound until the last one has left. Bounded by whatever
        // request is in flight, which the protocol caps at one 4MB chunk.
        for worker in workers {
            let _ = worker.join();
        }

        // Dropping the last reference is what tells tiny_http to shut down.
        drop(server);

        // And this is what makes it actually happen. Its accept thread is
        // parked in `accept()`, and `Drop` wakes it by connecting to the
        // listener's own local address — which for a wildcard bind is
        // `0.0.0.0`, an address Windows refuses to connect to. So the thread
        // never notices the shutdown flag, never lets go of the listener, and
        // the port stays taken until the app exits: sharing could be switched
        // off but never on again. One knock on the loopback side of the same
        // listener is enough for it to come round and see it is done.
        if let Some(port) = port {
            if let Ok(stream) = std::net::TcpStream::connect(("127.0.0.1", port)) {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
    }
}

/// The `luma_session` cookie's value, if the request carries one.
fn cookie_token(request: &tiny_http::Request) -> Option<String> {
    let header = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Cookie"))?;
    header.value.as_str().split(';').find_map(|pair| {
        let (name, value) = pair.trim().split_once('=')?;
        (name == SESSION_COOKIE).then(|| value.to_string())
    })
}

/// `SameSite=Strict` is the CSRF story: the API changes state on bare POSTs,
/// and Strict means no other origin can make the browser attach this cookie —
/// not even on a top-level navigation. The SPA itself never navigates
/// cross-site into an API route, so Strict costs nothing here. `HttpOnly`
/// because the page has no reason to read it — `fetch` sends it on its own.
fn session_cookie(token: &str) -> String {
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000")
}

fn expired_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

fn answer(live: &Live, mut request: tiny_http::Request) {
    let shared = &live.shared;
    let peer = request.remote_addr().map(|addr| addr.ip());
    if !peer.is_some_and(is_lan) {
        // Terse and identical to the unauthorized reply's shape: an endpoint
        // that explains itself to a stranger is an endpoint that helps them.
        respond(request, FileReply::failure(403, "not a local address"), CACHE_NONE);
        return;
    }

    let url = request.url().to_string();
    let route = url.split('?').next().unwrap_or_default().to_string();
    let method = request.method().clone();

    // Anything outside the API namespace is the SPA — served without a
    // credential, because it is the login page among other things, and it
    // carries no library data. GET only; the app shell has no other verb.
    if !route.starts_with(API_PREFIX) {
        if method != tiny_http::Method::Get {
            respond(request, FileReply::failure(404, "no such route"), CACHE_NONE);
            return;
        }
        let (reply, cache) = serve_asset(shared, &route);
        respond(request, reply, cache);
        return;
    }

    // Trading the passphrase for a cookie is the one API operation that is
    // reachable without either.
    if route == LOGIN_ROUTE && method == tiny_http::Method::Post {
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            respond(request, json_reply(400, json!({ "error": "unreadable request" })), CACHE_NONE);
            return;
        }
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let offered = parsed
            .get("passphrase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !same_passphrase(offered, &shared.passphrase) {
            respond(request, FileReply::failure(401, "wrong passphrase"), CACHE_NONE);
            return;
        }
        // The greeting in the body, so one round trip both authenticates and
        // tells the page whose library it is now looking at.
        respond_with(
            request,
            json_reply(200, (shared.greeting)()),
            CACHE_NONE,
            Some(session_cookie(&live.token)),
        );
        return;
    }
    if route == LOGOUT_ROUTE && method == tiny_http::Method::Post {
        // No auth check: expiring a cookie the caller does not hold is a no-op,
        // and a logout that can fail with 401 is a logout that cannot be
        // trusted to always work.
        respond_with(request, json_reply(200, json!({})), CACHE_NONE, Some(expired_cookie()));
        return;
    }

    // Everything else in the API needs a credential: the passphrase header the
    // desktop client sends, or the cookie a browser login earned. Both go
    // through the digest comparison — the token is not secret-shaped enough to
    // deserve a timing oracle either.
    let offered = request
        .headers()
        .iter()
        .find(|header| header.field.equiv(PASSPHRASE_HEADER))
        .map(|header| header.value.as_str().to_string())
        .unwrap_or_default();
    let authorized = same_passphrase(&offered, &shared.passphrase)
        || cookie_token(&request).is_some_and(|token| same_passphrase(&token, &live.token));
    if !authorized {
        respond(request, FileReply::failure(401, "wrong passphrase"), CACHE_NONE);
        return;
    }

    match (&method, route.as_str()) {
        (tiny_http::Method::Get, HELLO_ROUTE) => {
            respond(request, json_reply(200, (shared.greeting)()), CACHE_NONE);
        }
        (tiny_http::Method::Post, RPC_ROUTE) => {
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                respond(request, json_reply(400, json!({ "error": "unreadable request" })), CACHE_NONE);
                return;
            }
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let name = parsed
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                respond(request, json_reply(400, json!({ "error": "no operation named" })), CACHE_NONE);
                return;
            }
            let args = parsed.get("args").cloned().unwrap_or(Value::Null);
            // 200 either way: a refused operation is an answer, and the message
            // belongs in the body where the caller's toast can show it.
            let reply = match (shared.rpc)(name, args) {
                Ok(value) => json!({ "ok": value }),
                Err(message) => json!({ "error": message }),
            };
            respond(request, json_reply(200, reply), CACHE_NONE);
        }
        (tiny_http::Method::Get, FILE_ROUTE) => {
            let Some(path) = extract_path(&url) else {
                respond(request, FileReply::failure(400, "missing ?path= parameter"), CACHE_NONE);
                return;
            };
            let range = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Range"))
                .map(|header| header.value.as_str().to_string());
            let reply = crate::protocol::serve(&shared.roots, &path, range.as_deref());
            // Immutable is safe here for the same reason it is on `luma://`:
            // content-addressed derived files, and the watcher drops the row
            // when a source changes.
            respond(request, reply, CACHE_IMMUTABLE);
        }
        _ => respond(request, FileReply::failure(404, "no such route"), CACHE_NONE),
    }
}

/// The MIME types Vite actually emits, plus the PWA odds and ends.
fn asset_mime(name: &str) -> &'static str {
    match name.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webmanifest") => "application/manifest+json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// One file of the SPA, and how long a browser may keep it.
fn serve_asset(shared: &Shared, route: &str) -> (FileReply, &'static str) {
    let name = route.trim_start_matches('/');
    // The embedded bundle is looked up by relative key, so `..` cannot match
    // anything — but refusing it outright costs one line and no thought.
    if name.contains("..") {
        return (FileReply::failure(404, "not found"), CACHE_NONE);
    }
    let name = if name.is_empty() { "index.html" } else { name };

    let (name, bytes) = match (shared.assets)(name) {
        Some(bytes) => (name, bytes),
        // No extension means it was a page path, not a file: hand back the
        // shell and let the SPA make sense of it. A missing *file* stays 404 —
        // an <img> that gets HTML instead renders a broken tile with no clue.
        None if !name.contains('.') => match (shared.assets)("index.html") {
            Some(bytes) => ("index.html", bytes),
            None => return (unbuilt_notice(), CACHE_NONE),
        },
        None if name == "index.html" => return (unbuilt_notice(), CACHE_NONE),
        None => return (FileReply::failure(404, "not found"), CACHE_NONE),
    };

    let reply = FileReply {
        status: 200,
        mime: asset_mime(name).to_string(),
        bytes,
        content_range: None,
    };
    // Vite hashes everything under assets/, so those are immutable by
    // construction. The shell is what changes between builds — a year-long
    // cache on it would pin a phone to a stale app.
    let cache = if name.starts_with("assets/") {
        CACHE_IMMUTABLE
    } else {
        CACHE_NONE
    };
    (reply, cache)
}

/// What a browser sees when the host has never built the web app — a dev
/// machine running `cargo` alone. Plain text on purpose: this is a message for
/// the person at the other machine, not a page.
fn unbuilt_notice() -> FileReply {
    FileReply::failure(
        503,
        "the web app is not built into this host — run `pnpm --filter @luma/web build` \
         there and restart it",
    )
}

fn json_reply(status: u16, body: Value) -> FileReply {
    FileReply {
        status,
        mime: "application/json".to_string(),
        bytes: serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec()),
        content_range: None,
    }
}

fn respond(request: tiny_http::Request, reply: FileReply, cache_control: &str) {
    respond_with(request, reply, cache_control, None);
}

fn respond_with(
    request: tiny_http::Request,
    reply: FileReply,
    cache_control: &str,
    set_cookie: Option<String>,
) {
    let is_html = reply.mime.starts_with("text/html");
    let mut response = tiny_http::Response::from_data(reply.bytes)
        .with_status_code(tiny_http::StatusCode(reply.status));
    for (name, value) in [
        ("Content-Type", reply.mime.as_str()),
        // Advertised for the same reason the local handler advertises it: it is
        // what tells a <video> it may seek instead of re-reading from zero.
        ("Accept-Ranges", "bytes"),
        ("Cache-Control", cache_control),
    ] {
        if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(header);
        }
    }
    // Only pages get the CSP — it means nothing on JSON or JPEG bytes, and
    // pinning it to the mime keeps the policy impossible to forget on a new
    // HTML route.
    if is_html {
        if let Ok(header) =
            tiny_http::Header::from_bytes(b"Content-Security-Policy".as_slice(), STATIC_CSP.as_bytes())
        {
            response.add_header(header);
        }
    }
    if let Some(cookie) = set_cookie {
        if let Ok(header) = tiny_http::Header::from_bytes(b"Set-Cookie".as_slice(), cookie.as_bytes()) {
            response.add_header(header);
        }
    }
    if let Some(range) = reply.content_range {
        if let Ok(header) = tiny_http::Header::from_bytes(b"Content-Range".as_slice(), range.as_bytes()) {
            response.add_header(header);
        }
    }
    // A client that hung up mid-transfer is not an error worth reporting: the
    // grid does that every time somebody scrolls past a tile.
    let _ = request.respond(response);
}

// ---------------------------------------------------------------------------
// The state both halves live in
// ---------------------------------------------------------------------------

pub struct RemoteState {
    session: RwLock<Option<Arc<Session>>>,
    pub sharing: Sharing,
}

impl RemoteState {
    pub fn new(port: u16) -> Self {
        RemoteState {
            session: RwLock::new(None),
            sharing: Sharing::new(port),
        }
    }

    /// The live session, if there is one. Cloned out rather than borrowed so
    /// nothing holds the lock across an await.
    pub fn session(&self) -> Option<Arc<Session>> {
        self.session.read().ok().and_then(|slot| slot.clone())
    }

    pub fn set_session(&self, session: Option<Arc<Session>>) {
        if let Ok(mut slot) = self.session.write() {
            *slot = session;
        }
    }

    pub fn status(&self, last_address: Option<String>) -> RemoteStatus {
        let session = self.session();
        RemoteStatus {
            connected: session.is_some(),
            address: session
                .as_ref()
                .map(|session| session.address.clone())
                .unwrap_or_default(),
            host: session
                .as_ref()
                .map(|session| session.host.clone())
                .unwrap_or_default(),
            folders: session.as_ref().map(|session| session.folders).unwrap_or(0),
            items: session.as_ref().map(|session| session.items).unwrap_or(0),
            last_address: last_address.unwrap_or_default(),
            has_passphrase: stored_client_passphrase().is_some(),
        }
    }

    pub fn share_status(&self) -> ShareStatus {
        ShareStatus {
            sharing: self.is_sharing(),
            port: self.sharing.bound_port(),
            addresses: local_addresses(self.sharing.bound_port()),
            has_passphrase: stored_host_passphrase().is_some(),
        }
    }

    pub fn is_sharing(&self) -> bool {
        self.sharing.is_sharing()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    #[test]
    fn an_address_is_accepted_in_every_shape_somebody_types_it() {
        assert_eq!(parse_address("192.168.1.42").unwrap(), "192.168.1.42:7870");
        assert_eq!(parse_address(" 192.168.1.42 ").unwrap(), "192.168.1.42:7870");
        assert_eq!(parse_address("192.168.1.42:9000").unwrap(), "192.168.1.42:9000");
        // Pasted out of a browser, which is what somebody who just read the
        // address off the other machine's dialog is likely to do.
        assert_eq!(
            parse_address("http://192.168.1.42:7870/").unwrap(),
            "192.168.1.42:7870"
        );
        assert_eq!(parse_address("10.0.0.5").unwrap(), "10.0.0.5:7870");
        assert_eq!(parse_address("172.16.4.1").unwrap(), "172.16.4.1:7870");
        assert_eq!(parse_address("127.0.0.1:7870").unwrap(), "127.0.0.1:7870");
    }

    #[test]
    fn a_public_address_is_refused_at_the_client_end() {
        // The rule is not "warn": a library must not be reachable off the LAN
        // by typing a number into a box.
        assert!(parse_address("8.8.8.8").is_err());
        assert!(parse_address("203.0.113.7:7870").is_err());
        assert!(parse_address("172.32.0.1").is_err(), "just outside 172.16/12");
    }

    #[test]
    fn garbage_is_refused_with_something_a_person_can_act_on() {
        assert!(parse_address("").is_err());
        assert!(parse_address("desktop-abc").is_err(), "hostnames are not resolved");
        let message = parse_address("192.168.1.42:nope").unwrap_err();
        assert!(message.contains("port"), "got: {message}");
    }

    #[test]
    fn the_private_ranges_are_the_ones_a_home_network_uses() {
        for address in ["192.168.0.1", "10.1.2.3", "172.20.0.9", "127.0.0.1", "169.254.1.1"] {
            assert!(is_lan(address.parse().unwrap()), "{address} should be local");
        }
        for address in ["1.1.1.1", "8.8.4.4", "172.15.0.1", "192.169.0.1"] {
            assert!(!is_lan(address.parse().unwrap()), "{address} should not be");
        }
        // A dual-stack listener sees an IPv4 peer in this form.
        assert!(is_lan("::ffff:192.168.1.5".parse().unwrap()));
        assert!(!is_lan("::ffff:8.8.8.8".parse().unwrap()));
        assert!(is_lan("fe80::1".parse().unwrap()));
        assert!(is_lan("fd00::1".parse().unwrap()));
        assert!(!is_lan("2606:4700::1111".parse().unwrap()));
    }

    #[test]
    fn an_empty_passphrase_authorizes_nothing() {
        assert!(same_passphrase("hunter2", "hunter2"));
        assert!(!same_passphrase("hunter2", "hunter3"));
        // Both empty is the case that matters: it would make an unprotected
        // port indistinguishable from a protected one.
        assert!(!same_passphrase("", ""));
        assert!(!same_passphrase("anything", ""));
    }

    /// Minimal HTTP/1.1 by hand, so the server is exercised over a real socket
    /// rather than through a mock of one. `Connection: close` means the reply
    /// ends at EOF and there is no chunk framing to parse. Returns the whole
    /// response text — status line, headers, body — because the cookie tests
    /// read headers.
    fn request_raw(
        port: u16,
        method: &str,
        route: &str,
        extra_headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let mut head = format!(
            "{method} {route} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n"
        );
        for (name, value) in extra_headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(body) = body {
            head.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ));
        }
        head.push_str("\r\n");
        if let Some(body) = body {
            head.push_str(body);
        }
        stream.write_all(head.as_bytes()).expect("write");
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("read");
        String::from_utf8_lossy(&raw).to_string()
    }

    fn split_response(text: &str) -> (u16, String) {
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();
        (status, body)
    }

    fn request(port: u16, method: &str, route: &str, passphrase: &str, body: Option<&str>) -> (u16, String) {
        let headers: &[(&str, &str)] = if passphrase.is_empty() {
            &[]
        } else {
            &[("X-Luma-Passphrase", passphrase)]
        };
        split_response(&request_raw(port, method, route, headers, body))
    }

    /// The `luma_session=…` value out of a login response's `Set-Cookie`.
    fn cookie_from(text: &str) -> Option<String> {
        text.lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .and_then(|line| line.split_once(':'))
            .and_then(|(_, value)| value.trim().split(';').next().map(str::to_string))
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        sharing: Sharing,
        port: u16,
        watched: std::path::PathBuf,
    }

    fn shared_library(passphrase: &str) -> Fixture {
        // Port 0: the OS picks a free one, so a test run cannot collide with a
        // real shared library or with another test.
        shared_library_on(0, passphrase)
    }

    fn shared_library_on(port: u16, passphrase: &str) -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let watched = dir.path().join("watched");
        std::fs::create_dir_all(&watched).unwrap();
        std::fs::write(watched.join("a.jpg"), b"picture bytes").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"not yours").unwrap();

        let db = Arc::new(crate::db::Db::open(&dir.path().join("index.db")).expect("db"));
        db.add_folder(&watched.canonicalize().unwrap().to_string_lossy(), 0)
            .expect("folder");

        let roots = Arc::new(ProtocolRoots {
            db,
            thumb_root: dir.path().join("thumbs"),
            frame_root: dir.path().join("frames"),
        });

        let sharing = Sharing::new(port);
        sharing
            .start(Shared {
                roots,
                rpc: Arc::new(|name, args| {
                    if name == "boom" {
                        return Err("that file is no longer in the library".to_string());
                    }
                    // Stands in for the real thing: a poisoned index mutex,
                    // which panics every caller that touches it from then on.
                    if name == "panic" {
                        panic!("index mutex poisoned");
                    }
                    Ok(json!({ "ran": name, "args": args }))
                }),
                greeting: Arc::new(|| json!({ "app": "luma-vault", "host": "TESTBOX", "folders": 1, "items": 7 })),
                passphrase: passphrase.to_string(),
                // A bundle small enough to assert on, shaped like Vite's output.
                assets: Arc::new(|name| match name {
                    "index.html" => Some(b"<html>app shell</html>".to_vec()),
                    "assets/index-CAxT2q.js" => Some(b"js bytes".to_vec()),
                    _ => None,
                }),
            })
            .expect("start");
        let port = sharing.bound_port();
        Fixture {
            _dir: dir,
            sharing,
            port,
            watched,
        }
    }

    #[test]
    fn a_shared_library_greets_dispatches_and_serves_files() {
        let fixture = shared_library("open sesame");

        let (status, body) = request(fixture.port, "GET", HELLO_ROUTE, "open sesame", None);
        assert_eq!(status, 200);
        assert!(body.contains("\"host\":\"TESTBOX\""), "got: {body}");

        let (status, body) = request(
            fixture.port,
            "POST",
            RPC_ROUTE,
            "open sesame",
            Some(r#"{"name":"query_media","args":{"limit":3}}"#),
        );
        assert_eq!(status, 200);
        assert!(body.contains("\"ran\":\"query_media\""), "got: {body}");

        // A refused operation comes back as a message in the body, not as a
        // transport failure — the toast has to be able to show what it said.
        let (status, body) = request(
            fixture.port,
            "POST",
            RPC_ROUTE,
            "open sesame",
            Some(r#"{"name":"boom","args":{}}"#),
        );
        assert_eq!(status, 200);
        assert!(body.contains("no longer in the library"), "got: {body}");

        let allowed = fixture.watched.join("a.jpg");
        let route = format!(
            "{FILE_ROUTE}?path={}",
            utf8_percent_encode(&allowed.to_string_lossy(), NON_ALPHANUMERIC)
        );
        let (status, body) = request(fixture.port, "GET", &route, "open sesame", None);
        assert_eq!(status, 200);
        assert_eq!(body, "picture bytes");

        fixture.sharing.stop();
        assert!(!fixture.sharing.is_sharing());
    }

    #[test]
    fn a_panicking_request_costs_one_answer_and_not_the_server() {
        // The reported failure, from the other end of it: the grid on the
        // browsing machine stops updating and every filter change after it does
        // nothing, with no error anywhere.
        //
        // The cause is here. There are eight workers, each parked in the accept
        // loop; a panic used to unwind straight out of that loop and retire the
        // thread. The listener lives in `Running`, not in the workers, so it
        // stays bound after the last one has gone — connections are still
        // accepted, and then nothing answers them. A client with no read
        // timeout waits for ever, which is exactly what a frozen grid is.
        //
        // Expect panic output on stderr while this runs. It is the point.
        let fixture = shared_library("open sesame");
        let boom = r#"{"name":"panic","args":{}}"#;
        let fine = r#"{"name":"query_media","args":{"limit":3}}"#;

        // More panics than there are workers. Under the old behaviour this
        // retires every one of them and the assertion below never returns.
        for _ in 0..WORKERS * 2 {
            let (status, _) = request(fixture.port, "POST", RPC_ROUTE, "open sesame", Some(boom));
            // tiny_http answers 500 for a request dropped without a response,
            // so the caller is told rather than left waiting.
            assert_eq!(status, 500, "a panicking request still owes an answer");
        }

        let (status, body) = request(fixture.port, "POST", RPC_ROUTE, "open sesame", Some(fine));
        assert_eq!(status, 200, "the server is still serving");
        assert!(body.contains("\"ran\":\"query_media\""), "got: {body}");

        fixture.sharing.stop();
    }

    #[test]
    fn the_wire_enforces_the_passphrase_and_the_allowlist() {
        let fixture = shared_library("open sesame");

        // No passphrase, and a wrong one, before anything else is looked at.
        let (status, _) = request(fixture.port, "GET", HELLO_ROUTE, "", None);
        assert_eq!(status, 401);
        let (status, _) = request(fixture.port, "GET", HELLO_ROUTE, "guess", None);
        assert_eq!(status, 401);
        // Including on the file route, which is the one that carries the pixels.
        let route = format!(
            "{FILE_ROUTE}?path={}",
            utf8_percent_encode(&fixture.watched.join("a.jpg").to_string_lossy(), NON_ALPHANUMERIC)
        );
        let (status, _) = request(fixture.port, "GET", &route, "guess", None);
        assert_eq!(status, 401);

        // The right passphrase does not widen the allowlist: a file outside
        // every watched folder is refused exactly as it is locally.
        let outside = fixture.watched.parent().unwrap().join("secret.txt");
        let route = format!(
            "{FILE_ROUTE}?path={}",
            utf8_percent_encode(&outside.to_string_lossy(), NON_ALPHANUMERIC)
        );
        let (status, body) = request(fixture.port, "GET", &route, "open sesame", None);
        assert_eq!(status, 403, "got: {body}");

        // An unknown *API* route is a 404; an unknown page path is the SPA
        // shell, which is what makes a deep link on a phone land in the app.
        let (status, _) = request(fixture.port, "GET", "/luma/v1/nope", "open sesame", None);
        assert_eq!(status, 404);

        fixture.sharing.stop();
    }

    #[test]
    fn the_spa_and_its_login_are_reachable_without_a_credential_and_nothing_else_is() {
        let fixture = shared_library("open sesame");

        // The shell, an asset, and a page path — all without any credential,
        // because the login page has to load before anyone can log in.
        let (status, body) = request(fixture.port, "GET", "/", "", None);
        assert_eq!(status, 200);
        assert_eq!(body, "<html>app shell</html>");
        let (status, body) = request(fixture.port, "GET", "/assets/index-CAxT2q.js", "", None);
        assert_eq!(status, 200);
        assert_eq!(body, "js bytes");
        let (status, body) = request(fixture.port, "GET", "/some/page", "", None);
        assert_eq!(status, 200, "a page path falls back to the shell");
        assert_eq!(body, "<html>app shell</html>");

        // A missing *file* is a 404, not the shell — an <img> handed HTML
        // renders a broken tile with nothing to debug from.
        let (status, _) = request(fixture.port, "GET", "/missing.png", "", None);
        assert_eq!(status, 404);

        // And the data stays behind the credential wall.
        let (status, _) = request(fixture.port, "GET", HELLO_ROUTE, "", None);
        assert_eq!(status, 401);

        // The shell page carries the CSP; the API's JSON does not need it.
        let raw = request_raw(fixture.port, "GET", "/", &[], None);
        assert!(
            raw.contains("Content-Security-Policy:"),
            "the served page must be pinned to 'self': {raw}"
        );
        assert!(raw.contains("Cache-Control: no-store"), "the shell must not be pinned to a build");
        let raw = request_raw(fixture.port, "GET", "/assets/index-CAxT2q.js", &[], None);
        assert!(
            raw.contains("Cache-Control: public, max-age=31536000, immutable"),
            "hashed assets are immutable by construction: {raw}"
        );

        fixture.sharing.stop();
    }

    #[test]
    fn logging_in_trades_the_passphrase_for_a_cookie_the_api_accepts() {
        let fixture = shared_library("open sesame");

        // The wrong passphrase earns nothing — and no cookie.
        let raw = request_raw(
            fixture.port,
            "POST",
            LOGIN_ROUTE,
            &[],
            Some(r#"{"passphrase":"guess"}"#),
        );
        let (status, _) = split_response(&raw);
        assert_eq!(status, 401);
        assert!(cookie_from(&raw).is_none(), "a refusal must not set a cookie: {raw}");

        // The right one answers with the greeting and the session cookie.
        let raw = request_raw(
            fixture.port,
            "POST",
            LOGIN_ROUTE,
            &[],
            Some(r#"{"passphrase":"open sesame"}"#),
        );
        let (status, body) = split_response(&raw);
        assert_eq!(status, 200);
        assert!(body.contains("\"host\":\"TESTBOX\""), "login should greet: {body}");
        let set_cookie = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .expect("login sets the session cookie")
            .to_string();
        assert!(set_cookie.contains("HttpOnly"), "got: {set_cookie}");
        assert!(set_cookie.contains("SameSite=Strict"), "got: {set_cookie}");
        let cookie = cookie_from(&raw).expect("cookie value");

        // The cookie now carries hello, rpc and the file route — the three
        // things the phone's page, fetches and <img> tags actually send.
        let (status, body) = split_response(&request_raw(
            fixture.port,
            "GET",
            HELLO_ROUTE,
            &[("Cookie", &cookie)],
            None,
        ));
        assert_eq!(status, 200);
        assert!(body.contains("\"host\":\"TESTBOX\""), "got: {body}");

        let (status, body) = split_response(&request_raw(
            fixture.port,
            "POST",
            RPC_ROUTE,
            &[("Cookie", &cookie)],
            Some(r#"{"name":"query_media","args":{"limit":3}}"#),
        ));
        assert_eq!(status, 200);
        assert!(body.contains("\"ran\":\"query_media\""), "got: {body}");

        let allowed = fixture.watched.join("a.jpg");
        let route = format!(
            "{FILE_ROUTE}?path={}",
            utf8_percent_encode(&allowed.to_string_lossy(), NON_ALPHANUMERIC)
        );
        let (status, body) = split_response(&request_raw(
            fixture.port,
            "GET",
            &route,
            &[("Cookie", &cookie)],
            None,
        ));
        assert_eq!(status, 200);
        assert_eq!(body, "picture bytes");

        // A made-up cookie is not a credential.
        let (status, _) = split_response(&request_raw(
            fixture.port,
            "GET",
            HELLO_ROUTE,
            &[("Cookie", "luma_session=forged")],
            None,
        ));
        assert_eq!(status, 401);

        fixture.sharing.stop();
    }

    #[test]
    fn a_cookie_dies_with_the_server_that_minted_it() {
        // The sequence is a passphrase change: stop, start again, same port.
        // If the token were derived from anything stored, the old cookie would
        // come back to life here — and so would every browser session that was
        // ever handed one.
        let first = shared_library("open sesame");
        let port = first.port;
        let raw = request_raw(port, "POST", LOGIN_ROUTE, &[], Some(r#"{"passphrase":"open sesame"}"#));
        let cookie = cookie_from(&raw).expect("cookie");
        first.sharing.stop();

        let second = shared_library_on(port, "open sesame");
        let (status, _) = split_response(&request_raw(
            port,
            "GET",
            HELLO_ROUTE,
            &[("Cookie", &cookie)],
            None,
        ));
        assert_eq!(status, 401, "an old session must not survive a restart");
        second.sharing.stop();
    }

    #[test]
    fn sharing_can_be_stopped_and_started_again_on_the_same_port() {
        let first = shared_library("open sesame");
        let port = first.port;
        assert!(first.sharing.is_sharing());
        first.sharing.stop();
        assert!(!first.sharing.is_sharing());

        // Immediately, on the same port. This is the sequence somebody changing
        // the passphrase performs, and it is the one that catches both halves of
        // shutting down: a worker still sitting in `recv` holds the listener, and
        // even a clean drop hands the port back a moment later than it returns.
        let second = shared_library_on(port, "open sesame");
        assert!(second.sharing.is_sharing());
        assert_eq!(second.sharing.bound_port(), port, "it must be the same port");
        second.sharing.stop();
    }
}
