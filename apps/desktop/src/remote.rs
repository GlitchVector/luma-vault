//! Remote mode — one machine browsing another's library over the LAN.
//!
//! Both ends live here, because they are two ends of one wire and describing
//! the protocol twice is how the two halves drift apart.
//!
//! ```text
//! client (Session)                        host (Sharing)
//!   invoke ─▶ remote_call ──POST /rpc──▶  api::dispatch, against the host index
//!   luma://?path=… ────────GET /file──▶   protocol::serve, host's allowlist
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
//! # What protects the port
//!
//! - Sharing is off until somebody turns it on, on that machine.
//! - Turning it on requires a passphrase, and **every** request carries it —
//!   the file route as much as the RPC one.
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

/// How many requests the shared library answers at once.
///
/// A grid scrolling through a large folder issues dozens of thumbnail requests
/// in a burst, and Chromium holds about six connections per origin — so eight
/// threads covers a saturated client with one to spare for the RPC that is
/// waiting behind them. They are threads rather than tasks because everything
/// they do is blocking: a SQLite query and a file read.
const WORKERS: usize = 8;

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
        let response = self
            .client
            .post(format!("http://{}{RPC_ROUTE}", self.address))
            .header(PASSPHRASE_HEADER, &self.passphrase)
            .json(&json!({ "name": name, "args": args }))
            .send()
            .await
            .map_err(|error| format!("{} is not answering: {}", self.address, cause(&error)))?;

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

/// Everything a shared library answers with. Assembled by `lib.rs`, the only
/// place holding the app handle the dispatcher needs.
pub struct Shared {
    /// The same allowlist the local protocol handler applies — a shared library
    /// serves exactly the files the webview beside it could see, and no others.
    pub roots: Arc<ProtocolRoots>,
    pub rpc: RpcHandler,
    pub greeting: Greeting,
    pub passphrase: String,
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

        let server = Arc::new(bind(self.port)?);
        let shared = Arc::new(shared);

        let workers = (0..WORKERS)
            .map(|_| {
                let server = Arc::clone(&server);
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || {
                    // Ends when the server is unblocked, which is how `stop`
                    // collects these.
                    for request in server.incoming_requests() {
                        answer(&shared, request);
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

fn answer(shared: &Shared, mut request: tiny_http::Request) {
    let peer = request.remote_addr().map(|addr| addr.ip());
    if !peer.is_some_and(is_lan) {
        // Terse and identical to the unauthorized reply's shape: an endpoint
        // that explains itself to a stranger is an endpoint that helps them.
        respond(request, FileReply::failure(403, "not a local address"));
        return;
    }

    let offered = request
        .headers()
        .iter()
        .find(|header| header.field.equiv(PASSPHRASE_HEADER))
        .map(|header| header.value.as_str().to_string())
        .unwrap_or_default();
    if !same_passphrase(&offered, &shared.passphrase) {
        respond(request, FileReply::failure(401, "wrong passphrase"));
        return;
    }

    let url = request.url().to_string();
    let route = url.split('?').next().unwrap_or_default().to_string();
    let method = request.method().clone();

    match (&method, route.as_str()) {
        (tiny_http::Method::Get, HELLO_ROUTE) => {
            respond(request, json_reply(200, (shared.greeting)()));
        }
        (tiny_http::Method::Post, RPC_ROUTE) => {
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                respond(request, json_reply(400, json!({ "error": "unreadable request" })));
                return;
            }
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let name = parsed
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                respond(request, json_reply(400, json!({ "error": "no operation named" })));
                return;
            }
            let args = parsed.get("args").cloned().unwrap_or(Value::Null);
            // 200 either way: a refused operation is an answer, and the message
            // belongs in the body where the caller's toast can show it.
            let reply = match (shared.rpc)(name, args) {
                Ok(value) => json!({ "ok": value }),
                Err(message) => json!({ "error": message }),
            };
            respond(request, json_reply(200, reply));
        }
        (tiny_http::Method::Get, FILE_ROUTE) => {
            let Some(path) = extract_path(&url) else {
                respond(request, FileReply::failure(400, "missing ?path= parameter"));
                return;
            };
            let range = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Range"))
                .map(|header| header.value.as_str().to_string());
            let reply = crate::protocol::serve(&shared.roots, &path, range.as_deref());
            respond(request, reply);
        }
        _ => respond(request, FileReply::failure(404, "no such route")),
    }
}

fn json_reply(status: u16, body: Value) -> FileReply {
    FileReply {
        status,
        mime: "application/json".to_string(),
        bytes: serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec()),
        content_range: None,
    }
}

fn respond(request: tiny_http::Request, reply: FileReply) {
    let mut response = tiny_http::Response::from_data(reply.bytes)
        .with_status_code(tiny_http::StatusCode(reply.status));
    for (name, value) in [
        ("Content-Type", reply.mime.as_str()),
        // Advertised for the same reason the local handler advertises it: it is
        // what tells a <video> it may seek instead of re-reading from zero.
        ("Accept-Ranges", "bytes"),
        ("Cache-Control", "public, max-age=31536000, immutable"),
    ] {
        if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
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
    /// ends at EOF and there is no chunk framing to parse.
    fn request(port: u16, method: &str, route: &str, passphrase: &str, body: Option<&str>) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let mut head = format!(
            "{method} {route} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n"
        );
        if !passphrase.is_empty() {
            head.push_str(&format!("X-Luma-Passphrase: {passphrase}\r\n"));
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
        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();
        (status, body)
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
                    Ok(json!({ "ran": name, "args": args }))
                }),
                greeting: Arc::new(|| json!({ "app": "luma-vault", "host": "TESTBOX", "folders": 1, "items": 7 })),
                passphrase: passphrase.to_string(),
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

        let (status, _) = request(fixture.port, "GET", "/nope", "open sesame", None);
        assert_eq!(status, 404);

        fixture.sharing.stop();
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
