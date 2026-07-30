//! The background pipeline: glob → thumbnail → classify.
//!
//! # Shape
//!
//! Three phases, run on a background thread so no command ever blocks the UI.
//! Each phase drains a work queue that is a *database query*, not an in-memory
//! list — `pending_thumbnails` and `pending_classification` are simply "rows
//! that still need this". That makes the whole pipeline restartable: kill the
//! app halfway through a 50,000-file scan, reopen it, and it picks up exactly
//! where it stopped, with no journal to replay or checkpoint to maintain.
//!
//! # Failure policy
//!
//! Per-item failures are collected as rows in `ScanProgress.errors` and never
//! propagate. One corrupt JPEG, one video with no container duration, one
//! permission-denied directory — none of them may cost you the rest of the
//! library. The only fatal error is "the classifier will not start at all".
//!
//! # Why videos get a poster twice
//!
//! During thumbnailing a video is given a *provisional* poster: the middle
//! frame. That is what makes it appear in the grid seconds after a scan starts
//! rather than minutes later. Classification then replaces it with the real
//! poster — the first sexy frame if there is one. The user sees the tile
//! appear, then sharpen into the right frame.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use tauri::{AppHandle, Emitter};

use crate::classifier::{ClassifierPool, BATCH_SIZE};
use crate::db::{Db, NewFrame, PendingFile, ThumbnailUpdate};
use crate::rating::{from_single_frame, rate_frame, roll_up_video, ClassifyOptions};
use crate::sampling::{plan_frame_timestamps, SamplingOptions};
use crate::thumbs::{self, THUMB_MAX};
use crate::types::{JobPhase, MediaKind, ScanProgress};
use crate::{scan, video};

/// The event the frontend listens on. One event shape for every phase, so the
/// status bar is a single component and adding a phase costs the UI nothing.
pub const PROGRESS_EVENT: &str = "luma://progress";

/// How many rows to pull per pass. Bounded so a million-file library does not
/// materialise a million-element Vec, and so progress is emitted regularly.
const PAGE: i64 = 512;

/// Errors kept in the live progress payload. The full list would be unbounded
/// on a broken NAS mount, and nobody reads past the first handful.
const MAX_REPORTED_ERRORS: usize = 50;

pub struct Pipeline {
    db: Arc<Db>,
    classifier: Arc<Mutex<Option<Arc<ClassifierPool>>>>,
    classifier_python: Option<PathBuf>,
    classifier_script: Option<PathBuf>,
    thumb_root: PathBuf,
    frame_root: PathBuf,
    progress: Arc<Mutex<ScanProgress>>,
    busy: Arc<AtomicBool>,
}

impl Pipeline {
    pub fn new(
        db: Arc<Db>,
        thumb_root: PathBuf,
        frame_root: PathBuf,
        classifier_python: Option<PathBuf>,
        classifier_script: Option<PathBuf>,
    ) -> Self {
        Self {
            db,
            classifier: Arc::new(Mutex::new(None)),
            classifier_python,
            classifier_script,
            thumb_root,
            frame_root,
            progress: Arc::new(Mutex::new(ScanProgress::idle())),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn snapshot(&self) -> ScanProgress {
        self.progress.lock().expect("progress mutex").clone()
    }

    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    pub fn classifier_ready(&self) -> bool {
        self.classifier_python.is_some() && self.classifier_script.is_some()
    }

    pub fn thumb_root(&self) -> PathBuf {
        self.thumb_root.clone()
    }

    pub fn frame_root(&self) -> PathBuf {
        self.frame_root.clone()
    }

    /// Start the classifier pool on first use.
    ///
    /// Lazy on purpose: starting six Python processes costs a second or two and
    /// ~200MB, and an app opened just to browse an already-classified library
    /// should not pay it.
    fn pool(&self) -> Option<Arc<ClassifierPool>> {
        let mut guard = self.classifier.lock().expect("classifier mutex");
        if let Some(pool) = guard.as_ref() {
            return Some(Arc::clone(pool));
        }

        let (python, script) = match (&self.classifier_python, &self.classifier_script) {
            (Some(python), Some(script)) => (python, script),
            _ => return None,
        };

        // Leave headroom: the UI thread, the webview and ffmpeg all want a core.
        let workers = num_cpus::get().saturating_sub(2).clamp(1, 8);

        match ClassifierPool::new(python, script, workers) {
            Ok(pool) => {
                let pool = Arc::new(pool);
                *guard = Some(Arc::clone(&pool));
                Some(pool)
            }
            Err(error) => {
                eprintln!("[luma] classifier unavailable: {error:#}");
                None
            }
        }
    }

    fn publish(&self, app: &AppHandle, progress: ScanProgress) {
        *self.progress.lock().expect("progress mutex") = progress.clone();
        // A failed emit means the window is gone; the scan continues regardless
        // so a closed window does not abandon a half-finished library.
        let _ = app.emit(PROGRESS_EVENT, progress);
    }
}

/// Run a full pass for one folder, then drain anything still pending globally.
///
/// Spawned on its own thread by the `scan_folder` command; everything below
/// this point is off the main thread.
pub fn run_scan(pipeline: Arc<Pipeline>, app: AppHandle, folder_id: i64, root: PathBuf) {
    if pipeline.busy.swap(true, Ordering::SeqCst) {
        // Already scanning. The watcher and a manual rescan can both land here;
        // the pipeline is idempotent, so dropping the duplicate is correct.
        return;
    }

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        glob_phase(&pipeline, &app, folder_id, &root);
        thumbnail_phase(&pipeline, &app);
        classify_phase(&pipeline, &app);
    }));

    if outcome.is_err() {
        eprintln!("[luma] scan thread panicked; the library is still consistent");
    }

    pipeline.busy.store(false, Ordering::SeqCst);

    let stats_errors = pipeline.snapshot().errors;
    pipeline.publish(
        &app,
        ScanProgress {
            phase: JobPhase::Done,
            folder_id: None,
            done: 0,
            total: 0,
            current: None,
            errors: stats_errors,
        },
    );
}

