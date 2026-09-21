//! Comics: prose in, lettered pages out, through the Node pipeline in
//! `packages/comic`.
//!
//! The pipeline is a CLI on purpose — every stage is rerunnable from a shell
//! with nothing else in the path — so this module does not learn what it
//! does. It keeps the projects, hands the CLI a stage and a folder, and reads
//! the JSON events it prints so the panel can draw them. The same shape
//! `patreon.rs` uses for the harness.
//!
//! Projects live under the app's own data directory, never beside media: a
//! rendered panel is a PNG in a folder the app writes, and putting that inside
//! a watched folder would have the watcher index every attempt. Forge's own
//! copy of each panel still lands in its outputs folder, which *is* watched —
//! that is how a rendered panel reaches the library.
//!
//! One run at a time. There is one GPU and one Chrome; a second run would
//! only queue behind the first inside Forge and make both look hung.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use anyhow::{Context, Result};

use crate::types::{
    ComicEvent, ComicInspection, ComicPage, ComicPanel, ComicProject, ComicRunOptions, ComicSettings,
    ComicStatus, ComicSummary, ComicVerdict,
};

/// The CLI's entry point, in a dev tree or a bundle. Mirrors `patreon::resolve`.
pub fn resolve(repo_root: &Path, resource_dir: Option<&Path>) -> Option<PathBuf> {
    for base in [Some(repo_root), resource_dir].into_iter().flatten() {
        let cli = base.join("packages").join("comic").join("src").join("cli.ts");
        if cli.is_file() {
            return Some(cli);
        }
    }
    None
}

/// Where every comic lives. Under app data, never beside media.
pub fn comics_root(data_dir: &Path) -> PathBuf {
    data_dir.join("comics")
}

/// A project name is a folder name this module builds a path from, so it is
/// checked against an allowlist of characters rather than escaped. Lower-case
/// letters, digits, dashes and underscores; nothing that could be a path.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn project_dir(root: &Path, name: &str) -> Result<PathBuf> {
    if !valid_name(name) {
        anyhow::bail!("\"{name}\" is not a comic name: use lower-case letters, digits, dashes and underscores");
    }
    Ok(root.join(name))
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// The prose template a new project starts with: a heading and a hint, so
/// the panel's editor is never a blank box with no idea what goes in it.
const PROSE_TEMPLATE: &str =
    "# Title\n\nWrite the story here, as prose. Three paragraphs make a page.\n";

pub fn create(root: &Path, name: &str) -> Result<ComicSummary> {
    let dir = project_dir(root, name)?;
    if dir.exists() {
        anyhow::bail!("a comic called \"{name}\" already exists");
    }
    std::fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    std::fs::write(dir.join("prose.md"), PROSE_TEMPLATE)?;
    summarize(&dir, name)
}

/// The alphabetically first PNG in `dir` whose name starts with `prefix`.
fn first_png(dir: &Path, prefix: &str) -> Option<String> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            name.starts_with(prefix) && name.ends_with(".png")
        })
        .collect();
    found.sort();
    found.first().map(|path| path.to_string_lossy().to_string())
}

fn summarize(dir: &Path, name: &str) -> Result<ComicSummary> {
    let script = read_json(&dir.join("script.json"));
    let (title, pages, panels) = match &script {
        Some(value) => {
            let pages = value.get("pages").and_then(|p| p.as_array());
            let count = pages.map(|p| p.len()).unwrap_or(0) as i64;
            let panels = pages
                .map(|p| {
                    p.iter()
                        .map(|page| page.get("panels").and_then(|x| x.as_array()).map(|x| x.len()).unwrap_or(0))
                        .sum::<usize>()
                })
                .unwrap_or(0) as i64;
            (
                value.get("title").and_then(|t| t.as_str()).map(str::to_string),
                count,
                panels,
            )
        }
        None => (None, 0, 0),
    };
    let rendered = std::fs::read_dir(dir.join("panels"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("png"))
                .count()
        })
        .unwrap_or(0) as i64;
    let assembled = std::fs::read_dir(dir.join("out"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    let n = e.file_name();
                    let n = n.to_string_lossy();
                    n.starts_with("page-") && n.ends_with(".png")
                })
                .count()
        })
        .unwrap_or(0) as i64;
    // The finished thing first, the raw material second: a comic with pages
    // shows a page, one that is only rendered shows a panel.
    let thumb = first_png(&dir.join("out"), "page-").or_else(|| first_png(&dir.join("panels"), ""));
    let updated_at = ["prose.md", "script.json", "out/book.pdf"]
        .iter()
        .map(|f| mtime_ms(&dir.join(f)))
        .max()
        .unwrap_or(0);
    Ok(ComicSummary {
        name: name.to_string(),
        title,
        pages,
        panels,
        rendered,
        assembled,
        has_prose: dir.join("prose.md").is_file(),
        has_script: script.is_some(),
        thumb,
        updated_at,
    })
}

