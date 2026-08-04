//! Application wiring: state, commands, protocol, watcher.
//!
//! # Command conventions
//!
//! - Every command takes at most one `request` struct and returns a type that
//!   has a zod twin, a `/contracts` fixture and a round-trip test.
//! - Every command that touches the filesystem or the index is
//!   `#[tauri::command(async)]`. A synchronous command runs on the **main
//!   thread**, so a query against a 200,000-row index — or worse, a `stat` on
//!   an unreachable network share — freezes the window.
//! - Errors are returned as `String`, because that is what crosses the IPC
//!   boundary; the message is written for a person reading a toast.

mod classifier;
mod db;
mod dupes;
mod generated;
pub mod imports;
mod paths;
mod pipeline;
mod protocol;
mod rating;
mod sampling;
mod scan;
mod throttle;
mod thumbs;
mod types;
mod upscaler;
mod upscales;
mod video;
mod watcher;

#[cfg(test)]
mod contract_tests;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, State};

use crate::db::Db;
use crate::pipeline::Pipeline;
use crate::protocol::ProtocolRoots;
use crate::types::{Folder, LibraryStats, MediaFrame, MediaItem, MediaPage, MediaQuery, ScanProgress};
use crate::watcher::FolderWatcher;

pub struct AppState {
    db: Arc<Db>,
    pipeline: Arc<Pipeline>,
    watcher: Arc<FolderWatcher>,
    /// Interpreter and script, resolved once at startup. `None` when the venv
    /// has not been built, which the command reports as a setup step rather
    /// than a failure.
    upscaler: Option<(PathBuf, PathBuf)>,
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    state.db.list_folders().map_err(stringify)
}

/// Add a folder and immediately start scanning it.
///
/// The scan runs on its own thread and reports through the progress event, so
/// this returns as soon as the row exists — the UI shows the new folder with a
/// running scan rather than a spinner on a blocked command.
#[tauri::command(async)]
async fn add_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Folder, String> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_dir() {
        return Err(format!("{path} is not a folder"));
    }

    // Canonicalize so adding `/Volumes/vault/pics` and `/Volumes/vault/./pics`
    // cannot produce two rows for one folder.
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("cannot open {path}: {error}"))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    let id = state
        .db
        .add_folder(&canonical_str, pipeline::now_ms())
        .map_err(stringify)?;

    state.watcher.watch(&canonical);

    let pipeline = Arc::clone(&state.pipeline);
    let handle = app.clone();
    std::thread::spawn(move || pipeline::run_scan(pipeline, handle, id, canonical));

    state
        .db
        .list_folders()
        .map_err(stringify)?
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or_else(|| "the folder disappeared immediately after being added".to_string())
}

#[tauri::command(async)]
async fn remove_folder(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let folders = state.db.list_folders().map_err(stringify)?;
    if let Some(folder) = folders.iter().find(|folder| folder.id == id) {
        state.watcher.unwatch(&PathBuf::from(&folder.path));
    }
    state.db.remove_folder(id).map_err(stringify)
}

/// Re-walk a folder. Cheap when nothing changed: existing rows are left alone,
/// so a rescan of an unchanged library is a walk plus a few thousand no-op
/// inserts.
#[tauri::command(async)]
async fn rescan_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let folders = state.db.list_folders().map_err(stringify)?;
    let folder = folders
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or_else(|| "no such folder".to_string())?;

    let pipeline = Arc::clone(&state.pipeline);
    let handle = app.clone();
    let root = PathBuf::from(folder.path);
    std::thread::spawn(move || pipeline::run_scan(pipeline, handle, id, root));
    Ok(())
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn query_media(state: State<'_, AppState>, query: MediaQuery) -> Result<MediaPage, String> {
    state.db.query_media(&query).map_err(stringify)
}

#[tauri::command(async)]
async fn recent_media(state: State<'_, AppState>, limit: i64) -> Result<Vec<MediaItem>, String> {
    state.db.recent_media(limit.clamp(1, 200)).map_err(stringify)
}