/// Thumbnail + classify everything outstanding, without re-walking any folder.
/// Used on startup and after watcher events.
pub fn run_pending(pipeline: Arc<Pipeline>, app: AppHandle) {
    if pipeline.busy.swap(true, Ordering::SeqCst) {
        return;
    }

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        thumbnail_phase(&pipeline, &app);
        classify_phase(&pipeline, &app);
    }));

    if outcome.is_err() {
        eprintln!("[luma] pending thread panicked; the library is still consistent");
    }

    pipeline.busy.store(false, Ordering::SeqCst);
    pipeline.publish(
        &app,
        ScanProgress {
            phase: JobPhase::Done,
            folder_id: None,
            done: 0,
            total: 0,
            current: None,
            errors: Vec::new(),
        },
    );
}

// ---------------------------------------------------------------------------
// Phase 1 — glob
// ---------------------------------------------------------------------------

fn glob_phase(pipeline: &Arc<Pipeline>, app: &AppHandle, folder_id: i64, root: &Path) {
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Globbing,
            folder_id: Some(folder_id),
            done: 0,
            total: 0,
            current: Some(root.display().to_string()),
            errors: Vec::new(),
        },
    );

    let (files, mut errors) = scan::walk_folder(root, |count, current| {
        pipeline.publish(
            app,
            ScanProgress {
                phase: JobPhase::Globbing,
                folder_id: Some(folder_id),
                done: count as i64,
                total: count as i64,
                current: Some(current.display().to_string()),
                errors: Vec::new(),
            },
        );
    });

    let now = now_ms();
    if let Err(error) = pipeline.db.insert_media_batch(folder_id, &files, now) {
        errors.push(format!("cannot write the index: {error:#}"));
    }

    // Drop rows whose file is gone. Cheap because it is a set difference over
    // paths we already have in memory.
    let known: std::collections::HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    if let Ok(indexed) = pipeline.db.media_paths_in_folder(folder_id) {
        for path in indexed {
            if !known.contains(path.as_str()) {
                let _ = pipeline.db.delete_media_by_path(&path);
                thumbs::forget_derived(&pipeline.thumb_root, &pipeline.frame_root, &path);
            }
        }
    }

    let _ = pipeline.db.mark_scanned(folder_id, now);

    errors.truncate(MAX_REPORTED_ERRORS);
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Globbing,
            folder_id: Some(folder_id),
            done: files.len() as i64,
            total: files.len() as i64,
            current: None,
            errors,
        },
    );
}

// ---------------------------------------------------------------------------
// Phase 2 — thumbnails (and, for videos, frame extraction)
// ---------------------------------------------------------------------------