pub fn list(root: &Path) -> Result<Vec<ComicSummary>> {
    let mut comics = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return Ok(comics);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() && valid_name(&name) {
            comics.push(summarize(&path, &name)?);
        }
    }
    comics.sort_by_key(|comic| std::cmp::Reverse(comic.updated_at));
    Ok(comics)
}

/// Earlier attempts at one panel, newest first.
///
/// By name: the pipeline keeps `<id>-<seed>-<hash>.png` beside the panels, so
/// the prefix is the panel and everything after it is which attempt.
fn history_of(dir: &Path, id: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let prefix = format!("{id}-");
    let mut found: Vec<(i64, String)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            name.starts_with(&prefix) && name.ends_with(".png")
        })
        .map(|path| (mtime_ms(&path), path.to_string_lossy().to_string()))
        .collect();
    found.sort_by_key(|(when, _)| std::cmp::Reverse(*when));
    found.into_iter().map(|(_, path)| path).collect()
}

/// A string array out of a JSON object, or empty. Missing and malformed are
/// the same thing here: a verdict file nobody can read is not a reason to
/// lose the panel it belongs to.
fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|x| x.as_array())
        .map(|f| f.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub fn read(root: &Path, name: &str) -> Result<ComicProject> {
    let dir = project_dir(root, name)?;
    if !dir.is_dir() {
        anyhow::bail!("there is no comic called \"{name}\"");
    }
    let prose = std::fs::read_to_string(dir.join("prose.md")).unwrap_or_default();
    let script = read_json(&dir.join("script.json"));

    let mut panels = Vec::new();
    if let Some(pages) = script.as_ref().and_then(|s| s.get("pages")).and_then(|p| p.as_array()) {
        for (page_index, page) in pages.iter().enumerate() {
            let Some(list) = page.get("panels").and_then(|p| p.as_array()) else { continue };
            for panel in list {
                let Some(id) = panel.get("id").and_then(|i| i.as_str()) else { continue };
                let png = dir.join("panels").join(format!("{id}.png"));
                let plate = dir.join("plates").join(format!("{id}.png"));
                let sidecar = read_json(&dir.join("panels").join(format!("{id}.json")));
                let verdict = read_json(&dir.join("qa").join(format!("{id}.json"))).map(|v| ComicVerdict {
                    ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
                    attempt: v.get("attempt").and_then(|x| x.as_i64()).unwrap_or(0),
                    failures: strings(&v, "failures"),
                    // Notes are not failures and never retry, but they are
                    // the only thing QA has to say about a panel it passed.
                    notes: strings(&v, "notes"),
                });
                panels.push(ComicPanel {
                    id: id.to_string(),
                    page: page_index as i64 + 1,
                    path: png.is_file().then(|| png.to_string_lossy().to_string()),
                    // The mtime is the cache-buster: the same panel id gets a
                    // new file on every attempt and the webview must not show
                    // the old one.
                    rendered_at: png.is_file().then(|| mtime_ms(&png)),
                    seed: sidecar.as_ref().and_then(|s| s.get("seed")).and_then(|x| x.as_i64()),
                    attempt: sidecar.as_ref().and_then(|s| s.get("attempt")).and_then(|x| x.as_i64()),
                    prompt: sidecar
                        .as_ref()
                        .and_then(|s| s.get("request"))
                        .and_then(|r| r.get("prompt"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string),
                    plate: plate.is_file().then(|| plate.to_string_lossy().to_string()),
                    history: history_of(&dir.join("panels").join("history"), id),
                    verdict,
                });
            }
        }
    }

    let mut pages = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir.join("out")) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                n.starts_with("page-") && n.ends_with(".png")
            })
            .collect();
        files.sort();
        for (index, file) in files.iter().enumerate() {
            let number = index as i64 + 1;
            let laid_out = mtime_ms(file);
            // A page is a screenshot of its panels. If any of them is newer,
            // the person is looking at art that has since been replaced —
            // which is not something the panels themselves can show.
            let stale = panels
                .iter()
                .filter(|panel| panel.page == number)
                .any(|panel| panel.rendered_at.is_some_and(|drawn| drawn > laid_out));
            pages.push(ComicPage {
                number,
                path: file.to_string_lossy().to_string(),
                rendered_at: laid_out,
                stale,
            });
        }
    }
    let pdf = dir.join("out").join("book.pdf");
    let cbz = dir.join("out").join("book.cbz");

    Ok(ComicProject {
        name: name.to_string(),
        dir: dir.to_string_lossy().to_string(),
        prose,
        script,
        panels,
        pages,
        pdf: pdf.is_file().then(|| pdf.to_string_lossy().to_string()),
        cbz: cbz.is_file().then(|| cbz.to_string_lossy().to_string()),
    })
}

