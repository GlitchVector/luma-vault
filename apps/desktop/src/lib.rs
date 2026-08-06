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
//!
//! The commands here are one line each: the bodies live in `api.rs`, which also
//! runs them by name. That is what lets a second machine ask this one to do the
//! same things over the LAN without a second implementation of any of them —
//! see `remote.rs`.

mod api;
mod classifier;
mod db;
mod deviantart;
mod dupes;
mod generated;
pub mod imports;
mod origin;
mod paths;
mod pipeline;
mod protocol;
mod rating;
mod remote;
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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, State};

use crate::api::{DeleteSummary, ForgeStatus};
use crate::db::Db;
use crate::deviantart::DeviantArt;
use crate::pipeline::Pipeline;
use crate::protocol::ProtocolRoots;
use crate::remote::RemoteState;
use crate::types::{
    CharacterCount, DeviantArtAccount, DeviantArtDraft, DeviantArtSummary, Folder, LibraryStats,
    MediaFrame, MediaItem, MediaPage, MediaQuery, RemoteStatus, ScanProgress, ShareStatus,
    SourceOrigin, TimelineBucket,
};
use crate::watcher::FolderWatcher;

pub struct AppState {
    db: Arc<Db>,
    pipeline: Arc<Pipeline>,
    watcher: Arc<FolderWatcher>,
    /// The `luma://` allowlist. Held here as well as used by the protocol
    /// handler, because a shared library serves files through the same check.
    roots: Arc<ProtocolRoots>,
    /// Interpreter and script, resolved once at startup. `None` when the venv
    /// has not been built, which the command reports as a setup step rather
    /// than a failure.
    upscaler: Option<(PathBuf, PathBuf)>,
    /// Holds the access-token cache, so a batch of twenty uploads refreshes
    /// once rather than per file.
    deviantart: Arc<DeviantArt>,
    /// Whether this window is showing another machine's library, and whether it
    /// is answering for others.
    remote: Arc<RemoteState>,
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>, String> {
    api::list_folders(&state)
}

#[tauri::command(async)]
async fn add_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Folder, String> {
    api::add_folder(&app, &state, path)
}

#[tauri::command(async)]
async fn remove_folder(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    api::remove_folder(&state, id)
}

#[tauri::command(async)]
async fn rescan_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    api::rescan_folder(&app, &state, id)
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn query_media(state: State<'_, AppState>, query: MediaQuery) -> Result<MediaPage, String> {
    api::query_media(&state, query)
}

#[tauri::command(async)]
async fn media_timeline(
    state: State<'_, AppState>,
    query: MediaQuery,
) -> Result<Vec<TimelineBucket>, String> {
    api::media_timeline(&state, query)
}

#[tauri::command(async)]
async fn recent_media(state: State<'_, AppState>, limit: i64) -> Result<Vec<MediaItem>, String> {
    api::recent_media(&state, limit)
}

#[tauri::command(async)]
async fn media_frames(state: State<'_, AppState>, media_id: i64) -> Result<Vec<MediaFrame>, String> {
    api::media_frames(&state, media_id)
}

#[tauri::command(async)]
async fn media_by_id(state: State<'_, AppState>, id: i64) -> Result<Option<MediaItem>, String> {
    api::media_by_id(&state, id)
}

#[tauri::command(async)]
async fn media_by_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<MediaItem>, String> {
    api::media_by_path(&state, path)
}

#[tauri::command(async)]
async fn top_characters(
    state: State<'_, AppState>,
    query: MediaQuery,
    limit: i64,
) -> Result<Vec<CharacterCount>, String> {
    api::top_characters(&state, query, limit)
}

#[tauri::command(async)]
async fn extras_original(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<MediaItem>, String> {
    api::extras_original(&state, id)
}

#[tauri::command(async)]
async fn source_origin(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<SourceOrigin>, String> {
    api::source_origin(&state, id)
}

#[tauri::command(async)]
async fn upscale_media(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    long_edge: Option<i64>,
) -> Result<upscaler::UpscaleSummary, String> {
    api::upscale_media(&app, &state, ids, long_edge).await
}

#[tauri::command(async)]
async fn set_stars(state: State<'_, AppState>, id: i64, stars: Option<i64>) -> Result<(), String> {
    api::set_stars(&state, id, stars)
}

#[tauri::command(async)]
async fn set_stars_many(
    state: State<'_, AppState>,
    ids: Vec<i64>,
    stars: Option<i64>,
) -> Result<usize, String> {
    api::set_stars_many(&state, ids, stars)
}

#[tauri::command(async)]
async fn import_image_browser_db(
    state: State<'_, AppState>,
    path: String,
) -> Result<imports::ImportSummary, String> {
    api::import_image_browser_db(&state, path)
}

#[tauri::command(async)]
async fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    api::library_stats(&state)
}

/// Show a file in the OS file manager.
///
/// The one action that cannot be forwarded. Running it on the peer would open a
/// window on a screen nobody is sitting in front of, so a remote session is
/// told where the file actually is instead.
#[tauri::command(async)]
async fn reveal_item(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    if let Some(session) = state.remote.session() {
        return Err(format!(
            "that file is on {} — Explorer can only open it at that machine",
            session.address()
        ));
    }
    api::reveal_item(&app, path)
}

#[tauri::command(async)]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    api::open_external(&app, url)
}

#[tauri::command(async)]
async fn delete_item(state: State<'_, AppState>, id: i64, permanent: bool) -> Result<(), String> {
    api::delete_item(&state, id, permanent)
}

#[tauri::command(async)]
async fn delete_media(
    state: State<'_, AppState>,
    ids: Vec<i64>,
    permanent: bool,
) -> Result<DeleteSummary, String> {
    api::delete_media(&state, ids, permanent)
}

#[tauri::command(async)]
async fn generation_parameters(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<String>, String> {
    api::generation_parameters(&state, id)
}

#[tauri::command(async)]
async fn forge_url(state: State<'_, AppState>) -> Result<String, String> {
    api::forge_url(&state)
}

#[tauri::command(async)]
async fn set_forge_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    api::set_forge_url(&state, url)
}

#[tauri::command(async)]
async fn forge_select_checkpoint(
    state: State<'_, AppState>,
    block: String,
) -> Result<Option<String>, String> {
    api::forge_select_checkpoint(&state, block).await
}

#[tauri::command(async)]
async fn forge_status(state: State<'_, AppState>) -> Result<ForgeStatus, String> {
    api::forge_status(&state).await
}

// ---------------------------------------------------------------------------
// DeviantArt
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn deviantart_account(state: State<'_, AppState>) -> Result<DeviantArtAccount, String> {
    api::deviantart_account(&state)
}

#[tauri::command(async)]
async fn deviantart_configure(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: Option<String>,
) -> Result<DeviantArtAccount, String> {
    api::deviantart_configure(&state, client_id, client_secret)
}

#[tauri::command(async)]
async fn deviantart_set_redirect(state: State<'_, AppState>, uri: String) -> Result<(), String> {
    api::deviantart_set_redirect(&state, uri)
}

#[tauri::command(async)]
async fn deviantart_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DeviantArtAccount, String> {
    api::deviantart_connect(&app, &state).await
}

#[tauri::command(async)]
async fn deviantart_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    api::deviantart_disconnect(&state)
}

