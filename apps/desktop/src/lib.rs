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
mod pipeline;
mod protocol;
mod rating;
mod sampling;
mod scan;
mod thumbs;
mod types;
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

#[tauri::command(async)]
async fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    state.db.stats().map_err(stringify)
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

/// What the environment can actually do, so the UI can explain a missing
/// capability instead of silently producing unrated files.
#[tauri::command(async)]
async fn environment(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "classifierAvailable": state.pipeline.classifier_ready(),
        "ffmpegAvailable": video::available(),
        "busy": state.pipeline.is_busy(),
    }))
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

            let pipeline = Arc::new(Pipeline::new(
                Arc::clone(&db),
                thumb_root.clone(),
                frame_root.clone(),
                python,
                script,
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
            });

            // Anything left unfinished by the last session resumes now. The
            // pipeline's work queue is a database query, so there is nothing to
            // replay — it simply asks what still has no thumbnail or verdict.
            let handle = app.handle().clone();
            std::thread::spawn(move || pipeline::run_pending(pipeline, handle));

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
            library_stats,
            scan_progress,
            process_pending,
            environment,
        ])
        .run(tauri::generate_context!())
        .expect("cannot start luma-vault");
}

use std::path::Path;