/// Write the prose and/or the script. The script is written pretty-printed,
/// the way the CLI writes it, so a hand edit and a panel edit diff the same.
pub fn save(root: &Path, name: &str, prose: Option<String>, script: Option<serde_json::Value>) -> Result<()> {
    let dir = project_dir(root, name)?;
    std::fs::create_dir_all(&dir)?;
    if let Some(prose) = prose {
        std::fs::write(dir.join("prose.md"), prose)?;
    }
    if let Some(script) = script {
        let mut text = serde_json::to_string_pretty(&script)?;
        text.push('\n');
        std::fs::write(dir.join("script.json"), text)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Running a stage

struct Run {
    comic: String,
    stage: String,
    events: Vec<ComicEvent>,
    child: Option<Child>,
    finished: bool,
    error: Option<String>,
}

/// The one run at a time, and what it has said so far.
///
/// Events are kept in memory rather than streamed: the panel polls with the
/// sequence number it has, which is the same code path for the window and
/// for a browser on the LAN, where there are no Tauri events to listen to.
pub struct Runner {
    run: Mutex<Option<Run>>,
}

impl Default for Runner {
    fn default() -> Self {
        Self::new()
    }
}

/// The process-wide runner. A static rather than a field on the app state
/// because the thread that reads the pipeline's output outlives any borrow
/// of the state, and "one run at a time" is a fact about the machine.
static RUNNER: Runner = Runner::new();

pub fn runner() -> &'static Runner {
    &RUNNER
}

impl Runner {
    pub const fn new() -> Self {
        Self { run: Mutex::new(None) }
    }

    pub fn status(&self, since: i64) -> ComicStatus {
        let guard = self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            None => ComicStatus {
                running: false,
                finished: false,
                comic: None,
                stage: None,
                events: Vec::new(),
                next: 0,
                error: None,
            },
            Some(run) => ComicStatus {
                running: !run.finished,
                finished: run.finished,
                comic: Some(run.comic.clone()),
                stage: Some(run.stage.clone()),
                events: run.events.iter().filter(|e| e.seq >= since).cloned().collect(),
                next: run.events.len() as i64,
                error: run.error.clone(),
            },
        }
    }

    /// Stop the running stage. The child is killed; whatever it had written
    /// stays, and the next run picks up from the cache.
    pub fn cancel(&self) -> bool {
        let mut guard = self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(run) if !run.finished => {
                if let Some(child) = run.child.as_mut() {
                    let _ = child.kill();
                }
                true
            }
            _ => false,
        }
    }

    fn push(&self, event: ComicEvent) {
        let mut guard = self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(run) = guard.as_mut() {
            run.events.push(event);
        }
    }

    fn finish(&self, error: Option<String>) {
        let mut guard = self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(run) = guard.as_mut() {
            run.finished = true;
            run.child = None;
            if error.is_some() {
                run.error = error;
            }
        }
    }
}

