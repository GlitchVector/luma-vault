//! Posting a selection to Patreon, as a draft, by way of the Node client.
//!
//! This is the one integration that cannot live in Rust. Every call the client
//! makes was captured from the site's own editor and is issued with a saved
//! cookie jar, and the create step — a page navigation rather than an API call
//! — is Cloudflare-challenged from anything that is not a real browser. The
//! client already knows all of that, so this module does not learn it again:
//! it hands the client a job and reads what comes back. The same shape the
//! classifier and the upscaler use for Python.
//!
//! What crosses from here to there is a **job file**: absolute paths in post
//! order, the title, the body, the access rule, the adult flag, and where to
//! keep the resume state. The webview never names a path — ids are resolved
//! out of the index here, which is the same rule `deviantart.rs` follows.
//!
//! The state file goes in the app's own data directory rather than beside the
//! pictures. A set lives inside a watched folder, and writing `.state.json`
//! next to it would have the app's own watcher index a file the app is
//! writing.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter};

use crate::db::Db;
use crate::types::{PatreonAccessRule, PatreonProgress, PatreonRequest, PatreonSummary};

pub const PROGRESS_EVENT: &str = "luma://patreon";

/// The client's entry point, in a dev tree or a bundle.
///
/// Mirrors `upscaler::resolve`: the repo root during development, the resource
/// directory once packaged. `None` means the harness is not there, which the
/// command reports as a setup step rather than a failure.
pub fn resolve(repo_root: &Path, resource_dir: Option<&Path>) -> Option<PathBuf> {
    for base in [Some(repo_root), resource_dir].into_iter().flatten() {
        let cli = base
            .join("packages")
            .join("patreon-harness")
            .join("src")
            .join("cli.ts");
        if cli.is_file() {
            return Some(cli);
        }
    }
    None
}

/// Where jobs and their resume state live. Under app data, never beside media.
pub fn job_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("patreon")
}

/// The command line every call into the client starts from.
///
/// `.env` at the repo root carries PATREON_CAMPAIGN_ID; the harness's own
/// script does the same relative to its package. INIT_CWD is what the CLI
/// resolves relative paths against; every path handed over here is absolute,
/// but the harness also opens its own cookie jar relative to itself, so its
/// working directory has to be its package.
fn client(cli: &Path, repo_root: &Path) -> Command {
    let mut command = Command::new("node");
    command
        .arg(format!(
            "--env-file-if-exists={}",
            repo_root.join(".env").to_string_lossy()
        ))
        .arg("--experimental-strip-types")
        .arg(cli)
        .current_dir(cli.parent().and_then(Path::parent).unwrap_or(repo_root))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// The campaign's access rules — public, paid members, each tier — read
/// through the client so the panel can offer names rather than ids.
///
/// Blocking, for a few seconds: one campaign read on the cookie jar. Nothing
/// is written to the campaign; a failure is the client's own sentence.
pub fn tiers(cli: &Path, repo_root: &Path) -> Result<Vec<PatreonAccessRule>> {
    let output = client(cli, repo_root)
        .arg("tiers")
        .arg("--json")
        .output()
        .context("could not start node — is it on PATH?")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().filter(|line| !line.trim().is_empty()).collect();
        let keep = tail.len().saturating_sub(6);
        anyhow::bail!("{}", tail[keep..].join("\n"));
    }
    rules_from_output(&String::from_utf8_lossy(&output.stdout))
}

/// The rules in what `tiers --json` printed: its last line is the campaign.
///
/// Only the last line, because Node itself may print warnings first —
/// `--experimental-strip-types` did, on the version that introduced it.
pub fn rules_from_output(stdout: &str) -> Result<Vec<PatreonAccessRule>> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Campaign {
        access_rules: Vec<PatreonAccessRule>,
    }
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .context("the Patreon client printed no campaign")?;
    let campaign: Campaign = serde_json::from_str(line).context("the campaign the client printed did not parse")?;
    Ok(campaign.access_rules)
}

/// What the client is told. Written as JSON; the client's `loadJob` validates
/// it, so this is deliberately not a struct the two sides share — the client's
/// schema is the contract and this is one producer of it.
#[derive(serde::Serialize)]
struct Job<'a> {
    version: u8,
    title: &'a str,
    body: &'a str,
    media: Vec<String>,
    access: &'a str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tiers: Vec<String>,
    adult: bool,
    #[serde(rename = "stateFile")]
    state_file: String,
}