#[tauri::command(async)]
async fn media_frames(state: State<'_, AppState>, media_id: i64) -> Result<Vec<MediaFrame>, String> {
    state.db.frames_for_media(media_id).map_err(stringify)
}

/// One item by id — the detail view re-reads rather than trusting the copy it
/// was handed, so a lightbox opened before classification finished shows the
/// verdict once it lands.
#[tauri::command(async)]
async fn media_by_id(state: State<'_, AppState>, id: i64) -> Result<Option<MediaItem>, String> {
    state.db.media_by_id(id).map_err(stringify)
}

/// One row by path, for a picture no list contains.
///
/// The grid hides an original once an upscaled variant of it exists, so there
/// is no id to hand for it anywhere in the UI — only the path its variant
/// carries.
#[tauri::command(async)]
async fn media_by_path(state: State<'_, AppState>, path: String) -> Result<Option<MediaItem>, String> {
    state.db.media_by_path(&path).map_err(stringify)
}

/// Upscale a selection, writing each result beside its source.
///
/// Blocking for the caller, deliberately: a batch is minutes of GPU work and the
/// UI needs a result to show, so this awaits the run and reports progress
/// through `luma://upscale` while it goes. It is `async`, so it does not hold
/// the main thread.
#[tauri::command(async)]
async fn upscale_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    long_edge: Option<i64>,
) -> Result<upscaler::UpscaleSummary, String> {
    if ids.is_empty() {
        return Err("nothing selected".to_string());
    }

    let long_edge = long_edge.unwrap_or(3840);

    // Resolved here rather than trusting paths from the frontend: the webview
    // must never be able to name an arbitrary file for a process to write next
    // to. Videos are dropped — the upscaler reads still images.
    //
    // So is anything already at or past the target. "Upscale to 4K" means
    // nothing for a picture that is 4K, and running it anyway is not merely
    // wasteful: the model produces 15360px, the mandatory downscale brings it
    // straight back to the size it started at, and the near-identical copy then
    // *hides its own source* in the grid. Ten seconds of GPU to replace a
    // picture with itself. Selecting an already-upscaled variant is the same
    // case — it is 3840 by construction — which is what stops a second pass
    // producing `x_upscaled_4k_upscaled_4k.png`.
    let mut sources = Vec::new();
    let mut already_large = 0_i64;
    for id in &ids {
        if let Ok(Some(item)) = state.db.media_by_id(*id) {
            if item.kind != types::MediaKind::Image {
                continue;
            }
            if item.width.max(item.height) >= long_edge {
                already_large += 1;
                continue;
            }
            sources.push(item.path);
        }
    }
    if sources.is_empty() {
        return Err(if already_large > 0 {
            format!(
                "nothing to do: {already_large} of the selected file(s) already reach {long_edge}px"
            )
        } else {
            "none of the selected files is an image".to_string()
        });
    }

    // Checked here as well as in the UI. The button polls every couple of
    // seconds, so a click can land in the gap after a generation started — and
    // a gate that a race walks through is not one. Unreachable means Forge is
    // not running, which is not a reason to refuse.
    if let Ok(status) = forge_status(state.clone()).await {
        if status.busy {
            return Err(match status.job {
                Some(job) => format!("Forge is generating ({job}). Both want the whole GPU."),
                None => "Forge is generating. Both want the whole GPU.".to_string(),
            });
        }
    }

    let (python, script) = state
        .upscaler
        .clone()
        .ok_or_else(|| "the upscaler is not installed. Run `pnpm setup:upscaler`.".to_string())?;

    let configured = state.db.setting("upscale_model").ok().flatten();
    let model = upscaler::find_models(configured.as_deref())
        .into_iter()
        .next()
        .ok_or_else(|| {
            "no upscale model found. Put a .pth in the webui's models/ESRGAN folder, or set one."
                .to_string()
        })?;

    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let mut summary = upscaler::run(&app, &python, &script, &model, &sources, long_edge)?;
        summary.already_large = already_large;

        // Indexed here rather than left to the watcher. The watcher does see
        // these files, but on its own schedule — so closing the results panel
        // showed the originals still in place and the swap happened some seconds
        // later, which reads as the grid rearranging itself for no reason. Doing
        // it before returning means the reload the UI runs next already sees the
        // finished state.
        for output in &summary.outputs {
            let Ok(Some(original)) = db.media_by_path(&output.source) else {
                continue;
            };
            let Ok(metadata) = std::fs::metadata(&output.destination) else {
                continue;
            };
            let name = std::path::Path::new(&output.destination)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| output.name.clone());
            let entry = db::ScannedFile {
                path: output.destination.clone(),
                name,
                kind: types::MediaKind::Image,
                size_bytes: metadata.len() as i64,
                // The original's, so the variant sorts where the picture it
                // replaces did. `insert_media_batch` re-applies this from the
                // row anyway; passing it here keeps the two agreeing even if the
                // original has not been thumbnailed yet.
                modified_at: original.modified_at,
            };
            let _ = db.insert_media_batch(original.folder_id, &[entry], pipeline::now_ms());

            // The size, from the run that just produced it. Without this the
            // row sits at 0x0 until the measure phase happens to reach it, and
            // three things read wrong in the meantime: no 4K badge, `—` for the
            // resolution, and no zoom at all — the lightbox computes its box
            // from these and silently falls back to a fixed view when it
            // cannot. Nothing kicks the pipeline after an upscale, so "in the
            // meantime" is until the next scan.
            //
            // Measuring again would be a decode of a 12MB file to learn a
            // number the upscaler already reported. `None` for the content key
            // leaves the one inherited from the original in place, which is
            // what the shared thumbnail is addressed by.
            if let Ok(Some(row)) = db.media_by_path(&output.destination) {
                let _ = db.update_dimensions(
                    row.id,
                    output.final_width,
                    output.final_height,
                    None,
                    None,
                );
            }
        }
        Ok::<_, anyhow::Error>(summary)
    })
    .await
    .map_err(|error| format!("the upscale task panicked: {error}"))?
    .map_err(|error| format!("{error:#}"))
}

