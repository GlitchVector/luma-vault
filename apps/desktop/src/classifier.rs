//! A pool of persistent Python classifier processes.
//!
//! Each worker loads the ONNX model once and then serves batches over
//! stdin/stdout for the lifetime of the app. The pool hands a worker to a
//! caller, waits for the response, and returns the worker to the queue — so
//! `classify` blocks until a worker is free, which is exactly the backpressure
//! we want: the scan cannot outrun the classifier and pile up unbounded work.
//!
//! # Differences from the corn-dog generation of this code
//!
//! - **Persistent, not one-shot.** That code spawned `python detector.py` per
//!   batch, rebuilding the onnxruntime session (~300-600ms) every time.
//! - **Timeouts.** That code had none: a wedged Python process hung the scan
//!   forever. Here a worker that misses its deadline is killed and respawned.
//! - **Bounded payloads.** That code base64-encoded an entire batch into one
//!   temp JSON file. Here we pass paths, and the worker reads from disk.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{bounded, Receiver, Sender};
use serde::Deserialize;

use crate::types::Detection;

/// How long one batch may take before the worker is presumed wedged.
///
/// Generous, because the first batch after start also pays for page-faulting
/// the model in, and a batch is up to `BATCH_SIZE` files.
const BATCH_TIMEOUT: Duration = Duration::from_secs(180);

/// Files per request. Large enough that the per-request JSON overhead is
/// irrelevant, small enough that one wedged file does not take 500 others down
/// with it when the batch times out.
pub const BATCH_SIZE: usize = 16;

#[derive(Debug, Deserialize)]
struct WorkerResponse {
    #[serde(default)]
    results: Vec<WorkerResult>,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkerResult {
    ok: bool,
    #[serde(default)]
    detections: Vec<Detection>,
    #[serde(default)]
    error: Option<String>,
}

/// One file's outcome. `Err` carries the reason so the pipeline can record it
/// as a scan error row rather than silently dropping the file.
pub type ClassifyOutcome = std::result::Result<Vec<Detection>, String>;

struct Worker {
    child: Child,
    stdin: ChildStdin,
    /// Fed by a reader thread, so `recv_timeout` can enforce a deadline. A bare
    /// blocking read on the pipe has no timeout and cannot be interrupted.
    lines: Receiver<String>,
    next_id: u64,
    python: PathBuf,
    script: PathBuf,
}

impl Worker {
    fn spawn(python: &Path, script: &Path) -> Result<Self> {
        let mut child = Command::new(python)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherited, so the worker's diagnostics land in the app log rather
            // than filling a pipe nobody drains and deadlocking the child.
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("cannot start classifier: {}", python.display()))?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

        let (tx, rx) = bounded::<String>(64);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break; // pool dropped the worker
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let worker = Self {
            child,
            stdin,
            lines: rx,
            next_id: 1,
            python: python.to_path_buf(),
            script: script.to_path_buf(),
        };

        // The worker announces itself once the model is loaded. Waiting for it
        // here means `ClassifierPool::new` fails loudly on a broken venv instead
        // of every batch failing later.
        let ready = worker
            .lines
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| anyhow!("classifier did not become ready within 120s"))?;
        let parsed: WorkerResponse = serde_json::from_str(&ready)
            .with_context(|| format!("classifier sent junk on startup: {ready}"))?;
        if parsed.kind == "fatal" {
            bail!(
                "classifier failed to start: {}",
                parsed.error.unwrap_or_default()
            );
        }
        if parsed.kind != "ready" {
            bail!("classifier sent an unexpected first line: {ready}");
        }