/// The command line every stage starts from. `.env` from the repo root;
/// the package as the working directory, like `pnpm comic` would have it.
fn client(cli: &Path, repo_root: &Path) -> Command {
    let mut command = Command::new("node");
    command
        .arg(format!("--env-file-if-exists={}", repo_root.join(".env").to_string_lossy()))
        .arg("--experimental-strip-types")
        .arg(cli)
        .current_dir(cli.parent().and_then(Path::parent).unwrap_or(repo_root))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Ask the pipeline what it would do, without doing it.
///
/// Synchronous and outside the `Runner`, because this answers a question
/// rather than starting work: it reads files, talks to nothing, and takes
/// about as long as node takes to start. It deliberately does NOT go through
/// `start`, so it still answers while a render is running.
pub fn inspect(cli: &Path, repo_root: &Path, root: &Path, name: &str) -> Result<ComicInspection> {
    let dir = project_dir(root, name)?;
    if !dir.is_dir() {
        anyhow::bail!("there is no comic called \"{name}\"");
    }
    let output = client(cli, repo_root)
        .arg("inspect")
        .arg(&dir)
        .arg("--json")
        .output()
        .context("could not start node — is it on PATH?")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output");
        anyhow::bail!("comic inspect failed: {tail}");
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .context("comic inspect printed nothing to read")?;
    serde_json::from_str(line).context("comic inspect printed something this app cannot read")
}

/// Write the four editable settings into the project's own
/// `comic.config.json`, leaving every other key in it untouched.
///
/// The project file is an override laid over the package's, merged key by
/// key at every depth, so writing `forge.hires.enabled` here does not cost
/// the project its checkpoint or the package its defaults.
pub fn save_settings(root: &Path, name: &str, settings: &ComicSettings) -> Result<()> {
    if settings.checkpoint.trim().is_empty() {
        anyhow::bail!("the checkpoint cannot be empty");
    }
    if !(1.0..=4.0).contains(&settings.page_scale) {
        anyhow::bail!("the page scale has to be between 1 and 4");
    }
    if !(0.0..=1.0).contains(&settings.hires_denoise) {
        anyhow::bail!("the hires denoise has to be between 0 and 1");
    }
    if !(256..=8000).contains(&settings.page_width) || !(256..=8000).contains(&settings.page_height) {
        anyhow::bail!("the page has to be between 256 and 8000 pixels on a side");
    }
    let dir = project_dir(root, name)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("comic.config.json");
    let mut config = read_json(&path).unwrap_or_else(|| serde_json::json!({}));
    let object = config
        .as_object_mut()
        .context("comic.config.json in this project is not a JSON object")?;

    {
        let forge = object.entry("forge").or_insert_with(|| serde_json::json!({}));
        let forge = forge.as_object_mut().context("\"forge\" in comic.config.json is not an object")?;
        forge.insert("checkpoint".to_string(), serde_json::json!(settings.checkpoint.trim()));
        let hires = forge.entry("hires").or_insert_with(|| serde_json::json!({}));
        let hires = hires.as_object_mut().context("\"forge.hires\" in comic.config.json is not an object")?;
        hires.insert("enabled".to_string(), serde_json::json!(settings.hires_enabled));
        hires.insert("denoise".to_string(), serde_json::json!(settings.hires_denoise));
    }
    {
        let page = object.entry("page").or_insert_with(|| serde_json::json!({}));
        let page = page.as_object_mut().context("\"page\" in comic.config.json is not an object")?;
        page.insert("scale".to_string(), serde_json::json!(settings.page_scale));
        page.insert("width".to_string(), serde_json::json!(settings.page_width));
        page.insert("height".to_string(), serde_json::json!(settings.page_height));
    }
    {
        let prompt = object.entry("prompt").or_insert_with(|| serde_json::json!({}));
        let prompt = prompt.as_object_mut().context("\"prompt\" in comic.config.json is not an object")?;
        prompt.insert("style".to_string(), serde_json::json!(settings.style.trim()));
        prompt.insert("lighting".to_string(), serde_json::json!(settings.lighting.trim()));
        prompt.insert("quality".to_string(), serde_json::json!(settings.global_tags.trim()));
    }

    let mut text = serde_json::to_string_pretty(&config)?;
    text.push('\n');
    std::fs::write(&path, text)?;
    Ok(())
}

/// Put a kept attempt back as the panel.
///
/// The current picture is archived first, so choosing an older one is not a
/// way to lose the newer one — the whole point of keeping them is that no
/// roll of the seed destroys anything.
pub fn restore_panel(root: &Path, name: &str, panel: &str, kept: &Path) -> Result<()> {
    let dir = project_dir(root, name)?;
    let panels = dir.join("panels");
    if !valid_name(panel) {
        anyhow::bail!("\"{panel}\" is not a panel id");
    }
    // The file has to be one of THIS comic's kept attempts. A path from the
    // webview is not a licence to copy anything on the disk over a panel.
    let history = panels.join("history");
    let kept = kept.canonicalize().context("that attempt is no longer on disk")?;
    let history = history.canonicalize().context("this comic has no kept attempts")?;
    if !kept.starts_with(&history) {
        anyhow::bail!("that file is not one of this comic's kept attempts");
    }
    let png = panels.join(format!("{panel}.png"));
    let sidecar = panels.join(format!("{panel}.json"));
    if png.is_file() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = std::fs::copy(&png, history.join(format!("{panel}-restored-{stamp}.png")));
    }
    std::fs::copy(&kept, &png).context("could not put that attempt back")?;
    // Its sidecar too, so the panel says what actually drew it and 
    // can tell you it is now out of date.
    let kept_sidecar = kept.with_extension("json");
    if kept_sidecar.is_file() {
        let _ = std::fs::copy(&kept_sidecar, &sidecar);
    }
    Ok(())
}