/// A person's judgement, 1-5, or `None` to clear it.
///
/// Deliberately not reachable from the pipeline: every other rating in this app
/// is produced by a model, and conflating the two would mean a re-classify
/// could silently overwrite what someone actually thought of a picture.
#[tauri::command(async)]
async fn set_stars(state: State<'_, AppState>, id: i64, stars: Option<i64>) -> Result<(), String> {
    state.db.set_stars(id, stars).map_err(stringify)
}

/// Import 1-5 star ratings from a Stable Diffusion Image Browser database.
///
/// Staged rather than applied directly, so importing before scanning the
/// folder it describes is the expected order rather than a mistake.
#[tauri::command(async)]
async fn import_image_browser_db(
    state: State<'_, AppState>,
    path: String,
) -> Result<imports::ImportSummary, String> {
    imports::import_image_browser(&state.db, Path::new(&path), pipeline::now_ms())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command(async)]
async fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    state.db.stats().map_err(stringify)
}

/// Show a file in the OS file manager.
///
/// Goes through Rust rather than calling the opener plugin from the webview,
/// because the index stores canonicalized paths and the Windows shell cannot
/// resolve the extended-length form — `Shell.NameSpace` on a `\\?\UNC\` path
/// returns nothing, so the button silently did nothing. Normalising here keeps
/// that knowledge in one place instead of teaching the frontend about Windows
/// path spellings.
///
/// It also gives the failure somewhere to go: the plugin called from JS had its
/// rejection dropped on the floor.
#[tauri::command(async)]
async fn reveal_item(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let target = crate::paths::external_path(&path);
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|error| format!("cannot reveal {target}: {error}"))
}

/// Open a URL in the user's browser.
///
/// Scheme-checked rather than passed straight to the shell. `opener` hands the
/// string to the OS, which on Windows will happily act on `file:` — so an
/// unvalidated argument here is a way to launch things, not just browse. Only
/// `http` and `https` reach it.
#[tauri::command(async)]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let parsed = url::Url::parse(&url).map_err(|error| format!("not a URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refusing to open a {} URL", parsed.scheme()));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("cannot open {url}: {error}"))
}

