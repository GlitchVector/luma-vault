//! Chat: a conversation with the `claude` CLI, run the way Diorama runs it.
//!
//! Every turn is a fresh `claude -p` process that exits when the reply is
//! complete. The conversation survives between turns inside the CLI's own
//! transcript, keyed by a session id this app makes up and hands over as
//! `--session-id` on the first turn and `--resume` on every later one. That
//! is what makes cancel a plain kill, and what lets this app restart — a Rust
//! edit under `tauri dev` does that — without losing a conversation.
//!
//! The CLI's `stream-json` output is read line by line into a short feed of
//! events: what the person said, what the model said, which tools it called,
//! and how the turn ended. Events are numbered and kept in memory like the
//! comic runner's, so the panel polls with the sequence number it has — the
//! same code path for the window and for a browser on the LAN.
//!
//! Turns run in the repository, so the CLI reads this project's own notes and
//! skills and can act on the vault the same way it does from a terminal.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::types::{ChatEvent, ChatFeed, ChatIndex, ChatSessionInfo};

/// The CLI binary, if it is anywhere this app can run it.
///
/// PATH first, then `~/.local/bin`, which is where Claude Code installs
/// itself and which a Finder- or shortcut-launched app does not always
/// inherit. Resolved once at startup: a person who installs the CLI while the
/// app is open restarts it, which the page says.
pub fn resolve() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd", "claude"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs.into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Where conversations are kept. Under app data, never beside media.
pub fn chats_root(data_dir: &Path) -> PathBuf {
    data_dir.join("chats")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A version-4 UUID, which is the shape the CLI accepts for `--session-id`.
fn new_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| anyhow::anyhow!("no system randomness: {error}"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let hex = hex.concat();
    Ok(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

/// A session id is a file name this module builds a path from, so it is
/// checked against the shape `new_id` makes rather than escaped.
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id
            .chars()
            .enumerate()
            .all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() && !c.is_ascii_uppercase() })
}

/// The first message, cut to a list entry.
pub fn title_of(message: &str) -> String {
    let line = message.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    if title.is_empty() {
        "(empty)".to_string()
    } else {
        title
    }
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/// What the first turn carries ahead of the message. Prepended to the
/// prompt rather than passed as a system prompt, because the session
/// transcript carries a prepended block into every later turn just as well,
/// and a system prompt would have to be repeated on every resume.
const PREAMBLE: &str = "<luma-vault-context>
You are running inside Luma Vault's Chat page — a desktop app for a local media \
library of generated pictures, with its own repository as your working directory. \
The person typed the message below into a narrow chat panel. Answer it, or make \
the change directly, whichever it asks for.

- The repository's CLAUDE.md and .ai/ notes apply; read them before changing code.
- There is nobody to ask, and a question would hang the turn: never block on one. \
An ambiguous request gets your best judgment and one sentence saying what you assumed.
- Write for the panel: short paragraphs, no filler, no announcing what you are \
about to do — the panel already shows each tool call. Close with what is different \
now and where to look.
</luma-vault-context>

";

/// A chat turn. The first one carries the context block, and whatever the
/// caller knows about the task (`context`: the comic project's folder, say);
/// later ones are the message alone, because the transcript already holds
/// both.
pub fn prompt_for(message: &str, first_turn: bool, context: Option<&str>) -> String {
    if !first_turn {
        return message.to_string();
    }
    match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(context) => format!("{PREAMBLE}<task-context>\n{context}\n</task-context>\n\n{message}"),
        None => format!("{PREAMBLE}{message}"),
    }
}

// ---------------------------------------------------------------------------
// Parsing the CLI's stream
// ---------------------------------------------------------------------------

/// The parts of a `stream-json` line this feed reads. Everything else — the
/// partial deltas, the tool results echoed back as `user` turns, the rate
/// limit notices — is dropped: the feed shows what was said and done, not
/// every byte the model produced.
#[derive(Deserialize)]
struct StreamLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    subtype: Option<String>,
    message: Option<StreamMessage>,
    /// A machine-readable failure category, such as `authentication_failed`.
    error: Option<String>,
    /// The run's closing text — the only place a headless failure explains itself.
    result: Option<String>,
    duration_ms: Option<i64>,
    is_error: Option<bool>,
    total_cost_usd: Option<f64>,
}