#[tauri::command(async)]
async fn deviantart_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    drafts: Vec<DeviantArtDraft>,
    publish: bool,
    stack: Option<String>,
) -> Result<DeviantArtSummary, String> {
    api::deviantart_send(&app, &state, drafts, publish, stack).await
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn retry_failed(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    folder_id: Option<i64>,
) -> Result<usize, String> {
    api::retry_failed(&app, &state, folder_id)
}

#[tauri::command(async)]
async fn scan_progress(state: State<'_, AppState>) -> Result<ScanProgress, String> {
    api::scan_progress(&state)
}

#[tauri::command(async)]
async fn process_pending(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    api::process_pending(&app, &state)
}

#[tauri::command(async)]
async fn find_duplicates(state: State<'_, AppState>) -> Result<Value, String> {
    api::find_duplicates(&state)
}

#[tauri::command(async)]
async fn list_exclusions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    api::list_exclusions(&state)
}

#[tauri::command(async)]
async fn exclude_folder(state: State<'_, AppState>, path: String) -> Result<i64, String> {
    api::exclude_folder(&state, path)
}

#[tauri::command(async)]
async fn include_folder(state: State<'_, AppState>, path: String) -> Result<(), String> {
    api::include_folder(&state, path)
}

#[tauri::command(async)]
async fn environment(state: State<'_, AppState>) -> Result<Value, String> {
    api::environment(&state)
}

#[tauri::command(async)]
async fn set_throttle(state: State<'_, AppState>, level: String) -> Result<(), String> {
    api::set_throttle(&state, level)
}

// ---------------------------------------------------------------------------
// Remote mode
// ---------------------------------------------------------------------------