/// Delete a file and drop its row.
///
/// **The Recycle Bin wherever there is one.** Deleting is the one action in
/// this app that cannot be undone by rescanning, and a media library is exactly
/// where someone deletes the wrong thing while moving quickly. The bin turns
/// that from a loss into an annoyance, and costs nothing.
///
/// On a network share there is no bin — which is every file in this library, so
/// it is the normal case rather than the exception. There the deletion is
/// permanent, and `permanent` has to say so: the flag is the caller confirming
/// it asked the question that way round, so a UI promising the bin can never
/// destroy a file by accident. It is ignored where a bin exists.
///
/// Only ever a path that is already a row in the index — the caller passes an
/// id, never a path — so this cannot be aimed at an arbitrary file by anything
/// that reaches the command.
///
/// The row is removed here rather than left to the watcher. The watcher does
/// notice, and did so reliably over 4,686 deletions today, but a grid that
/// still shows a file you just deleted for however long the event takes reads
/// as the button not working.
#[tauri::command(async)]
async fn delete_item(state: State<'_, AppState>, id: i64, permanent: bool) -> Result<(), String> {
    // Both halves of an upscale pair, if this is one — see `with_counterparts`.
    // The original behind a variant is reachable only *through* that variant,
    // so deleting the variant alone would strand it.
    let rows = with_counterparts(&state.db, &[id]);
    if rows.is_empty() {
        return Err("that file is no longer in the library".to_string());
    }
    for item in rows {
        delete_one(&state, &item, permanent)?;
    }
    Ok(())
}

fn delete_one(state: &State<'_, AppState>, item: &MediaItem, permanent: bool) -> Result<(), String> {
    // The extended-length form the index stores is fine for `std::fs`, but the
    // shell APIs behind the bin cannot resolve it — the same prefix that broke
    // ffmpeg, Explorer and SQLite. See `paths::external_path`.
    let target = crate::paths::external_path(&item.path);

    if crate::paths::has_recycle_bin(&target) {
        trash::delete(&target).map_err(|error| format!("cannot delete {target}: {error}"))?;
    } else if permanent {
        // `std::fs`, not the shell. The shell would take this path and delete
        // it just as permanently while reporting a *recycle*, and the `trash`
        // crate cannot take it at all: it re-canonicalizes to `\\?\UNC\…` and
        // then strips exactly four characters, leaving `UNC\server\share\…`,
        // which resolves to nothing. That is the 0x80070002 this used to fail
        // with on every single file.
        std::fs::remove_file(&target).map_err(|error| format!("cannot delete {target}: {error}"))?;
    } else {
        return Err(format!(
            "{target} is on a network drive, which has no Recycle Bin — deleting it there is permanent"
        ));
    }

    state.db.delete_media_by_path(&item.path).map_err(stringify)?;
    Ok(())
}

/// Every row a delete of these ids should actually remove.
///
/// An upscale pair is one picture kept as two files, and the grid already
/// presents it that way — the variant stands in for the original and the
/// original is not shown at all. Deleting one and silently keeping the other
/// would leave a file nothing in the app can reach: the original is only
/// reachable *through* its variant, so removing the variant alone orphans it
/// forever. So a delete takes both, in whichever direction it was asked.
///
/// Deduplicated by path, because selecting a variant and then also reaching its
/// original through the lightbox would otherwise queue the same file twice.
fn with_counterparts(db: &Db, ids: &[i64]) -> Vec<MediaItem> {
    let mut rows: Vec<MediaItem> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for id in ids {
        let Ok(Some(item)) = db.media_by_id(*id) else {
            continue;
        };
        let partner = item
            .upscaled_from
            .clone()
            .or_else(|| item.upscaled_to.clone())
            .and_then(|path| db.media_by_path(&path).ok().flatten());

        for row in [Some(item), partner].into_iter().flatten() {
            if seen.insert(row.path.clone()) {
                rows.push(row);
            }
        }
    }
    rows
}

