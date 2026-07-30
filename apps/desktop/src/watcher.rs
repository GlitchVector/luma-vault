//! Filesystem watching for the folders the user added.
//!
//! Events are debounced before they reach us. Without that, copying a single
//! large video into a watched folder produces hundreds of write events, and
//! every one of them would kick off a scan of a file that is still being
//! written. The debounce window also lets a bulk copy of 2,000 photos settle
//! into one pass rather than 2,000.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use tauri::AppHandle;

use crate::db::{Db, ScannedFile};
use crate::pipeline::{self, now_ms, Pipeline};
use crate::scan;
use crate::thumbs;

/// Long enough that a bulk copy settles into one pass; short enough that
/// dropping a screenshot into a folder feels immediate.
const DEBOUNCE: Duration = Duration::from_secs(3);

pub struct FolderWatcher {
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher, FileIdMap>>>,
    watched: Mutex<HashSet<PathBuf>>,
}

impl FolderWatcher {
    pub fn new() -> Self {
        Self {
            debouncer: Mutex::new(None),
            watched: Mutex::new(HashSet::new()),
        }
    }

    /// Start watching, wiring events into the pipeline.
    ///
    /// Failing to start the watcher is not fatal: the library still works, it
    /// just will not notice changes until the next manual rescan. A missing
    /// inotify limit on Linux is the usual cause and is not worth refusing to
    /// launch over.
    pub fn start(&self, db: Arc<Db>, pipeline: Arc<Pipeline>, app: AppHandle) {
        let handler_db = Arc::clone(&db);
        let handler_pipeline = Arc::clone(&pipeline);
        let handler_app = app.clone();

        let debouncer = new_debouncer(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    let paths: HashSet<PathBuf> = events
                        .into_iter()
                        .flat_map(|event| event.event.paths.clone())
                        .collect();
                    handle_changes(&handler_db, &handler_pipeline, &handler_app, paths);
                }
                Err(errors) => {
                    for error in errors {
                        eprintln!("[luma] watcher error: {error}");
                    }
                }
            },
        );

        match debouncer {
            Ok(debouncer) => {
                *self.debouncer.lock().expect("watcher mutex") = Some(debouncer);
                if let Ok(folders) = db.folder_paths() {
                    for folder in folders {
                        self.watch(&folder);
                    }
                }
            }
            Err(error) => {
                eprintln!("[luma] could not start the folder watcher: {error}");
            }
        }
    }

    pub fn watch(&self, path: &Path) {
        let mut guard = self.debouncer.lock().expect("watcher mutex");
        let Some(debouncer) = guard.as_mut() else {
            return;
        };
        if let Err(error) = debouncer.watcher().watch(path, RecursiveMode::Recursive) {
            eprintln!("[luma] cannot watch {}: {error}", path.display());
            return;
        }
        self.watched
            .lock()
            .expect("watched mutex")
            .insert(path.to_path_buf());
    }

    pub fn unwatch(&self, path: &Path) {
        let mut guard = self.debouncer.lock().expect("watcher mutex");
        if let Some(debouncer) = guard.as_mut() {
            let _ = debouncer.watcher().unwatch(path);
        }
        self.watched.lock().expect("watched mutex").remove(path);
    }
}

impl Default for FolderWatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Apply a debounced batch of filesystem changes to the index.
fn handle_changes(
    db: &Arc<Db>,
    pipeline: &Arc<Pipeline>,
    app: &AppHandle,
    paths: HashSet<PathBuf>,
) {
    let folders = db.folder_paths().unwrap_or_default();
    let thumb_root = pipeline.thumb_root();
    let frame_root = pipeline.frame_root();
    let mut touched = false;

    for path in paths {
        // Ignore anything outside a watched folder, and anything we generated
        // ourselves — the derived-data directories live under app-data, but a
        // user could plausibly add a folder that contains one.
        let Some(folder_id) = owning_folder(db, &folders, &path) else {
            continue;
        };

        let Some(path_str) = path.to_str() else {
            continue;
        };

        if path.is_file() {
            let Some(kind) = scan::kind_of(&path) else {
                continue;
            };
            let Ok(metadata) = path.metadata() else {
                continue;
            };

            // A changed file must lose its derived data, or the grid keeps
            // showing the old thumbnail and the old verdict forever.
            db.delete_media_by_path(path_str).ok();
            thumbs::forget_derived(&thumb_root, &frame_root, path_str);

            let entry = ScannedFile {
                path: path_str.to_string(),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                kind,
                size_bytes: metadata.len() as i64,
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0),
            };

            if db.insert_media_batch(folder_id, &[entry], now_ms()).is_ok() {
                touched = true;
            }
        } else if !path.exists() {
            // Deleted, or renamed away. Either way the row is stale.
            db.delete_media_by_path(path_str).ok();
            thumbs::forget_derived(&thumb_root, &frame_root, path_str);
            touched = true;
        }
    }

    if touched && !pipeline.is_busy() {
        let pipeline = Arc::clone(pipeline);
        let app = app.clone();
        std::thread::spawn(move || pipeline::run_pending(pipeline, app));
    }
}

fn owning_folder(db: &Arc<Db>, folders: &[PathBuf], path: &Path) -> Option<i64> {
    let folder = folders.iter().find(|folder| path.starts_with(folder))?;
    db.list_folders()
        .ok()?
        .into_iter()
        .find(|candidate| Path::new(&candidate.path) == folder.as_path())
        .map(|candidate| candidate.id)
}