#[tauri::command(async)]
async fn remote_status(state: State<'_, AppState>) -> Result<RemoteStatus, String> {
    Ok(state.remote.status(last_address(&state)))
}

/// Point this window at another machine's library.
///
/// The whole app follows: from here on every call the frontend makes is answered
/// by the peer, and every tile is fetched from it. Nothing about the local
/// library is touched — its scan keeps running, and disconnecting puts it back.
#[tauri::command(async)]
async fn remote_connect(
    state: State<'_, AppState>,
    address: String,
    passphrase: String,
) -> Result<RemoteStatus, String> {
    let address = remote::parse_address(&address)?;
    // An empty field means "use the one you remembered", which is what makes
    // reconnecting a single click. Typing a new one replaces it.
    let passphrase = if passphrase.trim().is_empty() {
        remote::stored_client_passphrase()
            .ok_or_else(|| "type the passphrase that machine is sharing with".to_string())?
    } else {
        passphrase
    };

    let session = remote::Session::connect(&address, &passphrase).await?;

    // Both best-effort: a credential store that refuses, or a setting that
    // will not write, costs a retyped passphrase next time and must not fail a
    // connection that already works.
    let _ = remote::store_client_passphrase(&passphrase);
    let _ = state
        .db
        .set_setting(remote::LAST_ADDRESS_SETTING, &address);

    state.remote.set_session(Some(Arc::new(session)));
    Ok(state.remote.status(last_address(&state)))
}

#[tauri::command(async)]
async fn remote_disconnect(state: State<'_, AppState>) -> Result<RemoteStatus, String> {
    state.remote.set_session(None);
    Ok(state.remote.status(last_address(&state)))
}

/// Run one operation on the connected machine.
///
/// The frontend's single native seam sends everything here while a session is
/// live, rather than each of forty commands having to know about remote mode.
/// Without a session this refuses rather than quietly answering from the local
/// index — a frontend that thinks it is remote and a backend that thinks it is
/// local must not silently agree.
#[tauri::command(async)]
async fn remote_call(
    state: State<'_, AppState>,
    name: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let session = state
        .remote
        .session()
        .ok_or_else(|| "not connected to another machine".to_string())?;
    session.call(&name, args.unwrap_or(Value::Null)).await
}

#[tauri::command(async)]
async fn share_status(state: State<'_, AppState>) -> Result<ShareStatus, String> {
    Ok(state.remote.share_status())
}

/// Start or stop answering for other machines on this network.
///
/// Off until asked, and it stays off across launches unless it was on when the
/// app closed. A passphrase is required to start: it is the only thing between
/// the LAN and a library that a session can delete from.
#[tauri::command(async)]
async fn set_share(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    passphrase: Option<String>,
) -> Result<ShareStatus, String> {
    if !enabled {
        state.remote.sharing.stop();
        let _ = state.db.set_setting(remote::SHARE_SETTING, "0");
        return Ok(state.remote.share_status());
    }

    let chosen = passphrase
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if state.remote.is_sharing() {
        match &chosen {
            // Already answering, with the passphrase it was started with.
            None => return Ok(state.remote.share_status()),
            // A new one has to be picked up by the running server, or the stored
            // phrase and the one the port actually accepts would disagree —
            // which reads as the new passphrase simply not working.
            Some(_) => state.remote.sharing.stop(),
        }
    }

    let passphrase = match chosen {
        Some(value) => {
            remote::store_host_passphrase(&value)?;
            value
        }
        // Kept when sharing is switched off, so turning it back on does not ask
        // again — and so the other machine's remembered passphrase still works.
        None => remote::stored_host_passphrase().ok_or_else(|| {
            "choose a passphrase first — the other machine has to type it".to_string()
        })?,
    };

    state
        .remote
        .sharing
        .start(shared_library(&app, &state, passphrase))?;
    let _ = state.db.set_setting(remote::SHARE_SETTING, "1");
    Ok(state.remote.share_status())
}

fn last_address(state: &AppState) -> Option<String> {
    state.db.setting(remote::LAST_ADDRESS_SETTING).ok().flatten()
}