/// Delete many files, reporting how many went and what refused.
///
/// One command rather than a call per id: a selection can be hundreds, and that
/// many IPC round trips is both slow and impossible to report on sensibly. One
/// failure does not stop the rest — a file that vanished under you must not
/// cost the other ninety-nine their deletion.
#[tauri::command(async)]
async fn delete_media(
    state: State<'_, AppState>,
    ids: Vec<i64>,
    permanent: bool,
) -> Result<DeleteSummary, String> {
    let mut summary = DeleteSummary::default();
    let rows = with_counterparts(&state.db, &ids);
    summary.missing = ids.len() as i64 - rows.iter().filter(|r| ids.contains(&r.id)).count() as i64;

    for item in rows {
        let target = crate::paths::external_path(&item.path);

        let outcome = if crate::paths::has_recycle_bin(&target) {
            trash::delete(&target).map_err(|error| format!("{}: {error}", item.name))
        } else if permanent {
            std::fs::remove_file(&target).map_err(|error| format!("{}: {error}", item.name))
        } else {
            Err(format!(
                "{}: on a network drive, where deleting is permanent",
                item.name
            ))
        };

        match outcome {
            Ok(()) => {
                let _ = state.db.delete_media_by_path(&item.path);
                summary.deleted += 1;
            }
            Err(message) => {
                summary.failed += 1;
                // Capped: a hundred identical permission errors is not a more
                // useful message than five, and the dialog has to stay readable.
                if summary.errors.len() < 5 {
                    summary.errors.push(message);
                }
            }
        }
    }
    Ok(summary)
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSummary {
    pub deleted: i64,
    /// Already gone from the index — nothing to do, and not a failure.
    pub missing: i64,
    pub failed: i64,
    pub errors: Vec<String>,
}

/// The verbatim parameter block a file records, for handing back to Forge.
///
/// Read from the file on demand rather than stored: with ControlNet and two
/// ADetailer passes a real block runs to 2,656 bytes, and keeping that for
/// 65,000 images would add ~170MB to an index that is meant to be a cache.
///
/// The parsed `generation` on a `MediaItem` is for *display*. Rebuilding a
/// block out of it loses schedule type, clip skip, denoising strength,
/// ControlNet units and every ADetailer setting — so the regenerated image
/// comes out different. Forge's own parser understands all of it.
#[tauri::command(async)]
async fn generation_parameters(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<String>, String> {
    let Some(item) = state.db.media_by_id(id).map_err(stringify)? else {
        return Ok(None);
    };
    Ok(generated::read_parameter_block(Path::new(&item.path)))
}

/// Where the local Stable Diffusion UI answers. Remembered between launches.
#[tauri::command(async)]
async fn forge_url(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .db
        .setting(FORGE_URL_KEY)
        .map_err(stringify)?
        .unwrap_or_else(|| DEFAULT_FORGE_URL.to_string()))
}

#[tauri::command(async)]
async fn set_forge_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    state.db.set_setting(FORGE_URL_KEY, &url).map_err(stringify)
}

/// Select the checkpoint in Forge, before its page is opened.
///
/// **The order is the whole point.** Forge builds its checkpoint dropdown from
/// `value=lambda: shared.opts.sd_model_checkpoint`, evaluated once while the
/// page is being constructed, and nothing pushes later changes back to the
/// browser. So a checkpoint selected *after* the tab opens is genuinely
/// selected — generation uses it — but the dropdown keeps whatever it rendered
/// with, which reads as the button not having worked. Setting it first means
/// the page is built with the right value already in place.
///
/// Best-effort by design: Forge may not be running, may not have the extension
/// installed, or may not have that checkpoint. None of those should stop the
/// tab from opening, because the parameters are on the clipboard regardless.
/// The outcome is returned so the caller can say what happened.
#[tauri::command(async)]
async fn forge_select_checkpoint(
    state: State<'_, AppState>,
    block: String,
) -> Result<Option<String>, String> {
    let Some(model) = crate::generated::checkpoint_of(&block) else {
        return Ok(None);
    };

    let base = state
        .db
        .setting(FORGE_URL_KEY)
        .map_err(stringify)?
        .unwrap_or_else(|| DEFAULT_FORGE_URL.to_string());
    let endpoint = format!("{}/luma/v1/checkpoint", base.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        // Short: this runs between a click and a browser opening, and a Forge
        // that is not answering must not hold that up.
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;

    match client
        .post(&endpoint)
        .json(&serde_json::json!({ "name": model }))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Ok(Some(model)),
        Ok(response) => Err(format!("Forge refused {model}: HTTP {}", response.status())),
        Err(error) => Err(format!("cannot reach Forge at {endpoint}: {error}")),
    }
}

