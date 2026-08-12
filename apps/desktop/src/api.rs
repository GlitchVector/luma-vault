//! Every operation the app can perform, and one place that runs them by name.
//!
//! The functions here are the real bodies; the `#[tauri::command]` wrappers in
//! `lib.rs` are one line each. That split exists for remote mode: a shared
//! library is asked to run these over HTTP, by name, and the alternative to a
//! dispatcher was a second implementation of every operation against the same
//! database — which is exactly the kind of duplication `.ai/architecture.md`
//! says to force into one place or accept as a permanent drift risk.
//!
//! So there is one path. A click in this window and a click in a window on
//! another machine reach the same function, with the same argument names.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::db::{self, Db};
use crate::types::{
    CharacterCount, DeviantArtAccount, DeviantArtDraft, DeviantArtGallery, DeviantArtSummary,
    Folder, LibraryStats,
    MediaFrame, MediaItem, MediaPage, MediaQuery, Rating, ScanProgress, SourceOrigin,
    TimelineBucket,
};
use crate::{
    imports, pipeline, protocol, scan, thumbs, throttle, types, upscaler, video, AppState,
};

pub const FORGE_URL_KEY: &str = "forge_url";
/// Forge's own default. `127.0.0.1` rather than `localhost` because the latter
/// can resolve to IPv6 first and Gradio binds v4.
pub const DEFAULT_FORGE_URL: &str = "http://127.0.0.1:7860";

