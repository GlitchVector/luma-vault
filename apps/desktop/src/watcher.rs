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

/// Is the file on disk different from the row the index already holds?
///
/// Size and mtime together. Neither alone is enough — an edit that preserves
/// the length is ordinary (a re-save at the same quality, a metadata rewrite),
/// and a copy restored from a backup keeps its length while its mtime moves.
///
/// Deliberately not a content hash. This runs on every event from a watcher
/// pointed at an SMB share, and reading a 12MB file to decide whether to look
/// at it would cost more than the mistake it prevents.
fn has_changed(existing: &crate::types::MediaItem, size_bytes: i64, modified_at: i64) -> bool {
    existing.size_bytes != size_bytes || existing.modified_at != modified_at
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

        // The walk skips some directories outright; this has to agree with it.
        // Without this the rule only holds for files that appeared while the
        // app was closed — and for Stable Diffusion's grids that is almost
        // none of them, because generating is exactly when the app is open.
        if scan::is_in_ignored_dir(path_str) {
            continue;
        }

        if path.is_file() {
            let Some(kind) = scan::kind_of(&path) else {
                continue;
            };
            let Ok(metadata) = path.metadata() else {
                continue;
            };

            let size_bytes = metadata.len() as i64;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);

            // Same size, same mtime: the same file, and the row stands.
            //
            // The teardown below is for a file whose *contents* changed — it
            // drops the row so the thumbnail and the verdict are rebuilt rather
            // than left describing the old picture. Applying it to a file that
            // merely produced an event destroys everything the row had learned:
            // its verdict, the stars someone gave it by hand, the generation
            // parameters, and the dimensions the upscale command had just
            // recorded. A watcher on an SMB share fires for plenty of reasons
            // that are not edits, and the upscaler writing a file is one of
            // them — the row it inserts is the row this event is about.
            if let Ok(Some(existing)) = db.media_by_path(path_str) {
                if !has_changed(&existing, size_bytes, modified_at) {
                    continue;
                }
            }

            // Its key has to be read before the row goes, since the key is what
            // the derived files are addressed by.
            let key = db.content_key_for_path(path_str).ok().flatten();
            db.delete_media_by_path(path_str).ok();
            forget_if_unreferenced(db, &thumb_root, &frame_root, key.as_deref());

            let entry = ScannedFile {
                path: path_str.to_string(),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                kind,
                size_bytes,
                modified_at,
            };

            if db.insert_media_batch(folder_id, &[entry], now_ms()).is_ok() {
                touched = true;
            }
        } else if !path.exists() {
            // Deleted, or renamed away. Either way the row is stale — but a
            // rename is exactly the case content addressing is for, so the
            // derived files survive if the new path already claims the key.
            let key = db.content_key_for_path(path_str).ok().flatten();
            db.delete_media_by_path(path_str).ok();
            forget_if_unreferenced(db, &thumb_root, &frame_root, key.as_deref());
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

/// Drop a key's derived files only once no row points at it.
///
/// Duplicates and renames both share a key, so an unconditional delete would
/// blank a tile that another row is still relying on.
fn forget_if_unreferenced(
    db: &Db,
    thumb_root: &Path,
    frame_root: &Path,
    key: Option<&str>,
) {
    let Some(key) = key else { return };
    if db.rows_with_content_key(key).unwrap_or(1) == 0 {
        thumbs::forget_derived(thumb_root, frame_root, key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MediaItem, MediaKind};

    fn row(size_bytes: i64, modified_at: i64) -> MediaItem {
        MediaItem {
            id: 1,
            folder_id: 1,
            path: "/out/00021_upscaled_4k.png".to_string(),
            name: "00021_upscaled_4k.png".to_string(),
            kind: MediaKind::Image,
            width: 2627,
            height: 3840,
            size_bytes,
            modified_at,
            added_at: 0,
            thumb_path: Some("/thumbs/ab/cd/o.jpg".to_string()),
            thumb_width: Some(360),
            thumb_height: Some(512),
            duration_sec: None,
            verdict: None,
            classified_at: None,
            stars: Some(5),
            generation: None,
            dupe_group: None,
            upscaled_from: Some("/out/00021.png".to_string()),
            upscaled_to: None,
        }
    }

    #[test]
    fn an_event_about_an_unchanged_file_changes_nothing() {
        // The case that cost a 4K badge: the upscale command inserts the row and
        // records its size, then the watcher's debounced event arrives about the
        // same file and the old code tore the row down and rebuilt it at 0x0 —
        // taking the stars and the verdict with it.
        assert!(!has_changed(&row(9_900_000, 1_700_000_000_000), 9_900_000, 1_700_000_000_000));
    }

    #[test]
    fn either_field_moving_is_a_change() {
        // Neither alone is enough. An edit can preserve the length — a re-save
        // at the same quality, a metadata rewrite — and a file restored from a
        // backup keeps its length while its mtime moves.
        assert!(has_changed(&row(9_900_000, 1_700_000_000_000), 9_900_001, 1_700_000_000_000));
        assert!(has_changed(&row(9_900_000, 1_700_000_000_000), 9_900_000, 1_700_000_000_001));
    }
}