/// Whether Forge is mid-generation, so an upscale can decline to compete.
///
/// Both want the whole GPU. Running them together does not fail — it makes each
/// take roughly twice as long and can push a large batch into swapping, which
/// is worse than either waiting for the other.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStatus {
    /// False when Forge is not running at all, which is not a reason to block.
    pub reachable: bool,
    pub busy: bool,
    /// What it is doing, for the tooltip — "Batch 3 out of 3".
    pub job: Option<String>,
    /// 0.0 to 1.0 through the current job.
    pub progress: f64,
}

#[tauri::command(async)]
async fn forge_status(state: State<'_, AppState>) -> Result<ForgeStatus, String> {
    let base = state
        .db
        .setting(FORGE_URL_KEY)
        .map_err(stringify)?
        .unwrap_or_else(|| DEFAULT_FORGE_URL.to_string());
    let endpoint = format!(
        "{}/sdapi/v1/progress?skip_current_image=true",
        base.trim_end_matches('/')
    );

    let client = reqwest::Client::builder()
        // Very short. This is polled while a selection is open, and a Forge that
        // is wedged must not make the button feel wedged too — unreachable
        // reads as "not busy", which is the safe answer for a gate.
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;

    let unreachable = ForgeStatus {
        reachable: false,
        busy: false,
        job: None,
        progress: 0.0,
    };

    let Ok(response) = client.get(&endpoint).send().await else {
        return Ok(unreachable);
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return Ok(unreachable);
    };

    let job = body["state"]["job"].as_str().unwrap_or_default().to_string();
    let job_count = body["state"]["job_count"].as_i64().unwrap_or(0);
    let progress = body["progress"].as_f64().unwrap_or(0.0);

    Ok(ForgeStatus {
        reachable: true,
        // Any of the three. Forge reports the transition between queued jobs
        // with a zero progress and an empty job name for a moment, and a gate
        // that flickers open there is not a gate.
        busy: job_count > 0 || !job.is_empty() || progress > 0.0,
        job: (!job.is_empty()).then_some(job),
        progress,
    })
}

const FORGE_URL_KEY: &str = "forge_url";
/// Forge's own default. `127.0.0.1` rather than `localhost` because the latter
/// can resolve to IPv6 first and Gradio binds v4.
const DEFAULT_FORGE_URL: &str = "http://127.0.0.1:7860";