#[derive(Deserialize)]
struct StreamMessage {
    content: Option<Vec<serde_json::Value>>,
}

/// A bare event of one kind; the caller fills what applies.
fn event(kind: &str) -> ChatEvent {
    ChatEvent {
        seq: 0,
        at: now_ms(),
        kind: kind.to_string(),
        text: None,
        name: None,
        detail: None,
        success: None,
        stopped: None,
        duration_ms: None,
        cost_usd: None,
    }
}

fn text_event(kind: &str, text: impl Into<String>) -> ChatEvent {
    ChatEvent { text: Some(text.into()), ..event(kind) }
}

/// A one-line summary of a tool call's arguments: the file, the command, the
/// pattern — whichever the tool takes. Paths under `cwd` are shown relative
/// to it, which is how the person thinks of them.
pub fn tool_detail(input: &serde_json::Value, cwd: &Path) -> String {
    for key in ["file_path", "path", "description", "command", "pattern", "query", "url"] {
        if let Some(value) = input.get(key).and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
            if key == "file_path" || key == "path" {
                let path = Path::new(value);
                return path
                    .strip_prefix(cwd)
                    .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| value.to_string());
            }
            return value.to_string();
        }
    }
    String::new()
}

/// The reasons a turn fails that mean "sign in", so the panel can say that
/// rather than show the CLI's menu of options as prose.
fn is_auth_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["invalid api key", "please run /login", "not logged in", "not authenticated", "authentication_failed", "authentication failed", "failed to authenticate"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// One JSON line from the CLI into the events it carries. Anything that is
/// not a JSON object — Node prints warnings on stdout on some versions — is
/// nothing.
pub fn parse_line(line: &str, cwd: &Path) -> Vec<ChatEvent> {
    let text = line.trim();
    if !text.starts_with('{') {
        return Vec::new();
    }
    let Ok(parsed) = serde_json::from_str::<StreamLine>(text) else {
        return Vec::new();
    };
    match parsed.kind.as_deref() {
        Some("system") if parsed.subtype.as_deref() == Some("init") => vec![event("start")],
        // A refused run carries its category here and its apology in a text
        // block. Reported as an error rather than as prose, or "Please run
        // /login" arrives looking like something the model decided to say.
        _ if parsed.error.as_deref().is_some_and(|e| !e.is_empty()) => {
            let error = parsed.error.unwrap_or_default();
            vec![text_event(if is_auth_error(&error) { "needs_auth" } else { "error" }, error)]
        }
        Some("assistant") => parsed
            .message
            .and_then(|m| m.content)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|block| match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| text_event("text", t)),
                Some("tool_use") => block.get("name").and_then(|n| n.as_str()).map(|name| ChatEvent {
                    name: Some(name.to_string()),
                    detail: Some(tool_detail(block.get("input").unwrap_or(&serde_json::Value::Null), cwd)),
                    ..event("tool")
                }),
                _ => None,
            })
            .collect(),
        Some("result") => {
            let success = parsed.subtype.as_deref() == Some("success") && parsed.is_error != Some(true);
            let mut events = Vec::new();
            // Ahead of the result, so the feed explains the failure before it
            // reports it.
            if parsed.is_error == Some(true) {
                if let Some(result) = parsed.result.filter(|r| !r.is_empty()) {
                    events.push(text_event(if is_auth_error(&result) { "needs_auth" } else { "error" }, result));
                }
            }
            events.push(ChatEvent {
                success: Some(success),
                duration_ms: parsed.duration_ms,
                cost_usd: parsed.total_cost_usd,
                ..event("result")
            });
            events
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

struct Session {
    info: ChatSessionInfo,
    events: Vec<ChatEvent>,
    child: Option<Child>,
    /// Bumped per turn and by a stop. A reader thread whose turn is over is
    /// ignored: its remaining lines, and its exit, stop being the session's
    /// news — which is what makes a stop clean and a double settle impossible.
    turn: u64,
}

/// What a conversation looks like on disk, so a restart shows it again and
/// the next message resumes it.
#[derive(Serialize, Deserialize)]
struct Stored {
    session: ChatSessionInfo,
    events: Vec<ChatEvent>,
}

/// Every conversation this app knows, by id.
///
/// A static rather than a field on the app state because the thread that
/// reads a turn's output outlives any borrow of the state. `loaded` is the
/// one-time read of the chats directory, done on first use rather than at
/// startup so the app opens no slower for a page nobody has visited.
pub struct Registry {
    sessions: Mutex<BTreeMap<String, Session>>,
    loaded: Mutex<bool>,
}

static REGISTRY: Registry = Registry::new();

pub fn registry() -> &'static Registry {
    &REGISTRY
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub const fn new() -> Self {
        Self { sessions: Mutex::new(BTreeMap::new()), loaded: Mutex::new(false) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Read every stored conversation once. One left `running` by a previous
    /// process died with it, so it is settled here as failed, with a line
    /// saying why — a feed that ends mid-turn with no result would look hung.
    fn ensure_loaded(&self, root: &Path) {
        let mut loaded = self.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *loaded {
            return;
        }
        *loaded = true;
        let Ok(entries) = std::fs::read_dir(root) else { return };
        let mut sessions = self.lock();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(mut stored) = serde_json::from_str::<Stored>(&text) else { continue };
            if !valid_id(&stored.session.id) || sessions.contains_key(&stored.session.id) {
                continue;
            }
            if stored.session.status == "running" {
                stored.session.status = "failed".to_string();
                let seq = stored.events.len() as i64;
                stored.events.push(ChatEvent {
                    seq,
                    ..text_event("error", "The app closed while this turn was running.")
                });
                let _ = write_stored(root, &stored);
            }
            sessions.insert(
                stored.session.id.clone(),
                Session { info: stored.session, events: stored.events, child: None, turn: 0 },
            );
        }
    }

    pub fn index(&self, root: &Path, available: bool, cwd: &Path) -> ChatIndex {
        self.ensure_loaded(root);
        let sessions = self.lock();
        let mut list: Vec<ChatSessionInfo> = sessions.values().map(|s| s.info.clone()).collect();
        list.sort_by_key(|s| std::cmp::Reverse(s.last_activity_at));
        ChatIndex { available, cwd: cwd.to_string_lossy().into_owned(), sessions: list }
    }

    pub fn feed(&self, root: &Path, id: &str, since: i64) -> Result<ChatFeed> {
        self.ensure_loaded(root);
        let sessions = self.lock();
        let session = sessions.get(id).ok_or_else(|| anyhow::anyhow!("there is no such conversation"))?;
        Ok(ChatFeed {
            session: session.info.clone(),
            events: session.events.iter().filter(|e| e.seq >= since).cloned().collect(),
            next: session.events.len() as i64,
        })
    }

    /// Stop the running turn. The process tree is killed; what the model
    /// already said stays, and the next message resumes the transcript.
    pub fn stop(&self, root: &Path, id: &str) -> bool {
        self.ensure_loaded(root);
        let mut sessions = self.lock();
        let Some(session) = sessions.get_mut(id) else { return false };
        if session.info.status != "running" {
            return false;
        }
        session.turn += 1;
        let started = session.events.iter().rev().find(|e| e.kind == "user").map(|e| e.at).unwrap_or(now_ms());
        if let Some(mut child) = session.child.take() {
            kill_tree(&mut child);
        }
        session.info.status = "failed".to_string();
        session.info.last_activity_at = now_ms();
        let seq = session.events.len() as i64;
        session.events.push(ChatEvent {
            seq,
            success: Some(false),
            stopped: Some(true),
            duration_ms: Some(now_ms() - started),
            ..event("result")
        });
        let _ = write_stored(root, &Stored { session: session.info.clone(), events: session.events.clone() });
        true
    }

    /// Forget a conversation. A running one is stopped first. The CLI's own
    /// transcript is left alone: it is the CLI's, and `claude --resume` can
    /// still find it.
    pub fn remove(&self, root: &Path, id: &str) -> bool {
        self.ensure_loaded(root);
        self.stop(root, id);
        let mut sessions = self.lock();
        if sessions.remove(id).is_none() {
            return false;
        }
        if valid_id(id) {
            let _ = std::fs::remove_file(root.join(format!("{id}.json")));
        }
        true
    }

    /// Append to a session's feed, unless the turn it belongs to is over.
    fn push(&self, id: &str, turn: u64, mut event: ChatEvent) {
        let mut sessions = self.lock();
        if let Some(session) = sessions.get_mut(id).filter(|s| s.turn == turn) {
            event.seq = session.events.len() as i64;
            session.info.last_activity_at = event.at;
            session.events.push(event);
        }
    }

    /// The turn is over. `error` is a line to add when the CLI left without
    /// saying how it ended.
    fn finish(&self, root: &Path, id: &str, turn: u64, success: bool, error: Option<String>) {
        let mut sessions = self.lock();
        let Some(session) = sessions.get_mut(id).filter(|s| s.turn == turn) else { return };
        session.child = None;
        if let Some(text) = error {
            let seq = session.events.len() as i64;
            session.events.push(ChatEvent { seq, ..text_event("error", text) });
        }
        session.info.status = if success { "done" } else { "failed" }.to_string();
        session.info.turns += 1;
        session.info.last_activity_at = now_ms();
        let _ = write_stored(root, &Stored { session: session.info.clone(), events: session.events.clone() });
    }
}

fn write_stored(root: &Path, stored: &Stored) -> Result<()> {
    std::fs::create_dir_all(root).with_context(|| format!("could not create {}", root.display()))?;
    let path = root.join(format!("{}.json", stored.session.id));
    let text = serde_json::to_string(stored)?;
    std::fs::write(&path, text).with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

/// The CLI and everything it started. On Windows `kill()` ends only the CLI
/// itself, and a shell it was running keeps going; `taskkill /t` takes the
/// tree. Elsewhere the children are orphaned and finish on their own.
fn kill_tree(child: &mut Child) {
    if cfg!(windows) {
        let _ = Command::new("taskkill")
            .args(["/pid", &child.id().to_string(), "/t", "/f"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/// Where a turn runs and what it runs.
pub struct Launch<'a> {
    pub bin: &'a Path,
    pub root: &'a Path,
    pub cwd: &'a Path,
}

/// What a new conversation starts with, beyond the message.
#[derive(Default)]
pub struct StartOptions {
    pub model: Option<String>,
    /// `comic:<name>` and the like, so a page finds the conversation again.
    pub topic: Option<String>,
    /// Task context for the first turn: where a project lives, what to write.
    pub context: Option<String>,
}

/// A new conversation, with its first turn started.
pub fn start(registry: &'static Registry, launch: &Launch<'_>, message: &str, options: StartOptions) -> Result<ChatSessionInfo> {
    registry.ensure_loaded(launch.root);
    let message = message.trim();
    if message.is_empty() {
        anyhow::bail!("say something first");
    }
    let id = new_id()?;
    let now = now_ms();
    let info = ChatSessionInfo {
        id: id.clone(),
        title: title_of(message),
        status: "idle".to_string(),
        model: options.model.filter(|m| !m.trim().is_empty()),
        topic: options.topic.filter(|t| !t.trim().is_empty()),
        created_at: now,
        last_activity_at: now,
        turns: 0,
    };
    registry
        .lock()
        .insert(id.clone(), Session { info, events: Vec::new(), child: None, turn: 0 });
    run_turn(registry, launch, &id, message, options.context.as_deref())
}

/// Another message into an existing conversation. Refused, not queued, while
/// a turn is running: the CLI holds the transcript open and resuming it
/// underneath is not something it promises to survive.
pub fn send(registry: &'static Registry, launch: &Launch<'_>, id: &str, message: &str) -> Result<ChatSessionInfo> {
    registry.ensure_loaded(launch.root);
    let message = message.trim();
    if message.is_empty() {
        anyhow::bail!("say something first");
    }
    {
        let sessions = registry.lock();
        let session = sessions.get(id).ok_or_else(|| anyhow::anyhow!("there is no such conversation"))?;
        if session.info.status == "running" {
            anyhow::bail!("still working on the last message; stop it or wait");
        }
    }
    run_turn(registry, launch, id, message, None)
}

/// The command line a turn starts from.
///
/// `--session-id` names the transcript on the first turn and `--resume=` on
/// the rest — joined with `=`, because the flag's value is optional and a
/// separate token is read as a positional prompt instead. The prompt itself
/// goes in on stdin rather than argv: Windows caps a command line at 32k
/// characters and a pasted log would hit it. `CLAUDECODE` is removed so the
/// CLI does not think it is nested inside another session when this app was
/// launched from one. Nothing here can answer a question — the turn is a
/// process that exits — so the ask-the-user tool is off and anything else
/// that would prompt is denied rather than waited on.
fn command(launch: &Launch<'_>, id: &str, resume: bool, model: Option<&str>) -> Command {
    let mut command = Command::new(launch.bin);
    command.arg("-p");
    if resume {
        command.arg(format!("--resume={id}"));
    } else {
        command.arg("--session-id").arg(id);
    }
    if let Some(model) = model {
        command.arg("--model").arg(model);
    }
    command
        .args(["--output-format", "stream-json", "--verbose"])
        .args(["--permission-mode", "auto"])
        .args(["--permission-prompts", "none"])
        .args(["--disallowedTools", "AskUserQuestion"])
        .current_dir(launch.cwd)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn run_turn(registry: &'static Registry, launch: &Launch<'_>, id: &str, message: &str, context: Option<&str>) -> Result<ChatSessionInfo> {
    let root = launch.root.to_path_buf();
    let cwd = launch.cwd.to_path_buf();
    let (turn, prompt, mut command, info) = {
        let mut sessions = registry.lock();
        let session = sessions.get_mut(id).ok_or_else(|| anyhow::anyhow!("there is no such conversation"))?;
        session.turn += 1;
        let turn = session.turn;
        let first = session.info.turns == 0;
        let seq = session.events.len() as i64;
        session.events.push(ChatEvent { seq, ..text_event("user", message) });
        session.info.status = "running".to_string();
        session.info.last_activity_at = now_ms();
        let command = command(launch, id, !first, session.info.model.as_deref());
        (turn, prompt_for(message, first, context), command, session.info.clone())
    };

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let text = format!("could not start the claude CLI at {}: {error}", launch.bin.display());
            registry.finish(&root, id, turn, false, Some(text.clone()));
            anyhow::bail!("{text}");
        }
    };
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let mut stdin = child.stdin.take().expect("stdin was piped");
    {
        let mut sessions = registry.lock();
        if let Some(session) = sessions.get_mut(id) {
            session.child = Some(child);
        }
    }
    let _ = write_stored(&root, &Stored { session: info.clone(), events: registry.lock().get(id).map(|s| s.events.clone()).unwrap_or_default() });

    // The prompt, then EOF: the CLI reads stdin to the end before it starts.
    // On its own thread so a prompt larger than the pipe cannot block this
    // one against a child that has not begun reading yet.
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
        drop(stdin);
    });

    // stderr on its own thread, forwarded as it comes: the CLI writes its
    // warnings there, and a full pipe would block it on the words nobody
    // is reading.
    {
        let id = id.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let kind = if is_auth_error(&line) { "needs_auth" } else { "stderr" };
                registry.push(&id, turn, text_event(kind, line));
            }
        });
    }

    let id_owned = id.to_string();
    std::thread::spawn(move || {
        let id = id_owned;
        let mut result: Option<bool> = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            for event in parse_line(&line, &cwd) {
                if event.kind == "result" {
                    result = event.success;
                }
                registry.push(&id, turn, event);
            }
        }
        let status = {
            let mut sessions = registry.lock();
            sessions
                .get_mut(&id)
                .filter(|s| s.turn == turn)
                .and_then(|s| s.child.as_mut())
                .map(|child| child.wait())
        };
        match result {
            Some(success) => registry.finish(&root, &id, turn, success, None),
            // Gone without a `result` line — say so rather than report a
            // silent pass.
            None => {
                let code = match status {
                    Some(Ok(status)) => status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
                    _ => "unknown".to_string(),
                };
                registry.finish(&root, &id, turn, false, Some(format!("the claude CLI exited without a result (code {code})")));
            }
        }
    });

    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_a_lowercase_uuid_and_nothing_else() {
        let id = new_id().unwrap();
        assert!(valid_id(&id), "{id}");
        assert!(!valid_id("../index"));
        assert!(!valid_id("E9A2BBD7-EBE5-4307-9022-CEB4976FDF56"));
        assert!(!valid_id("e9a2bbd7ebe543079022ceb4976fdf56"));
    }

    #[test]
    fn a_title_is_the_first_line_cut_short() {
        assert_eq!(title_of("\n\n  hello there \nmore"), "hello there");
        assert_eq!(title_of("   "), "(empty)");
        let long = "x".repeat(80);
        let title = title_of(&long);
        assert_eq!(title.chars().count(), 61);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn only_the_first_turn_carries_the_context_block() {
        assert!(prompt_for("hi", true, None).starts_with("<luma-vault-context>"));
        assert!(prompt_for("hi", true, None).ends_with("\n\nhi"));
        assert_eq!(prompt_for("hi", false, None), "hi");
        let with = prompt_for("hi", true, Some("The comic lives at X."));
        assert!(with.contains("<task-context>\nThe comic lives at X.\n</task-context>\n\nhi"));
        assert_eq!(prompt_for("hi", false, Some("ignored")), "hi");
        assert!(!prompt_for("hi", true, Some("  ")).contains("task-context"));
    }

    #[test]
    fn the_stream_is_read_into_a_short_feed() {
        let cwd = Path::new("D:\\repo");
        assert!(parse_line("(node:1) ExperimentalWarning", cwd).is_empty());
        assert!(parse_line("not json {", cwd).is_empty());

        let start = parse_line(r#"{"type":"system","subtype":"init","cwd":"x"}"#, cwd);
        assert_eq!(start.len(), 1);
        assert_eq!(start[0].kind, "start");

        // Partial deltas and echoed tool results are not news.
        assert!(parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta"}}"#, cwd).is_empty());
        assert!(parse_line(r#"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#, cwd).is_empty());

        let assistant = parse_line(
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"Done."},{"type":"tool_use","name":"Edit","input":{"file_path":"D:\\repo\\src\\a.rs"}}]}}"#,
            cwd,
        );
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[0].kind, "text");
        assert_eq!(assistant[0].text.as_deref(), Some("Done."));
        assert_eq!(assistant[1].kind, "tool");
        assert_eq!(assistant[1].name.as_deref(), Some("Edit"));
        assert_eq!(assistant[1].detail.as_deref(), Some("src/a.rs"));

        let result = parse_line(r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"total_cost_usd":0.01}"#, cwd);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].success, Some(true));
        assert_eq!(result[0].duration_ms, Some(1200));

        // A refusal comes back as an error line ahead of a failed result.
        let failed = parse_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run /login"}"#, cwd);
        assert_eq!(failed.len(), 2);
        assert_eq!(failed[0].kind, "needs_auth");
        assert_eq!(failed[1].success, Some(false));
    }

    #[test]
    fn a_tool_detail_names_the_thing_the_tool_touches() {
        let cwd = Path::new("/repo");
        assert_eq!(tool_detail(&serde_json::json!({"command": "ls", "description": "list"}), cwd), "list");
        assert_eq!(tool_detail(&serde_json::json!({"command": "ls"}), cwd), "ls");
        assert_eq!(tool_detail(&serde_json::json!({"pattern": "fn main"}), cwd), "fn main");
        assert_eq!(tool_detail(&serde_json::json!({"file_path": "/elsewhere/x"}), cwd), "/elsewhere/x");
        assert_eq!(tool_detail(&serde_json::json!({}), cwd), "");
    }

    #[test]
    fn an_empty_registry_says_so_and_a_stop_on_nothing_is_false() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::default();
        let index = registry.index(dir.path(), false, Path::new("/repo"));
        assert!(!index.available && index.sessions.is_empty());
        assert!(!registry.stop(dir.path(), "e9a2bbd7-ebe5-4307-9022-ceb4976fdf56"));
        assert!(registry.feed(dir.path(), "nope", 0).is_err());
    }

    #[test]
    fn a_conversation_left_running_by_a_dead_process_is_settled_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let stored = Stored {
            session: ChatSessionInfo {
                id: "e9a2bbd7-ebe5-4307-9022-ceb4976fdf56".to_string(),
                title: "hi".to_string(),
                status: "running".to_string(),
                model: None,
                topic: None,
                created_at: 1,
                last_activity_at: 2,
                turns: 0,
            },
            events: vec![ChatEvent { seq: 0, ..text_event("user", "hi") }],
        };
        write_stored(dir.path(), &stored).unwrap();
        let registry = Registry::default();
        let feed = registry.feed(dir.path(), &stored.session.id, 0).unwrap();
        assert_eq!(feed.session.status, "failed");
        assert_eq!(feed.events.len(), 2);
        assert_eq!(feed.events[1].kind, "error");
        assert_eq!(feed.next, 2);
        // Only what is new comes back on the next poll.
        assert!(registry.feed(dir.path(), &stored.session.id, 2).unwrap().events.is_empty());
        assert!(registry.remove(dir.path(), &stored.session.id));
        assert!(!dir.path().join("e9a2bbd7-ebe5-4307-9022-ceb4976fdf56.json").exists());
    }
}