/// What this machine answers with while it is sharing.
///
/// The RPC closure blocks on the dispatcher. That is correct here and nowhere
/// else: the server's workers are plain threads rather than runtime workers, and
/// everything an operation does — SQLite, file reads, ffmpeg — blocks anyway.
fn shared_library(app: &tauri::AppHandle, state: &AppState, passphrase: String) -> remote::Shared {
    let dispatch_handle = app.clone();
    let greeting_handle = app.clone();

    remote::Shared {
        roots: Arc::clone(&state.roots),
        rpc: Arc::new(move |name, args| {
            let handle = dispatch_handle.clone();
            tauri::async_runtime::block_on(async move {
                let state = handle.state::<AppState>();
                api::dispatch(&handle, &state, &name, &args).await
            })
        }),
        greeting: Arc::new(move || {
            let state = greeting_handle.state::<AppState>();
            let stats = state.db.stats().ok();
            serde_json::json!({
                // Checked by the client, so a Forge or a router page on the same
                // port is reported as "not Luma Vault" rather than as a
                // connection that half works.
                "app": "luma-vault",
                "version": env!("CARGO_PKG_VERSION"),
                "host": remote::machine_name(),
                "folders": stats.as_ref().map(|stats| stats.folders).unwrap_or(0),
                "items": stats
                    .as_ref()
                    .map(|stats| stats.images + stats.videos)
                    .unwrap_or(0),
            })
        }),
        passphrase,
    }
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

            app.manage(AppState {
                deviantart: Arc::new(DeviantArt::new(Arc::clone(&db))),
                roots: Arc::new(ProtocolRoots {
                    db: Arc::clone(&db),
                    thumb_root,
                    frame_root,
                }),
                db,
                pipeline: Arc::clone(&pipeline),
                watcher,
                upscaler: upscaler::resolve(&repo_root, resource_dir.as_deref()),
                remote: Arc::new(RemoteState::new(remote::DEFAULT_PORT)),
            });

            // Sharing comes back on if it was on when the app closed — the
            // other machine is often a laptop that will simply try to connect.
            // The passphrase is not stored beside the setting, so a wiped
            // credential store leaves sharing off rather than open.
            let handle = app.handle().clone();
            let state = handle.state::<AppState>();
            let was_sharing = state
                .db
                .setting(remote::SHARE_SETTING)
                .ok()
                .flatten()
                .as_deref()
                == Some("1");
            if was_sharing {
                match remote::stored_host_passphrase() {
                    Some(passphrase) => {
                        if let Err(error) = state
                            .remote
                            .sharing
                            .start(shared_library(&handle, &state, passphrase))
                        {
                            eprintln!("[luma] cannot share this library: {error}");
                        }
                    }
                    None => eprintln!(
                        "[luma] sharing was on but no passphrase is stored — left off. \
                         Set one in the remote panel."
                    ),
                }
            }

            // Re-walk every folder, then resume anything the last session left
            // unfinished. The pipeline's work queue is a database query, so
            // there is nothing to replay — it simply asks what still has no
            // thumbnail or verdict. The walk is what catches files added or
            // removed while the app was closed, which the watcher cannot see.
            let handle = app.handle().clone();
            std::thread::spawn(move || pipeline::run_startup(pipeline, handle));

            Ok(())
        })
        // Asynchronous, unlike the local-only version this replaced. A remote
        // tile is a request to another machine, and answering it on the thread
        // the protocol handler is called on would freeze the window for the
        // length of every fetch. The local path moved onto the blocking pool
        // with it, which also takes a slow network share off that thread.
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, move |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let session = app.state::<AppState>().remote.session();

            match session {
                Some(session) => {
                    let path = protocol::extract_path(&request.uri().to_string());
                    let range = request
                        .headers()
                        .get("range")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    tauri::async_runtime::spawn(async move {
                        let reply = match path {
                            Some(path) => session.file(&path, range.as_deref()).await,
                            None => protocol::FileReply::failure(400, "missing ?path= parameter"),
                        };
                        responder.respond(reply.into_response());
                    });
                }
                None => {
                    tauri::async_runtime::spawn_blocking(move || {
                        let roots = Arc::clone(&app.state::<AppState>().roots);
                        responder.respond(protocol::handle(&roots, &request));
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_folders,
            add_folder,
            remove_folder,
            rescan_folder,
            query_media,
            media_timeline,
            top_characters,
            extras_original,
            source_origin,
            recent_media,
            media_frames,
            media_by_id,
            media_by_path,
            upscale_media,
            library_stats,
            set_stars,
            set_stars_many,
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
            deviantart_account,
            deviantart_configure,
            deviantart_set_redirect,
            deviantart_connect,
            deviantart_disconnect,
            deviantart_send,
            remote_status,
            remote_connect,
            remote_disconnect,
            remote_call,
            share_status,
            set_share,
        ])
        .run(tauri::generate_context!())
        .expect("cannot start luma-vault");
}