/// Clear recorded failures and reprocess them.
///
/// Failures are usually permanent, but not always: an unmounted share or a
/// missing ffmpeg fails everything it touches, and after fixing that the user
/// needs a way to say "try again" short of removing and re-adding the folder.
#[tauri::command(async)]
async fn retry_failed(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder_id: Option<i64>,
) -> Result<usize, String> {
    let cleared = state.db.clear_errors(folder_id).map_err(stringify)?;
    if cleared > 0 {
        let pipeline = Arc::clone(&state.pipeline);
        let handle = app.clone();
        std::thread::spawn(move || pipeline::run_pending(pipeline, handle));
    }
    Ok(cleared)
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/// The current progress, for a UI that mounted mid-scan and missed the events.
#[tauri::command(async)]
async fn scan_progress(state: State<'_, AppState>) -> Result<ScanProgress, String> {
    Ok(state.pipeline.snapshot())
}

#[tauri::command(async)]
async fn process_pending(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let pipeline = Arc::clone(&state.pipeline);
    let handle = app.clone();
    std::thread::spawn(move || pipeline::run_pending(pipeline, handle));
    Ok(())
}

/// Find every picture the library holds more than once.
///
/// Two mechanisms, because the two kinds of file need different questions
/// asked. **Images** are matched perceptually — a hash of the thumbnail, so a
/// re-encode, a re-save or a copy at another resolution still matches; the
/// thumbnail is already normalised to 512px, which is what makes resolution
/// stop mattering. **Videos** are matched on their content key, an exact
/// size-plus-head-and-tail hash the scan already computed, because a
/// re-encoded video is a different video and looking for one is answering a
/// question nobody asked.
#[tauri::command(async)]
async fn find_duplicates(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let hashes = state.db.all_fingerprints().map_err(stringify)?;
    let grouping = dupes::group(&hashes);

    let mut pairs: Vec<(i64, i64)> =
        grouping.groups.iter().map(|(id, group)| (*group, *id)).collect();
    let image_files = pairs.len() as i64;
    let image_groups = grouping.group_count;

    let videos = state.db.video_duplicates().map_err(stringify)?;
    let video_files = videos.len() as i64;
    let video_groups = videos
        .iter()
        .map(|(group, _)| *group)
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    pairs.extend(videos);

    state.db.set_duplicate_groups(&pairs).map_err(stringify)?;

    Ok(serde_json::json!({
        "groups": image_groups + video_groups,
        "files": image_files + video_files,
        "imageGroups": image_groups,
        "videoGroups": video_groups,
        "hashed": hashes.len() as i64,
        // Rows in buckets too large to be anything but blank frames. Reported
        // rather than swallowed, so a silent cap is never mistaken for "none".
        "skippedCommon": grouping.skipped_common as i64,
    }))
}

#[tauri::command(async)]
async fn list_exclusions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.db.excluded_folders().map_err(stringify)
}

/// Stop scanning a folder, and drop what it already contributed.
///
/// Both halves are the point. Excluding only future walks would leave the
/// texture pack you just excluded sitting in the grid until something else
/// happened to prune it, which reads as the setting not working.
///
/// Returns how many rows were removed. Files are never touched — this is an
/// index that can be rebuilt, and the folder on disk is not ours to edit.
#[tauri::command(async)]
async fn exclude_folder(state: State<'_, AppState>, path: String) -> Result<i64, String> {
    state
        .db
        .add_excluded_folder(&path, pipeline::now_ms())
        .map_err(stringify)?;

    let before = state.db.stats().map(|s| s.images + s.videos).unwrap_or(0);
    let keys = state.db.delete_media_under(&path).map_err(stringify)?;
    let after = state.db.stats().map(|s| s.images + s.videos).unwrap_or(0);

    // Derived files outlive their rows deliberately — a thumbnail is addressed
    // by content, so the same key can belong to a copy of the file elsewhere.
    // Only the ones nothing else claims are removed.
    for key in keys {
        if state.db.content_key_is_orphaned(&key).unwrap_or(false) {
            thumbs::forget_derived(
                &state.pipeline.thumb_root(),
                &state.pipeline.frame_root(),
                &key,
            );
        }
    }
    Ok(before - after)
}

/// Scan a folder again after excluding it. Nothing is re-read until the next
/// walk, which the caller triggers.
#[tauri::command(async)]
async fn include_folder(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.db.remove_excluded_folder(&path).map_err(stringify)
}

/// What the environment can actually do, so the UI can explain a missing
/// capability instead of silently producing unrated files.
#[tauri::command(async)]
async fn environment(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "classifierAvailable": state.pipeline.classifier_ready(),
        "ffmpegAvailable": video::available(),
        "busy": state.pipeline.is_busy(),
        "throttle": state.pipeline.throttle().level().as_str(),
    }))
}