/// Against the real CLI, so it is not part of the gate: `cargo test
/// a_real_turn -- --ignored` when the spawn path changes. Needs `claude`
/// installed and signed in, and a few seconds of a small model.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn a_real_turn_round_trips_through_the_registry() {
        let Some(bin) = resolve() else {
            eprintln!("claude is not installed; nothing to check");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        static LIVE: Registry = Registry::new();
        let launch = Launch { bin: &bin, root: dir.path(), cwd: dir.path() };
        let info = start(&LIVE, &launch, "Reply with exactly the word: pelican", StartOptions { model: Some("haiku".to_string()), ..StartOptions::default() }).unwrap();
        assert_eq!(info.status, "running");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let feed = loop {
            let feed = LIVE.feed(dir.path(), &info.id, 0).unwrap();
            if feed.session.status != "running" {
                break feed;
            }
            assert!(std::time::Instant::now() < deadline, "the turn did not finish: {feed:?}");
            std::thread::sleep(std::time::Duration::from_millis(500));
        };
        assert_eq!(feed.session.status, "done", "{feed:?}");
        assert_eq!(feed.session.turns, 1);
        let kinds: Vec<&str> = feed.events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds.first(), Some(&"user"));
        assert!(kinds.contains(&"start"), "{kinds:?}");
        assert!(feed.events.iter().any(|e| e.kind == "text" && e.text.as_deref().is_some_and(|t| t.to_lowercase().contains("pelican"))), "{feed:?}");
        assert_eq!(feed.events.last().map(|e| e.kind.as_str()), Some("result"));
        assert!(dir.path().join(format!("{}.json", info.id)).is_file());

        // A second message resumes the same transcript.
        send(&LIVE, &launch, &info.id, "Which word did you just say? One word.").unwrap();
        let feed = loop {
            let feed = LIVE.feed(dir.path(), &info.id, 0).unwrap();
            if feed.session.status != "running" {
                break feed;
            }
            assert!(std::time::Instant::now() < deadline, "the second turn did not finish: {feed:?}");
            std::thread::sleep(std::time::Duration::from_millis(500));
        };
        assert_eq!(feed.session.turns, 2);
        let answer = feed.events.iter().rev().find(|e| e.kind == "text").and_then(|e| e.text.clone()).unwrap_or_default();
        assert!(answer.to_lowercase().contains("pelican"), "{answer}");
    }
}