/// Run one post.
///
/// Blocking: the caller runs it off the main thread. Every line the client
/// prints becomes a progress event, so the panel shows the same words the
/// terminal would — "upload 03.png (2.1 MB)", "wait until 03.png is usable" —
/// rather than a second vocabulary for the same steps.
///
/// Per-file failures never reach here; the client resumes from `.state.json`.
/// What can fail is the run as a whole, and that comes back as `error` on the
/// summary rather than as an `Err`, so the panel can show the client's own
/// sentence for it.
pub fn post(
    app: &AppHandle,
    db: &Db,
    cli: &Path,
    repo_root: &Path,
    data_dir: &Path,
    request: &PatreonRequest,
) -> Result<PatreonSummary> {
    // Ids to paths, here and not in the webview. A row that has gone since the
    // panel opened is reported, not silently dropped: the post the person
    // reviewed is not the post that would go up.
    let mut items: Vec<crate::types::MediaItem> = Vec::with_capacity(request.ids.len());
    for id in &request.ids {
        match db.media_by_id(*id)? {
            Some(item) => items.push(item),
            None => {
                return Ok(PatreonSummary {
                    url: None,
                    post_id: None,
                    uploaded: 0,
                    reused: 0,
                    error: Some(format!("picture {id} is no longer in the library")),
                    log: Vec::new(),
                })
            }
        }
    }

    let media: Vec<String> = items.iter().map(|item| item.path.clone()).collect();

    let dir = job_dir(data_dir);
    std::fs::create_dir_all(&dir).context("could not create the Patreon job directory")?;
    let stamp = chrono_free_stamp();
    let job_path = dir.join(format!("{stamp}.job.json"));
    let state_path = dir.join(format!("{stamp}.state.json"));

    let job = Job {
        version: 1,
        title: &request.title,
        body: &request.body,
        media: media.clone(),
        access: if request.tiers.is_empty() { "public" } else { "tier" },
        tiers: request.tiers.clone(),
        adult: request.adult,
        state_file: state_path.to_string_lossy().to_string(),
    };
    std::fs::write(&job_path, serde_json::to_vec_pretty(&job)?)
        .with_context(|| format!("could not write {}", job_path.display()))?;

    let mut child = client(cli, repo_root)
        .arg("post")
        .arg("--job")
        .arg(&job_path)
        .spawn()
        .context("could not start node — is it on PATH?")?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    let mut summary = PatreonSummary::default();
    let total = media.len() as i64;
    let mut done = 0_i64;

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let text = line.trim().to_string();
        if text.is_empty() {
            continue;
        }
        summary.log.push(text.clone());

        // The client's own progress vocabulary, read rather than restated.
        if text.starts_with("upload ") || text.starts_with("reuse ") {
            done += 1;
            if text.starts_with("upload ") {
                summary.uploaded += 1;
            } else {
                summary.reused += 1;
            }
        }
        if let Some(rest) = text.strip_prefix("DRAFT: ") {
            summary.url = Some(rest.trim().to_string());
            summary.post_id = rest
                .split("/posts/")
                .nth(1)
                .and_then(|tail| tail.split(['/', '?']).next())
                .map(str::to_string);
        }

        let _ = app.emit(
            PROGRESS_EVENT,
            PatreonProgress {
                phase: phase_of(&text),
                done: done.min(total),
                total,
                line: text,
            },
        );
    }

    let status = child.wait().context("waiting for the Patreon client")?;
    if !status.success() && summary.url.is_none() {
        // The client prints its errors as sentences, on stderr, without a
        // stack. Take the last few lines: that is where the sentence is.
        let tail: Vec<String> = BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
            .filter(|line| !line.trim().is_empty())
            .collect();
        let keep = tail.len().saturating_sub(6);
        summary.error = Some(tail[keep..].join("\n"));
    }

    if let (Some(post_id), Some(url)) = (&summary.post_id, &summary.url) {
        // Recorded once, for every path, at the end: a post is one thing, and
        // the badge must not show a set as half-posted.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let _ = db.record_patreon_post(&paths_to_record(&items), post_id, url, now);
    }

    let _ = app.emit(
        PROGRESS_EVENT,
        PatreonProgress {
            phase: "done".to_string(),
            done: total,
            total,
            line: summary
                .url
                .clone()
                .unwrap_or_else(|| summary.error.clone().unwrap_or_default()),
        },
    );

    Ok(summary)
}

/// The paths a draft is recorded against: each posted file, and the original
/// behind any 4K variant among them.
///
/// The grid shows originals and hides their 4K variants, and the panel swaps
/// each original for its variant before posting — so the file that actually
/// went up is the one the grid never draws. A badge on it alone would never be
/// seen. Marking the original too is what makes "have I posted this one?"
/// answerable on the tile a person is looking at.
pub fn paths_to_record(items: &[crate::types::MediaItem]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::with_capacity(items.len() * 2);
    for item in items {
        paths.push(item.path.clone());
        if let Some(original) = &item.upscaled_from {
            if !paths.contains(original) {
                paths.push(original.clone());
            }
        }
    }
    paths
}