pub fn stringify(error: anyhow::Error) -> String {
    format!("{error:#}")
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

pub fn list_folders(state: &AppState) -> Result<Vec<Folder>, String> {
    state.db.list_folders().map_err(stringify)
}

/// Add a folder and immediately start scanning it.
///
/// The scan runs on its own thread and reports through the progress event, so
/// this returns as soon as the row exists — the UI shows the new folder with a
/// running scan rather than a spinner on a blocked command.
pub fn add_folder(
    app: &tauri::AppHandle,
    state: &AppState,
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

pub fn remove_folder(state: &AppState, id: i64) -> Result<(), String> {
    let folders = state.db.list_folders().map_err(stringify)?;
    if let Some(folder) = folders.iter().find(|folder| folder.id == id) {
        state.watcher.unwatch(&PathBuf::from(&folder.path));
    }
    state.db.remove_folder(id).map_err(stringify)
}

/// Re-walk a folder. Cheap when nothing changed: existing rows are left alone,
/// so a rescan of an unchanged library is a walk plus a few thousand no-op
/// inserts.
pub fn rescan_folder(app: &tauri::AppHandle, state: &AppState, id: i64) -> Result<(), String> {
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

pub fn query_media(state: &AppState, query: MediaQuery) -> Result<MediaPage, String> {
    state.db.query_media(&query).map_err(stringify)
}

/// How many rows the query matches per week, for the timeline's bars.
///
/// Ignores the query's own date range — the bars keep showing the whole span
/// while a selection narrows the grid, or nothing outside it could be grabbed.
pub fn media_timeline(state: &AppState, query: MediaQuery) -> Result<Vec<TimelineBucket>, String> {
    state.db.media_timeline(&query).map_err(stringify)
}

pub fn recent_media(state: &AppState, limit: i64) -> Result<Vec<MediaItem>, String> {
    state.db.recent_media(limit.clamp(1, 200)).map_err(stringify)
}

pub fn media_frames(state: &AppState, media_id: i64) -> Result<Vec<MediaFrame>, String> {
    // The `_or_original` is what puts detection boxes on an app-made 4K
    // variant: it has no frame rows of its own, and its original's boxes are
    // fractions of the same picture.
    state.db.frames_for_media_or_original(media_id).map_err(stringify)
}

/// One item by id — the detail view re-reads rather than trusting the copy it
/// was handed, so a lightbox opened before classification finished shows the
/// verdict once it lands.
pub fn media_by_id(state: &AppState, id: i64) -> Result<Option<MediaItem>, String> {
    state.db.media_by_id(id).map_err(stringify)
}

/// One row by path, for a picture no list contains.
///
/// The grid hides an original once an upscaled variant of it exists, so there
/// is no id to hand for it anywhere in the UI — only the path its variant
/// carries.
pub fn media_by_path(state: &AppState, path: String) -> Result<Option<MediaItem>, String> {
    state.db.media_by_path(&path).map_err(stringify)
}

/// The most-depicted characters, for the sidebar leaderboard. Detected from
/// prompts at labelling time; this is only the ranking query.
pub fn top_characters(
    state: &AppState,
    query: MediaQuery,
    limit: i64,
) -> Result<Vec<CharacterCount>, String> {
    state
        .db
        .top_characters(&query, limit.clamp(1, 50))
        .map_err(stringify)
}

/// What an img2img was made from, found perceptually and walked back to the
/// picture that started the lineage.
///
/// Null is an ordinary answer, not an error: a third of img2img rows have no
/// findable source, either because it was never in this library or because it
/// was deleted.
pub fn source_origin(state: &AppState, id: i64) -> Result<Option<SourceOrigin>, String> {
    let found = state.db.source_origin(id).map_err(stringify)?;
    Ok(found.map(|(item, origin)| SourceOrigin {
        item,
        hops: origin.hops,
        reached_root: origin.reached_root,
        weakest_hop: origin.weakest_hop,
    }))
}

/// The original behind an Extras-tab upscale, linked perceptually through
/// the duplicate grouping. Null when unlinked, which the UI explains.
pub fn extras_original(state: &AppState, id: i64) -> Result<Option<MediaItem>, String> {
    state.db.extras_original(id).map_err(stringify)
}

/// Upscale a selection, writing each result beside its source.
///
/// Blocking for the caller, deliberately: a batch is minutes of GPU work and the
/// UI needs a result to show, so this awaits the run and reports progress
/// through `luma://upscale` while it goes. It is `async`, so it does not hold
/// the main thread.
pub async fn upscale_media(
    app: &tauri::AppHandle,
    state: &AppState,
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
    if let Ok(status) = forge_status(state).await {
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
    let app = app.clone();
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
                let _ = db.update_dimensions(row.id, output.final_width, output.final_height, None, None);
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
pub fn set_stars(state: &AppState, id: i64, stars: Option<i64>) -> Result<(), String> {
    state.db.set_stars(id, stars).map_err(stringify)
}

/// Rate a whole selection at once, returning how many rows changed.
///
/// One call rather than one per id, for the same reason `delete_media` is one:
/// a selection can be hundreds, and that many IPC round trips is both slow and
/// impossible to report on sensibly.
pub fn set_stars_many(state: &AppState, ids: Vec<i64>, stars: Option<i64>) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    state.db.set_stars_many(&ids, stars).map_err(stringify)
}

/// Import 1-5 star ratings from a Stable Diffusion Image Browser database.
///
/// Staged rather than applied directly, so importing before scanning the
/// folder it describes is the expected order rather than a mistake.
pub fn import_image_browser_db(
    state: &AppState,
    path: String,
) -> Result<imports::ImportSummary, String> {
    imports::import_image_browser(&state.db, Path::new(&path), pipeline::now_ms())
        .map_err(|error| format!("{error:#}"))
}

pub fn library_stats(state: &AppState) -> Result<LibraryStats, String> {
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
pub fn reveal_item(app: &tauri::AppHandle, path: String) -> Result<(), String> {
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
pub fn open_external(app: &tauri::AppHandle, url: String) -> Result<(), String> {
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
pub fn delete_item(state: &AppState, id: i64, permanent: bool) -> Result<(), String> {
    // Both halves of an upscale pair, if this is one — see `with_counterparts`.
    // The original behind a variant is reachable only *through* that variant,
    // so deleting the variant alone would strand it.
    let rows = with_counterparts(&state.db, &[id]);
    if rows.is_empty() {
        return Err("that file is no longer in the library".to_string());
    }
    for item in rows {
        delete_one(state, &item, permanent)?;
    }
    Ok(())
}

fn delete_one(state: &AppState, item: &MediaItem, permanent: bool) -> Result<(), String> {
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
pub fn delete_media(state: &AppState, ids: Vec<i64>, permanent: bool) -> Result<DeleteSummary, String> {
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
pub fn generation_parameters(state: &AppState, id: i64) -> Result<Option<String>, String> {
    let Some(item) = state.db.media_by_id(id).map_err(stringify)? else {
        return Ok(None);
    };
    Ok(crate::generated::read_parameter_block(Path::new(&item.path)))
}

/// Where the local Stable Diffusion UI answers. Remembered between launches.
pub fn forge_url(state: &AppState) -> Result<String, String> {
    Ok(state
        .db
        .setting(FORGE_URL_KEY)
        .map_err(stringify)?
        .unwrap_or_else(|| DEFAULT_FORGE_URL.to_string()))
}

pub fn set_forge_url(state: &AppState, url: String) -> Result<(), String> {
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
pub async fn forge_select_checkpoint(
    state: &AppState,
    block: String,
) -> Result<Option<String>, String> {
    let Some(model) = crate::generated::checkpoint_of(&block) else {
        return Ok(None);
    };

    let base = forge_url(state)?;
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

pub async fn forge_status(state: &AppState) -> Result<ForgeStatus, String> {
    let base = forge_url(state)?;
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

// ---------------------------------------------------------------------------
// DeviantArt
// ---------------------------------------------------------------------------

pub fn deviantart_account(state: &AppState) -> Result<DeviantArtAccount, String> {
    Ok(state.deviantart.account())
}

/// Record the application registered on DeviantArt.
///
/// The secret is optional — an app registered as *public* has none, which is
/// the honest shape for something running on a desktop where a secret cannot
/// actually be kept. PKCE protects the exchange either way.
pub fn deviantart_configure(
    state: &AppState,
    client_id: String,
    client_secret: Option<String>,
) -> Result<DeviantArtAccount, String> {
    state
        .deviantart
        .configure(&client_id, client_secret.as_deref())
        .map_err(stringify)?;
    Ok(state.deviantart.account())
}

pub fn deviantart_set_redirect(state: &AppState, uri: String) -> Result<(), String> {
    state.deviantart.set_redirect_uri(&uri).map_err(stringify)
}

/// Open the browser, wait for the redirect, and keep the tokens.
///
/// Blocking for the caller, deliberately: there is nothing to show until it
/// finishes, and the alternative is a UI that has to poll for whether an
/// authorization it started has landed yet.
pub async fn deviantart_connect(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<DeviantArtAccount, String> {
    state.deviantart.connect(app).await.map_err(stringify)
}

pub fn deviantart_disconnect(state: &AppState) -> Result<(), String> {
    state.deviantart.disconnect();
    Ok(())
}

/// The account's gallery folders, for the panel to file submissions into.
///
/// Empty rather than an error when the connection predates the `browse` scope.
/// A missing scope is not a failure a toast should shout about — everything
/// else about posting still works, and the panel explains the one thing that
/// does not.
pub async fn deviantart_galleries(state: &AppState) -> Result<Vec<DeviantArtGallery>, String> {
    if !state.deviantart.account().can_browse {
        return Ok(Vec::new());
    }
    state.deviantart.galleries().await.map_err(stringify)
}

/// Upload a reviewed selection, optionally publishing each as it lands.
///
/// Takes drafts, not ids: what gets posted is what a person approved in the
/// panel, and re-deriving it here would silently discard their edits. The file
/// itself is still resolved from the index by id, so the webview never names a
/// path for the backend to read and upload.
pub async fn deviantart_send(
    app: &tauri::AppHandle,
    state: &AppState,
    drafts: Vec<DeviantArtDraft>,
    publish: bool,
    stack: Option<String>,
) -> Result<DeviantArtSummary, String> {
    if drafts.is_empty() {
        return Err("nothing selected".to_string());
    }
    if publish && !state.deviantart.account().can_publish {
        return Err(
            "this connection was not granted the publish scope — upload to Sta.sh and submit \
             from DeviantArt instead, or reconnect"
                .to_string(),
        );
    }
    let stack = stack.filter(|name| !name.trim().is_empty());
    Ok(state
        .deviantart
        .send(app, &drafts, publish, stack.as_deref())
        .await)
}

/// Correct the model's rating on a selection, or hand it back to the model.
///
/// `rating` is one of the three a person can mean — `sfw`, `suggestive`,
/// `explicit` — or `None`, which clears the correction and restores whatever
/// the stored verdict says. "unrated" is rejected rather than quietly treated
/// as a clear: it is what a row says before anything has looked at it, and
/// accepting it here would let the UI ask for a state it cannot mean.
pub fn set_rating_override(
    state: &AppState,
    ids: Vec<i64>,
    rating: Option<String>,
) -> Result<usize, String> {
    if ids.is_empty() {
        return Err("nothing selected".to_string());
    }
    let parsed = match rating.as_deref() {
        None => None,
        Some(value) => match Rating::parse(value) {
            Rating::Unrated => return Err(format!("{value} is not a rating anyone can choose")),
            known => Some(known),
        },
    };
    state
        .db
        .set_rating_override(&ids, parsed)
        .map_err(|error| format!("{error:#}"))
}

/// Mark a selection as already on DeviantArt, or clear the mark.
///
/// For everything the app did not upload itself — posted from the website,
/// posted before this recorded anything, or recorded wrongly.
pub fn deviantart_mark(state: &AppState, ids: Vec<i64>, posted: bool) -> Result<usize, String> {
    if ids.is_empty() {
        return Err("nothing selected".to_string());
    }
    state
        .db
        .set_deviantart_posted(&ids, posted)
        .map_err(|error| format!("{error:#}"))
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/// Clear recorded failures and reprocess them.
///
/// Failures are usually permanent, but not always: an unmounted share or a
/// missing ffmpeg fails everything it touches, and after fixing that the user
/// needs a way to say "try again" short of removing and re-adding the folder.
pub fn retry_failed(
    app: &tauri::AppHandle,
    state: &AppState,
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

/// The current progress, for a UI that mounted mid-scan and missed the events.
pub fn scan_progress(state: &AppState) -> Result<ScanProgress, String> {
    Ok(state.pipeline.snapshot())
}

pub fn process_pending(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
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
pub fn find_duplicates(state: &AppState) -> Result<Value, String> {
    let hashes = state.db.all_fingerprints().map_err(stringify)?;
    let grouping = crate::dupes::group(&hashes);

    let mut pairs: Vec<(i64, i64)> = grouping
        .groups
        .iter()
        .map(|(id, group)| (*group, *id))
        .collect();
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

pub fn list_exclusions(state: &AppState) -> Result<Vec<String>, String> {
    state.db.excluded_folders().map_err(stringify)
}

/// Stop scanning a folder, and drop what it already contributed.
///
/// Both halves are the point. Excluding only future walks would leave the
/// texture pack you just excluded sitting in the grid until something else
/// happened to prune it, which reads as the setting not working.
///
/// The exclusion itself is a `.lumaignore` written into the folder — the same
/// marker anyone can drop in by hand, and the only thing the walk consults. It
/// is written *first*: if it cannot be, nothing else happens, because deleting
/// rows for a folder the next walk will index again is worse than refusing.
///
/// So this is the one command here that writes into a watched folder rather
/// than only into the index. It is bounded the same way reads are — inside a
/// watched folder or nowhere — because it is reachable from a shared library
/// over the LAN, where the caller is not necessarily sitting at this machine.
///
/// Returns how many rows were removed. No media is ever touched.
pub fn exclude_folder(state: &AppState, path: String) -> Result<i64, String> {
    let given = Path::new(&path);
    can_exclude(given, &state.db.folder_paths().map_err(stringify)?)?;

    // Canonicalized once, and every step below uses that spelling.
    //
    // The dialog hands back a path a person may have edited, and the readable
    // form of a Windows path is not the one the index stores — `\\server\share`
    // against `\\?\UNC\server\share`. The row deletion is a prefix match on
    // stored paths, so the wrong spelling writes the marker and then quietly
    // removes nothing, leaving every file of an "excluded" folder in the grid.
    let folder = given
        .canonicalize()
        .map_err(|error| format!("{}: {error}", given.display()))?;
    let path = folder.to_string_lossy().to_string();

    scan::write_marker(&folder).map_err(|error| {
        format!(
            "could not write {} into {path}: {error}",
            scan::IGNORE_MARKER
        )
    })?;

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

/// May a marker be written into `folder`?
///
/// Two rules, both of which produce a message the UI shows verbatim:
///
/// - **Inside a watched folder.** The same bound reads have, for the same
///   reason: this command is reachable from a shared library over the LAN, and
///   the caller is then not the person sitting at this machine.
/// - **Not a watched folder itself.** A marker at the top of one would be read
///   by nothing — the walk starts *inside* the root and prunes downwards from
///   there — so writing it would leave the folder excluded in the sidebar and
///   scanned on disk. There is already a control for this, and it is the one to
///   point at.
///
/// Paths are canonicalized on both sides, so a root reached through a symlink,
/// a `..`, or a differently-cased drive letter is still recognised as one.
fn can_exclude(folder: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if !protocol::is_allowed(folder, roots) {
        return Err(format!("{} is not inside a watched folder", folder.display()));
    }
    let real = folder.canonicalize().map_err(|error| format!("{}: {error}", folder.display()))?;
    if roots.iter().any(|root| root.canonicalize().map(|root| root == real).unwrap_or(false)) {
        return Err(format!(
            "{} is a folder you added to the library. Remove it from the sidebar instead.",
            folder.display()
        ));
    }
    Ok(())
}

/// Scan a folder again after excluding it. Nothing is re-read until the next
/// walk, which the caller triggers.
///
/// The row goes only once the marker has: they are a record and the thing it
/// records, and dropping the record while the folder is still marked would list
/// it as included while every walk kept skipping it.
pub fn include_folder(state: &AppState, path: String) -> Result<(), String> {
    let gone = scan::remove_marker(Path::new(&path)).map_err(|error| {
        format!("could not remove {} from {path}: {error}", scan::IGNORE_MARKER)
    })?;
    if !gone {
        return Err(format!(
            "{path} holds a {} that this app did not write, so it was left alone. \
             Delete it by hand to scan the folder again.",
            scan::IGNORE_MARKER
        ));
    }
    state.db.remove_excluded_folder(&path).map_err(stringify)
}

/// What the environment can actually do, so the UI can explain a missing
/// capability instead of silently producing unrated files.
pub fn environment(state: &AppState) -> Result<Value, String> {
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
pub fn set_throttle(state: &AppState, level: String) -> Result<(), String> {
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

// ---------------------------------------------------------------------------
// By name
// ---------------------------------------------------------------------------

/// Run one operation by the name the frontend invokes it under.
///
/// Reached from two places: a shared library answering another machine's RPC,
/// and — through `remote_call` — a client sending one. The names and argument
/// keys are exactly the frontend's, so there is nothing to keep in sync beyond
/// this table.
pub async fn dispatch(
    app: &tauri::AppHandle,
    state: &AppState,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "list_folders" => ok(list_folders(state)?),
        "add_folder" => ok(add_folder(app, state, arg(args, "path")?)?),
        "remove_folder" => ok(remove_folder(state, arg(args, "id")?)?),
        "rescan_folder" => ok(rescan_folder(app, state, arg(args, "id")?)?),
        "query_media" => ok(query_media(state, arg(args, "query")?)?),
        "media_timeline" => ok(media_timeline(state, arg(args, "query")?)?),
        "top_characters" => ok(top_characters(state, arg(args, "query")?, arg(args, "limit")?)?),
        "extras_original" => ok(extras_original(state, arg(args, "id")?)?),
        "source_origin" => ok(source_origin(state, arg(args, "id")?)?),
        "recent_media" => ok(recent_media(state, arg(args, "limit")?)?),
        "media_frames" => ok(media_frames(state, arg(args, "mediaId")?)?),
        "media_by_id" => ok(media_by_id(state, arg(args, "id")?)?),
        "media_by_path" => ok(media_by_path(state, arg(args, "path")?)?),
        "upscale_media" => ok(upscale_media(app, state, arg(args, "ids")?, arg(args, "longEdge")?).await?),
        "library_stats" => ok(library_stats(state)?),
        "set_stars" => ok(set_stars(state, arg(args, "id")?, arg(args, "stars")?)?),
        "set_stars_many" => ok(set_stars_many(state, arg(args, "ids")?, arg(args, "stars")?)?),
        "import_image_browser_db" => ok(import_image_browser_db(state, arg(args, "path")?)?),
        "retry_failed" => ok(retry_failed(app, state, arg(args, "folderId")?)?),
        "reveal_item" => ok(reveal_item(app, arg(args, "path")?)?),
        "scan_progress" => ok(scan_progress(state)?),
        "process_pending" => ok(process_pending(app, state)?),
        "environment" => ok(environment(state)?),
        "set_throttle" => ok(set_throttle(state, arg(args, "level")?)?),
        "find_duplicates" => ok(find_duplicates(state)?),
        "open_external" => ok(open_external(app, arg(args, "url")?)?),
        "delete_item" => ok(delete_item(state, arg(args, "id")?, arg(args, "permanent")?)?),
        "delete_media" => ok(delete_media(state, arg(args, "ids")?, arg(args, "permanent")?)?),
        "generation_parameters" => ok(generation_parameters(state, arg(args, "id")?)?),
        "forge_url" => ok(forge_url(state)?),
        "set_forge_url" => ok(set_forge_url(state, arg(args, "url")?)?),
        "forge_select_checkpoint" => ok(forge_select_checkpoint(state, arg(args, "block")?).await?),
        "forge_status" => ok(forge_status(state).await?),
        "list_exclusions" => ok(list_exclusions(state)?),
        "exclude_folder" => ok(exclude_folder(state, arg(args, "path")?)?),
        "include_folder" => ok(include_folder(state, arg(args, "path")?)?),
        "deviantart_account" => ok(deviantart_account(state)?),
        "deviantart_configure" => ok(deviantart_configure(
            state,
            arg(args, "clientId")?,
            arg(args, "clientSecret")?,
        )?),
        "deviantart_set_redirect" => ok(deviantart_set_redirect(state, arg(args, "uri")?)?),
        "deviantart_connect" => ok(deviantart_connect(app, state).await?),
        "deviantart_disconnect" => ok(deviantart_disconnect(state)?),
        "deviantart_galleries" => ok(deviantart_galleries(state).await?),
        "deviantart_send" => ok(deviantart_send(
            app,
            state,
            arg(args, "drafts")?,
            arg(args, "publish")?,
            arg(args, "stack")?,
        )
        .await?),
        _ => Err(format!(
            "this version does not know how to do `{name}` — the two machines may be running \
             different builds"
        )),
    }
}

fn ok<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("cannot encode the answer: {error}"))
}

/// One named argument, in whichever case the caller spelled it.
///
/// Tauri's IPC renames JavaScript's camelCase into Rust's snake_case on the way
/// in; the wire does not, and the RPC route is also reachable by hand. Reading
/// both spellings costs a string compare and removes a whole class of "works
/// locally, fails remotely" from the dispatch table.
///
/// A missing key is `null`, which is what makes optional arguments — `stars`,
/// `longEdge`, `folderId` — work without a special case each.
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    let value = args
        .get(key)
        .or_else(|| args.get(snake_case(key)))
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| format!("bad `{key}` argument: {error}"))
}

fn snake_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 2);
    for character in key.chars() {
        if character.is_ascii_uppercase() {
            out.push('_');
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_argument_is_read_in_either_case() {
        let camel = json!({ "mediaId": 7, "longEdge": 3840 });
        assert_eq!(arg::<i64>(&camel, "mediaId").unwrap(), 7);

        // What Tauri hands a command, and what a hand-written request would
        // most likely say.
        let snake = json!({ "media_id": 7 });
        assert_eq!(arg::<i64>(&snake, "mediaId").unwrap(), 7);
    }

    #[test]
    fn a_missing_optional_argument_is_none_rather_than_an_error() {
        let empty = json!({});
        assert_eq!(arg::<Option<i64>>(&empty, "stars").unwrap(), None);
        assert_eq!(arg::<Option<i64>>(&empty, "longEdge").unwrap(), None);
        // An explicit null means the same thing — clearing a rating sends one.
        assert_eq!(arg::<Option<i64>>(&json!({ "stars": null }), "stars").unwrap(), None);
        // A required one still fails, with the key in the message.
        let message = arg::<i64>(&empty, "id").unwrap_err();
        assert!(message.contains("`id`"), "got: {message}");
    }

    #[test]
    fn args_that_are_not_an_object_do_not_panic() {
        // A hand-made request can send anything; `{"name":"x"}` with no args at
        // all is the likeliest.
        assert_eq!(arg::<Option<i64>>(&Value::Null, "stars").unwrap(), None);
        assert!(arg::<i64>(&json!("nonsense"), "id").is_err());
    }

    #[test]
    fn keys_convert_the_way_the_ipc_layer_converts_them() {
        assert_eq!(snake_case("mediaId"), "media_id");
        assert_eq!(snake_case("clientSecret"), "client_secret");
        assert_eq!(snake_case("path"), "path");
    }

    #[test]
    fn a_marker_is_only_ever_written_inside_a_watched_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let watched = dir.path().join("vault");
        let inside = watched.join("assets").join("Texture Pack");
        let outside = dir.path().join("somewhere else");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let roots = vec![watched.clone()];

        assert!(can_exclude(&inside, &roots).is_ok());

        // Reachable over the LAN from another machine, so "any absolute path"
        // would mean any folder on this disk.
        let message = can_exclude(&outside, &roots).unwrap_err();
        assert!(message.contains("not inside a watched folder"), "got: {message}");

        // `..` cannot walk back out of one, either.
        let sneaky = watched.join("..").join("somewhere else");
        assert!(can_exclude(&sneaky, &roots).is_err());
    }

    #[test]
    fn excluding_a_watched_folder_itself_points_at_the_control_that_works() {
        // The marker would land where the walk never looks — it starts inside
        // the root — so the folder would read as excluded and be scanned anyway.
        let dir = tempfile::tempdir().expect("tempdir");
        let watched = dir.path().join("vault");
        std::fs::create_dir_all(&watched).unwrap();

        let message = can_exclude(&watched, std::slice::from_ref(&watched)).unwrap_err();
        assert!(message.contains("Remove it from the sidebar"), "got: {message}");
    }
}