        Ok(worker)
    }

    fn classify(&mut self, paths: &[String]) -> Result<Vec<ClassifyOutcome>> {
        let id = self.next_id;
        self.next_id += 1;

        let request = serde_json::json!({ "id": id, "cmd": "classify", "paths": paths });
        writeln!(self.stdin, "{request}").context("classifier stdin closed")?;
        self.stdin.flush().context("cannot flush to classifier")?;

        // Skip any line that is not our response. The worker only emits
        // protocol lines on stdout, but being permissive here costs nothing and
        // protects against a library that prints despite the redirect.
        let deadline = std::time::Instant::now() + BATCH_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                bail!("classifier timed out after {}s", BATCH_TIMEOUT.as_secs());
            }
            let line = self
                .lines
                .recv_timeout(remaining)
                .map_err(|_| anyhow!("classifier stopped responding"))?;

            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(|v| v.as_u64()) != Some(id) {
                continue;
            }

            let response: WorkerResponse = serde_json::from_value(value)
                .with_context(|| format!("malformed classifier response: {line}"))?;

            if response.results.len() != paths.len() {
                bail!(
                    "classifier returned {} results for {} paths",
                    response.results.len(),
                    paths.len()
                );
            }

            return Ok(response
                .results
                .into_iter()
                .map(|result| {
                    if result.ok {
                        Ok(result.detections)
                    } else {
                        Err(result.error.unwrap_or_else(|| "unknown error".to_string()))
                    }
                })
                .collect());
        }
    }

    fn respawn(&mut self) -> Result<()> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let fresh = Worker::spawn(&self.python.clone(), &self.script.clone())?;
        *self = fresh;
        Ok(())
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Best-effort graceful shutdown, then make sure it is really gone —
        // an orphaned Python process holding the model in memory is a very
        // visible bug on a laptop.
        let _ = writeln!(self.stdin, "{{\"cmd\":\"shutdown\"}}");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct ClassifierPool {
    idle: Receiver<Worker>,
    ret: Sender<Worker>,
}

impl ClassifierPool {
    /// Starts `size` workers, or fails if the very first one cannot start.
    ///
    /// Only the first failure is fatal: if worker 3 of 6 fails to spawn, the
    /// pool runs with what it has. A machine that is out of memory for a sixth
    /// model should still scan, just slower.
    pub fn new(python: &Path, script: &Path, size: usize) -> Result<Self> {
        let size = size.max(1);
        let (ret, idle) = bounded::<Worker>(size);

        let first = Worker::spawn(python, script).context(
            "the classifier could not start. Run `pnpm setup:python` to create the venv",
        )?;
        ret.send(first).expect("channel just created");

        let mut live = 1;
        for index in 1..size {
            match Worker::spawn(python, script) {
                Ok(worker) => {
                    ret.send(worker).expect("channel has capacity");
                    live += 1;
                }
                Err(error) => {
                    eprintln!("[luma] classifier worker {index} failed to start: {error:#}");
                    break;
                }
            }
        }

        eprintln!("[luma] classifier pool up with {live} worker(s)");
        Ok(Self { idle, ret })
    }

    /// Classify a batch. Blocks until a worker is free.
    ///
    /// A worker that times out or dies is killed and respawned before the slot
    /// returns to the queue, so a single bad file cannot permanently shrink the
    /// pool. The batch that hit the failure is reported as failed per-file.
    pub fn classify(&self, paths: &[String]) -> Result<Vec<ClassifyOutcome>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }

        let mut worker = self
            .idle
            .recv()
            .map_err(|_| anyhow!("classifier pool has been shut down"))?;

        let outcome = worker.classify(paths);

        match outcome {
            Ok(results) => {
                let _ = self.ret.send(worker);
                Ok(results)
            }
            Err(error) => {
                eprintln!("[luma] classifier worker failed ({error:#}), respawning");
                match worker.respawn() {
                    Ok(()) => {
                        let _ = self.ret.send(worker);
                    }
                    Err(respawn_error) => {
                        eprintln!("[luma] worker could not be respawned: {respawn_error:#}");
                        // Deliberately not returned to the pool: a slot that
                        // cannot host a worker would deadlock the next caller.
                    }
                }
                Ok(paths.iter().map(|_| Err(error.to_string())).collect())
            }
        }
    }
}

/// Find the Python interpreter that owns the classifier venv.
///
/// `LUMA_PYTHON` wins so a developer can point at a system install or a conda
/// env without touching the repo. Otherwise the convention that
/// `pnpm setup:python` writes applies — `bin/python` on Unix,
/// `Scripts\python.exe` on Windows.
pub fn resolve_python(repo_root: &Path, resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("LUMA_PYTHON") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
        eprintln!("[luma] LUMA_PYTHON is set but not a file: {}", path.display());
    }

    let mut candidates = vec![
        repo_root.join("venv-classifier/bin/python"),
        repo_root.join("venv-classifier/Scripts/python.exe"),
    ];
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("venv-classifier/bin/python"));
        candidates.push(resources.join("venv-classifier/Scripts/python.exe"));
    }

    candidates.into_iter().find(|path| path.is_file())
}

/// Find `classify_worker.py`, next to wherever Python was found.
pub fn resolve_script(repo_root: &Path, resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = vec![repo_root.join("sidecar/classifier/classify_worker.py")];
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("sidecar/classifier/classify_worker.py"));
        candidates.push(resources.join("classify_worker.py"));
    }
    candidates.into_iter().find(|path| path.is_file())
}