fn thumbnail_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    let total = pipeline
        .db
        .pending_thumbnails(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if total == 0 {
        return;
    }

    let done = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    loop {
        let batch = match pipeline.db.pending_thumbnails(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };

        batch.par_iter().for_each(|file| {
            let result = match file.kind {
                MediaKind::Image => thumbnail_one_image(pipeline, file),
                MediaKind::Video => thumbnail_one_video(pipeline, file),
            };

            if let Err(error) = result {
                errors
                    .lock()
                    .expect("errors mutex")
                    .push(format!("{}: {error:#}", file.path));
                // Mark it done so a permanently broken file is not retried on
                // every single pass forever.
                let _ = pipeline.db.mark_unclassifiable(file.id, now_ms());
            }

            let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
            if finished % 25 == 0 {
                let snapshot = errors.lock().expect("errors mutex").clone();
                pipeline.publish(
                    app,
                    ScanProgress {
                        phase: JobPhase::Thumbnailing,
                        folder_id: None,
                        done: finished,
                        total,
                        current: Some(file.path.clone()),
                        errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
                    },
                );
            }
        });
    }

    let snapshot = errors.lock().expect("errors mutex").clone();
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Thumbnailing,
            folder_id: None,
            done: total,
            total,
            current: None,
            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        },
    );
}

fn thumbnail_one_image(pipeline: &Arc<Pipeline>, file: &PendingFile) -> anyhow::Result<()> {
    let thumb = thumbs::thumbnail_image(&file.path, &pipeline.thumb_root)?;
    pipeline.db.update_thumbnail(
        file.id,
        &ThumbnailUpdate {
            thumb_path: thumb.path.to_string_lossy().to_string(),
            thumb_width: i64::from(thumb.thumb_width),
            thumb_height: i64::from(thumb.thumb_height),
            width: i64::from(thumb.source_width),
            height: i64::from(thumb.source_height),
            duration_sec: None,
        },
    )?;
    Ok(())
}

fn thumbnail_one_video(pipeline: &Arc<Pipeline>, file: &PendingFile) -> anyhow::Result<()> {
    if !video::available() {
        anyhow::bail!("ffmpeg is not installed, so videos cannot be scanned");
    }

    let info = video::probe(&file.path)?;
    let timestamps = plan_frame_timestamps(info.duration_sec, SamplingOptions::default());
    let out_dir = thumbs::frame_dir(&pipeline.frame_root, &file.path);
    let frames = video::extract_frames(&file.path, &info, &timestamps, &out_dir, THUMB_MAX)?;

    // Persist the frame rows now, while the timestamps are known exactly.
    //
    // The alternative — recording only the JPEGs and recomputing timestamps at
    // classification time — silently breaks whenever extraction skipped a frame
    // (a seek past the last keyframe of a truncated file), because frame N on
    // disk is then no longer the Nth planned timestamp. Writing them together
    // keeps a frame and its position in the video inseparable.
    let unrated = serde_json::to_string(&crate::types::FrameVerdict {
        person: false,
        sexy: false,
        nude: false,
        rating: crate::types::Rating::Unrated,
        top_label: None,
        top_label_title: None,
        top_score: 0.0,
        detections: Vec::new(),
    })
    .unwrap_or_else(|_| "{}".to_string());

    let rows: Vec<NewFrame> = frames
        .iter()
        .map(|frame| NewFrame {
            frame_index: frame.frame_index,
            timestamp_sec: frame.timestamp_sec,
            path: frame.path.to_string_lossy().to_string(),
            verdict_json: unrated.clone(),
        })
        .collect();
    pipeline.db.replace_frames(file.id, &rows)?;

    // The provisional poster: the middle frame. Classification replaces it with
    // the first sexy frame if it finds one.
    let middle = &frames[frames.len() / 2];
    let (thumb_width, thumb_height) = image::image_dimensions(&middle.path)
        .map(|(w, h)| (i64::from(w), i64::from(h)))
        .unwrap_or((0, 0));

    pipeline.db.update_thumbnail(
        file.id,
        &ThumbnailUpdate {
            thumb_path: middle.path.to_string_lossy().to_string(),
            thumb_width,
            thumb_height,
            width: i64::from(info.width),
            height: i64::from(info.height),
            duration_sec: Some(info.duration_sec),
        },
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 3 — classification
// ---------------------------------------------------------------------------

fn classify_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    let total = pipeline
        .db
        .pending_classification(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if total == 0 {
        return;
    }

    let Some(pool) = pipeline.pool() else {
        pipeline.publish(
            app,
            ScanProgress {
                phase: JobPhase::Classifying,
                folder_id: None,
                done: 0,
                total,
                current: None,
                errors: vec![
                    "The classifier is not available — run `pnpm setup:python`. \
                     Files are indexed and thumbnailed, but not rated."
                        .to_string(),
                ],
            },
        );
        return;
    };

    let options = ClassifyOptions::default();
    let done = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    loop {
        let batch = match pipeline.db.pending_classification(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };

        let (videos, images): (Vec<_>, Vec<_>) = batch
            .into_iter()
            .partition(|file| file.kind == MediaKind::Video);

        // Images: many files per request, so the per-request overhead vanishes.
        images.par_chunks(BATCH_SIZE).for_each(|chunk| {
            let paths: Vec<String> = chunk
                .iter()
                .filter_map(|file| file.thumb_path.clone())
                .collect();
            if paths.len() != chunk.len() {
                return; // a row lost its thumbnail between the query and here
            }

            let results = match pool.classify(&paths) {
                Ok(results) => results,
                Err(error) => {
                    errors
                        .lock()
                        .expect("errors mutex")
                        .push(format!("classifier: {error:#}"));
                    return;
                }
            };

            for (file, result) in chunk.iter().zip(results) {
                match result {
                    Ok(detections) => {
                        let frame = rate_frame(&detections, options);
                        let verdict = from_single_frame(&frame);
                        let _ = pipeline.db.update_verdict(file.id, &verdict, now_ms());
                    }
                    Err(reason) => {
                        errors
                            .lock()
                            .expect("errors mutex")
                            .push(format!("{}: {reason}", file.path));
                        let _ = pipeline.db.mark_unclassifiable(file.id, now_ms());
                    }
                }
            }

            report(pipeline, app, &done, chunk.len() as i64, total, &errors, chunk.last());
        });

        // Videos: one file at a time, but its frames batched. A long video is
        // 60 frames, so it is already a full unit of work for one worker.
        videos.par_iter().for_each(|file| {
            if let Err(error) = classify_one_video(pipeline, &pool, file, options) {
                errors
                    .lock()
                    .expect("errors mutex")
                    .push(format!("{}: {error:#}", file.path));
                let _ = pipeline.db.mark_unclassifiable(file.id, now_ms());
            }
            report(pipeline, app, &done, 1, total, &errors, Some(file));
        });
    }

    let snapshot = errors.lock().expect("errors mutex").clone();
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Classifying,
            folder_id: None,
            done: total,
            total,
            current: None,
            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        },
    );
}