/// Which step a client line belongs to, for the panel's status word.
fn phase_of(line: &str) -> String {
    let word = line.split_whitespace().next().unwrap_or("");
    match word {
        "campaign" => "checking",
        "draft" | "resume" => "creating",
        "upload" | "reuse" | "wait" => "uploading",
        "configure" => "configuring",
        "DRAFT:" => "done",
        _ => "running",
    }
    .to_string()
}

/// A sortable, filesystem-safe timestamp without pulling in a date crate for
/// one call site. Millisecond resolution is enough to keep two posts apart.
fn chrono_free_stamp() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_is_found_in_a_dev_tree() {
        let dir = std::env::temp_dir().join(format!("luma-patreon-resolve-{}", std::process::id()));
        let cli = dir.join("packages/patreon-harness/src/cli.ts");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, "// cli").unwrap();
        assert_eq!(resolve(&dir, None), Some(cli));
        assert!(resolve(Path::new("/nowhere"), Some(&dir)).is_some());
        assert_eq!(resolve(Path::new("/nowhere"), None), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_line_is_read_as_the_phase_the_client_is_in() {
        assert_eq!(phase_of("upload 01.png (0.0 MB)"), "uploading");
        assert_eq!(phase_of("reuse  01.png -> 746006320"), "uploading");
        assert_eq!(phase_of("draft  169663723"), "creating");
        assert_eq!(phase_of("configure 2 media, access public"), "configuring");
        assert_eq!(phase_of("DRAFT: https://www.patreon.com/posts/1/edit"), "done");
    }

    #[test]
    fn the_rules_are_read_off_the_last_line_the_client_printed() {
        let stdout = "(node:1) ExperimentalWarning: Type Stripping is an experimental feature\n\
            {\"id\":\"16736888\",\"name\":\"jebaz\",\"isNsfw\":true,\"accessRules\":[\
            {\"id\":\"68432072\",\"type\":\"public\",\"title\":null,\"amountCents\":null,\"currency\":null},\
            {\"id\":\"68475917\",\"type\":\"tier\",\"title\":\"Supporter\",\"amountCents\":1000,\"currency\":\"USD\"}]}\n";
        let rules = rules_from_output(stdout).expect("parses");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].kind, "public");
        assert_eq!(rules[1].title.as_deref(), Some("Supporter"));
        assert_eq!(rules[1].amount_cents, Some(1000));
    }

    #[test]
    fn no_campaign_line_is_an_error_not_an_empty_list() {
        // An empty list would render as "this page has no tiers", which is a
        // different and wrong statement.
        assert!(rules_from_output("warning only\n").is_err());
    }

    #[test]
    fn a_draft_is_recorded_on_the_original_behind_a_posted_4k_variant() {
        let item = |path: &str, from: Option<&str>| crate::types::MediaItem {
            id: 1,
            folder_id: 1,
            path: path.to_string(),
            name: String::new(),
            kind: crate::types::MediaKind::Image,
            width: 3840,
            height: 5616,
            size_bytes: 1,
            modified_at: 1,
            added_at: 1,
            thumb_path: None,
            thumb_width: None,
            thumb_height: None,
            duration_sec: None,
            verdict: None,
            classified_at: None,
            stars: None,
            generation: None,
            dupe_group: None,
            upscaled_from: from.map(str::to_string),
            upscaled_to: None,
            rating_override: None,
            deviant_art: None,
            patreon: None,
        };
        let paths = paths_to_record(&[
            item("/v/a_upscaled_4k.png", Some("/v/a.png")),
            item("/v/b.png", None),
        ]);
        // The variant that went up, its original for the grid's badge, and a
        // plain original once — never twice.
        assert_eq!(paths, vec!["/v/a_upscaled_4k.png", "/v/a.png", "/v/b.png"]);
    }

    #[test]
    fn a_job_names_the_state_file_away_from_the_media() {
        let data = Path::new("/app-data");
        assert_eq!(job_dir(data), PathBuf::from("/app-data/patreon"));
        let job = Job {
            version: 1,
            title: "t",
            body: "b",
            media: vec!["/vault/a.png".into()],
            access: "public",
            tiers: Vec::new(),
            adult: true,
            state_file: "/app-data/patreon/1.state.json".into(),
        };
        let json = serde_json::to_string(&job).unwrap();
        assert!(json.contains("\"stateFile\":\"/app-data/patreon/1.state.json\""));
        assert!(!json.contains("\"tiers\""), "an empty tiers list is omitted, as the client's schema allows");
    }
}