const STAGES: [&str; 5] = ["script", "panels", "qa", "assemble", "all"];

/// Start a stage on a background thread. Returns at once; `status` follows it.
pub fn start(
    runner: &'static Runner,
    cli: &Path,
    repo_root: &Path,
    root: &Path,
    name: &str,
    options: &ComicRunOptions,
) -> Result<()> {
    if !STAGES.contains(&options.stage.as_str()) {
        anyhow::bail!("\"{}\" is not a stage; one of {}", options.stage, STAGES.join(", "));
    }
    let dir = project_dir(root, name)?;
    if !dir.is_dir() {
        anyhow::bail!("there is no comic called \"{name}\"");
    }

    let mut command = client(cli, repo_root);
    command.arg(&options.stage).arg(&dir).arg("--json");
    if let Some(page) = options.page {
        command.arg("--page").arg(page.to_string());
    }
    if let Some(panel) = &options.panel {
        command.arg("--panel").arg(panel);
    }
    if let Some(seed) = options.seed {
        command.arg("--seed").arg(seed.to_string());
    }
    if let Some(attempt) = options.attempt {
        command.arg("--attempt").arg(attempt.to_string());
    }
    if options.force {
        command.arg("--force");
    }
    if options.no_tagger {
        command.arg("--no-tagger");
    }

    {
        let mut guard = runner.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(guard.as_ref(), Some(run) if !run.finished) {
            anyhow::bail!("a comic stage is already running; wait for it or cancel it");
        }
        let mut child = command.spawn().context("could not start node — is it on PATH?")?;
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        *guard = Some(Run {
            comic: name.to_string(),
            stage: options.stage.clone(),
            events: Vec::new(),
            child: Some(child),
            finished: false,
            error: None,
        });
        drop(guard);

        // stderr on its own thread: the CLI writes human notes there, and a
        // full pipe would block the process on the words nobody is reading.
        let stderr_lines = std::thread::spawn(move || {
            BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
                .filter(|l| !l.trim().is_empty())
                .collect::<Vec<String>>()
        });

        std::thread::spawn(move || {
            let mut seq = 0_i64;
            let mut failed: Option<String> = None;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Some(mut event) = parse_event(&line) else { continue };
                event.seq = seq;
                seq += 1;
                if event.event == "stage" && event.status.as_deref() == Some("failed") {
                    failed = event.message.clone().or(Some("the stage failed".to_string()));
                }
                runner.push(event);
            }
            let stderr = stderr_lines.join().unwrap_or_default();
            let status = {
                let mut guard = runner.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.as_mut().and_then(|run| run.child.as_mut()).map(|child| child.wait())
            };
            let ok = matches!(status, Some(Ok(s)) if s.success());
            let error = if ok {
                None
            } else {
                failed.or_else(|| {
                    let keep = stderr.len().saturating_sub(6);
                    let tail = stderr[keep..].join("\n");
                    Some(if tail.is_empty() { "the stage stopped without saying why".to_string() } else { tail })
                })
            };
            runner.finish(error);
        });
    }
    Ok(())
}