/// Cap background work at a share of the machine. See `throttle::ThrottleLevel`.
///
/// Takes effect on the *next* unit of work rather than immediately: a batch
/// already inside the classifier finishes at full speed. Changing the level
/// drops the classifier pool so it comes back at the right size with the right
/// per-worker thread budget — which is the half of the throttle that pacing
/// alone cannot do.
#[tauri::command(async)]
async fn set_throttle(state: State<'_, AppState>, level: String) -> Result<(), String> {
    let level = throttle::ThrottleLevel::parse(&level);
    if state.pipeline.throttle().set(level) {
        state.pipeline.reset_pool();
    }
    video::set_thread_limit(state.pipeline.throttle().process_threads());
    state
        .db
        .set_setting(throttle::SETTING_KEY, level.as_str())
        .map_err(stringify)
}

fn stringify(error: anyhow::Error) -> String {
    format!("{error:#}")
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .expect("the platform always provides an app-data directory");

            let db = Arc::new(Db::open(&data_dir.join("index.db"))?);
            let thumb_root = data_dir.join("thumbs");
            let frame_root = data_dir.join("frames");
            std::fs::create_dir_all(&thumb_root)?;
            std::fs::create_dir_all(&frame_root)?;

            // In development the repo root is two levels up from the crate; in
            // a bundle the sidecar ships as a resource.
            let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|path| path.parent())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            let resource_dir = app.path().resource_dir().ok();

            let python = classifier::resolve_python(&repo_root, resource_dir.as_deref());
            let script = classifier::resolve_script(&repo_root, resource_dir.as_deref());

            if python.is_none() || script.is_none() {
                eprintln!(
                    "[luma] classifier not found — files will be indexed and thumbnailed \
                     but not rated. Run `pnpm setup:python`."
                );
            }

            // Restored before the pipeline starts, so a throttled library
            // resumes throttled rather than pinning the machine for the few
            // seconds it takes the UI to send the setting back.
            let level = db
                .setting(throttle::SETTING_KEY)
                .ok()
                .flatten()
                .map(|value| throttle::ThrottleLevel::parse(&value))
                .unwrap_or(throttle::ThrottleLevel::Off);
            let throttle = Arc::new(throttle::Throttle::new(level));
            video::set_thread_limit(throttle.process_threads());

            let pipeline = Arc::new(Pipeline::new(
                Arc::clone(&db),
                thumb_root.clone(),
                frame_root.clone(),
                python,
                script,
                throttle,
            ));

            let watcher = Arc::new(FolderWatcher::new());
            watcher.start(Arc::clone(&db), Arc::clone(&pipeline), app.handle().clone());

            app.manage(ProtocolRoots {
                db: Arc::clone(&db),
                thumb_root,
                frame_root,
            });
            app.manage(AppState {
                db,
                pipeline: Arc::clone(&pipeline),
                watcher,
                upscaler: upscaler::resolve(&repo_root, resource_dir.as_deref()),
            });

            // Re-walk every folder, then resume anything the last session left
            // unfinished. The pipeline's work queue is a database query, so
            // there is nothing to replay — it simply asks what still has no
            // thumbnail or verdict. The walk is what catches files added or
            // removed while the app was closed, which the watcher cannot see.
            let handle = app.handle().clone();
            std::thread::spawn(move || pipeline::run_startup(pipeline, handle));

            Ok(())
        })
        .register_uri_scheme_protocol(protocol::SCHEME, move |ctx, request| {
            let roots = ctx.app_handle().state::<ProtocolRoots>();
            protocol::handle(&roots, &request)
        })
        .invoke_handler(tauri::generate_handler![
            list_folders,
            add_folder,
            remove_folder,
            rescan_folder,
            query_media,
            recent_media,
            media_frames,
            media_by_id,
            media_by_path,
            upscale_media,
            library_stats,
            set_stars,
            import_image_browser_db,
            retry_failed,
            reveal_item,
            scan_progress,
            process_pending,
            environment,
            set_throttle,
            find_duplicates,
            open_external,
            delete_item,
            delete_media,
            generation_parameters,
            forge_url,
            set_forge_url,
            forge_select_checkpoint,
            forge_status,
            list_exclusions,
            exclude_folder,
            include_folder,
        ])
        .run(tauri::generate_context!())
        .expect("cannot start luma-vault");
}

use std::path::Path;