fn classify_one_video(
    pipeline: &Arc<Pipeline>,
    pool: &ClassifierPool,
    file: &PendingFile,
    options: ClassifyOptions,
) -> anyhow::Result<()> {
    // The frame rows were written during extraction, with their true
    // timestamps. Reading them back is what makes classification resumable
    // across app sessions without re-running ffmpeg.
    let existing = pipeline.db.frames_for_media(file.id)?;
    if existing.is_empty() {
        anyhow::bail!("no extracted frames recorded for this video");
    }

    let mut verdicts = Vec::with_capacity(existing.len());
    for chunk in existing.chunks(BATCH_SIZE) {
        let paths: Vec<String> = chunk.iter().map(|frame| frame.path.clone()).collect();
        for result in pool.classify(&paths)? {
            // A frame that fails to classify counts as SFW rather than
            // aborting the video — the remaining frames still decide it.
            let detections = result.unwrap_or_default();
            verdicts.push(rate_frame(&detections, options));
        }
    }

    let verdict = roll_up_video(&verdicts);

    let frames: Vec<NewFrame> = existing
        .iter()
        .zip(&verdicts)
        .map(|(frame, rated)| NewFrame {
            frame_index: frame.frame_index,
            timestamp_sec: frame.timestamp_sec,
            path: frame.path.clone(),
            verdict_json: serde_json::to_string(rated).unwrap_or_else(|_| "{}".to_string()),
        })
        .collect();
    let _ = pipeline.db.replace_frames(file.id, &frames);

    // The real poster, replacing the provisional middle frame.
    if let Some(index) = verdict.poster_frame_index {
        if let Some(frame) = existing.get(index as usize) {
            let _ = pipeline.db.update_poster(file.id, &frame.path);
        }
    }

    pipeline.db.update_verdict(file.id, &verdict, now_ms())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn report(
    pipeline: &Arc<Pipeline>,
    app: &AppHandle,
    done: &Arc<std::sync::atomic::AtomicI64>,
    delta: i64,
    total: i64,
    errors: &Arc<Mutex<Vec<String>>>,
    current: Option<&PendingFile>,
) {
    let finished = done.fetch_add(delta, Ordering::SeqCst) + delta;
    let snapshot = errors.lock().expect("errors mutex").clone();
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Classifying,
            folder_id: None,
            done: finished,
            total,
            current: current.map(|file| file.path.clone()),
            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        },
    );
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