/// One JSON line from the CLI, or nothing for a line that is not one — Node
/// itself prints warnings on stdout on some versions.
pub fn parse_event(line: &str) -> Option<ComicEvent> {
    let text = line.trim();
    if !text.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let s = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let n = |key: &str| value.get(key).and_then(|v| v.as_i64());
    let f = |key: &str| value.get(key).and_then(|v| v.as_f64());
    Some(ComicEvent {
        seq: 0,
        event: s("event")?,
        stage: s("stage"),
        id: s("id"),
        status: s("status"),
        progress: f("progress"),
        eta: f("eta"),
        seed: n("seed"),
        attempt: n("attempt"),
        page: n("page"),
        path: s("path"),
        kind: s("kind"),
        message: s("message"),
        failures: value
            .get("failures")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_a_folder_name_and_nothing_else() {
        assert!(valid_name("first-light"));
        assert!(valid_name("ari_02"));
        assert!(!valid_name(""));
        assert!(!valid_name("../escape"));
        assert!(!valid_name("First Light"));
        assert!(!valid_name("a/b"));
    }

    #[test]
    fn events_are_read_off_json_lines_and_nothing_else() {
        assert!(parse_event("(node:1) ExperimentalWarning: stripping types").is_none());
        let event = parse_event(r#"{"event":"panel","id":"p1-2","status":"rendering","progress":0.5,"seed":8822,"attempt":1}"#)
            .expect("a panel event");
        assert_eq!(event.event, "panel");
        assert_eq!(event.id.as_deref(), Some("p1-2"));
        assert_eq!(event.progress, Some(0.5));
        assert_eq!(event.seed, Some(8822));
        let qa = parse_event(r#"{"event":"qa","id":"p1-3","status":"failed","failures":["blank: no picture"]}"#).unwrap();
        assert_eq!(qa.failures.as_deref(), Some(&["blank: no picture".to_string()][..]));
    }

    #[test]
    fn a_project_round_trips_through_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let made = create(root, "first-light").unwrap();
        assert!(made.has_prose && !made.has_script);
        assert!(create(root, "first-light").is_err(), "no overwriting");

        let script = serde_json::json!({
            "title": "First Light",
            "characters": {},
            "pages": [{ "layout": "two-stack", "panels": [{ "id": "p1-1" }, { "id": "p1-2" }] }]
        });
        save(root, "first-light", Some("A story.".to_string()), Some(script)).unwrap();
        std::fs::create_dir_all(root.join("first-light").join("panels")).unwrap();
        std::fs::write(root.join("first-light").join("panels").join("p1-1.png"), b"png").unwrap();
        std::fs::write(
            root.join("first-light").join("panels").join("p1-1.json"),
            r#"{"seed":8812,"attempt":0,"request":{"prompt":"masterpiece"}}"#,
        )
        .unwrap();

        let project = read(root, "first-light").unwrap();
        assert_eq!(project.prose, "A story.");
        assert_eq!(project.panels.len(), 2);
        assert_eq!(project.panels[0].seed, Some(8812));
        assert_eq!(project.panels[0].prompt.as_deref(), Some("masterpiece"));
        assert!(project.panels[0].path.is_some());
        assert!(project.panels[1].path.is_none());

        let listed = list(root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title.as_deref(), Some("First Light"));
        assert_eq!((listed[0].pages, listed[0].panels, listed[0].rendered), (1, 2, 1));
    }

    #[test]
    fn a_runner_with_nothing_running_says_so() {
        let runner = Runner::default();
        let status = runner.status(0);
        assert!(!status.running && !status.finished && status.events.is_empty());
        assert!(!runner.cancel());
    }
}
