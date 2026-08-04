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

use crate::classifier::{ClassifierPool, ClassifyMode, BATCH_SIZE};
use crate::db::{Db, NewFrame, PendingFile, PhaseQueue, ThumbnailUpdate};
use crate::rating::{self, from_single_frame, rate_frame, roll_up_video, ClassifyOptions};
use crate::sampling::{plan_frame_timestamps, SamplingOptions};
use crate::throttle::Throttle;
use crate::thumbs::{self, THUMB_MAX};
use crate::types::{Detection, JobPhase, MediaKind, ScanProgress};
use crate::{dupes, generated, imports, scan, video};

/// The event the frontend listens on. One event shape for every phase, so the
/// status bar is a single component and adding a phase costs the UI nothing.
pub const PROGRESS_EVENT: &str = "luma://progress";

/// How many rows to pull per pass. Bounded so a million-file library does not
/// materialise a million-element Vec, and so progress is emitted regularly.
const PAGE: i64 = 512;

/// Errors kept in the live progress payload. The full list would be unbounded
/// on a broken NAS mount, and nobody reads past the first handful.
const MAX_REPORTED_ERRORS: usize = 50;

/// Threads for the thumbnail phase.
///
/// One per core, because this phase is **CPU-bound, not latency-bound**. That
/// is the opposite of how it looks, and the earlier reading of it was wrong in
/// a way worth recording.
///
/// Timed per file against the real SMB library, separating the two costs:
///
/// ```text
/// read a 0.6 MB JPEG off the share    0.012s   (~46 MB/s)
/// decode it                           0.400s
/// ```
///
/// Reading is **3%** of the work. The share is not the bottleneck and never
/// was; more threads cannot hide a latency that is not there. The earlier
/// experiment here — `cores * 4` collapsing throughput from 1.20 files/second
/// to 0.10 — was read as SMB degrading under concurrency, but 40 threads each
/// wanting a full core on a 10-core machine is plain CPU oversubscription, and
/// the measured CPU *drop* from 253% to 102% is what thrashing looks like.
///
/// The 0.400s decode above is itself a dev-build number; see the
/// `profile.dev.package` note in `Cargo.toml`, which brings it to 0.007s. Once
/// decoding is that cheap the balance may genuinely shift toward I/O — so if
/// this is ever raised, measure the two costs again first rather than
/// re-deriving from either intuition.
fn thumbnail_threads(throttle: &Throttle) -> usize {
    throttle.limit(num_cpus::get())
}

/// A rayon pool sized for the current throttle.
///
/// `None` means "the global pool is already small enough". Every phase that
/// fans out needs one of these: `par_iter` uses rayon's global pool, which is
/// sized to the core count and knows nothing about the throttle. Limiting only
/// the classifier pool bounds how many *models* run at once but not how many
/// threads are calling them, which measured at 42% of a 16-core machine on a
/// level asking for 25%.
fn phase_pool(pipeline: &Arc<Pipeline>, name: &'static str) -> Option<rayon::ThreadPool> {
    let cores = num_cpus::get();
    let threads = pipeline.throttle.limit(cores);
    if threads >= cores {
        return None;
    }
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(move |i| format!("luma-{name}-{i}"))
        .build()
        .ok()
}

pub struct Pipeline {
    db: Arc<Db>,
    classifier: Arc<Mutex<Option<Arc<ClassifierPool>>>>,
    classifier_python: Option<PathBuf>,
    classifier_script: Option<PathBuf>,
    thumb_root: PathBuf,
    frame_root: PathBuf,
    progress: Arc<Mutex<ScanProgress>>,
    busy: Arc<AtomicBool>,
    throttle: Arc<Throttle>,
}

impl Pipeline {
    pub fn new(
        db: Arc<Db>,
        thumb_root: PathBuf,
        frame_root: PathBuf,
        classifier_python: Option<PathBuf>,
        classifier_script: Option<PathBuf>,
        throttle: Arc<Throttle>,
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
            throttle,
        }
    }

    pub fn throttle(&self) -> &Arc<Throttle> {
        &self.throttle
    }

    /// Drop the classifier pool so the next phase rebuilds it.
    ///
    /// The pool's size and its workers' thread budget are both fixed at spawn,
    /// so a throttle that changes after the pool is up would otherwise not take
    /// effect until the app restarted.
    pub fn reset_pool(&self) {
        let mut guard = self.classifier.lock().expect("classifier mutex");
        *guard = None;
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
        let workers = self
            .throttle
            .limit(num_cpus::get().saturating_sub(2).clamp(1, 8));

        match ClassifierPool::new(python, script, workers, &self.throttle.worker_env()) {
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
        // Before thumbnails: a sized tile that never moves is worth more than a
        // painted one that shoves the rest of the wall around when it arrives.
        measure_phase(&pipeline, &app);
        thumbnail_phase(&pipeline, &app);
        classify_phase(&pipeline, &app);
        hash_phase(&pipeline, &app);
        label_phase(&pipeline, &app);
        // Last: everything above rates the library, this only refines it.
        anime_phase(&pipeline, &app);
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

/// Re-walk every watched folder, then drain the pipeline. Run once at startup.
///
/// The watcher only sees changes while the app is running, so anything added,
/// removed or replaced while it was closed is invisible until something walks
/// the tree again. Without this, a folder could sit in the index untouched
/// forever — including one that has never been scanned at all.
///
/// The walk is cheap relative to what follows: inserts are
/// `ON CONFLICT DO NOTHING`, so a rescan of an unchanged library is a directory
/// traversal and a few thousand no-op inserts, and it never disturbs an
/// existing row's thumbnail or verdict.
pub fn run_startup(pipeline: Arc<Pipeline>, app: AppHandle) {
    if pipeline.busy.swap(true, Ordering::SeqCst) {
        return;
    }

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let folders = pipeline.db.list_folders().unwrap_or_default();

        // 1. Folders that have never been scanned. Nothing else can happen for
        //    these until they are walked, so they cannot wait.
        for folder in folders.iter().filter(|f| f.last_scan_at.is_none()) {
            glob_phase(&pipeline, &app, folder.id, Path::new(&folder.path));
        }

        // 2. Bring existing verdicts up to the current rules first. Cheap, and
        //    it means the grid is self-consistent before new work lands in it.
        rerate_phase(&pipeline, &app);

        // 3. Resume outstanding work BEFORE re-walking known folders.
        //
        //    Walking a large NAS share takes many minutes, and putting it first
        //    means every restart sits idle for that long before producing a
        //    single thumbnail — painful during development, and baffling to a
        //    user who just reopened the app. Draining first means a restart
        //    picks up exactly where it left off, immediately.
        measure_phase(&pipeline, &app);
        thumbnail_phase(&pipeline, &app);
        classify_phase(&pipeline, &app);

        // 3. Now look for anything that changed while the app was closed. The
        //    watcher cannot see those, so this pass is the only thing that
        //    finds them.
        for folder in folders.iter().filter(|f| f.last_scan_at.is_some()) {
            glob_phase(&pipeline, &app, folder.id, Path::new(&folder.path));
        }

        // 4. Whatever step 3 turned up.
        thumbnail_phase(&pipeline, &app);
        classify_phase(&pipeline, &app);

        // 5. Structural tags and perceptual hashes. Both cheap, and both
        //    about what the grid shows rather than how anything is rated.
        hash_phase(&pipeline, &app);
        label_phase(&pipeline, &app);

        // 6. Only now the expensive second opinion, over everything that came
        //    out SFW. Deliberately after the walk in step 3: a file discovered
        //    this launch deserves a rating before an already-rated file
        //    deserves a better one.
        anime_phase(&pipeline, &app);
    }));

    if outcome.is_err() {
        eprintln!("[luma] startup scan panicked; the library is still consistent");
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

/// Thumbnail + classify everything outstanding, without re-walking any folder.
/// Used after watcher events and by the retry command.
pub fn run_pending(pipeline: Arc<Pipeline>, app: AppHandle) {
    if pipeline.busy.swap(true, Ordering::SeqCst) {
        return;
    }

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        thumbnail_phase(&pipeline, &app);
        classify_phase(&pipeline, &app);
        hash_phase(&pipeline, &app);
        label_phase(&pipeline, &app);
        anime_phase(&pipeline, &app);
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
    let excluded = pipeline.db.excluded_folders().unwrap_or_default();
    // An unreachable root is not an empty folder. Walking one returns nothing,
    // and the prune below would then read "every file has been deleted" and
    // wipe the folder's entire index. Unplugging a NAS must not cost you your
    // library, so bail before doing any work.
    if !root.is_dir() {
        pipeline.publish(
            app,
            ScanProgress {
                phase: JobPhase::Globbing,
                folder_id: Some(folder_id),
                done: 0,
                total: 0,
                current: None,
                errors: vec![format!(
                    "{} is not reachable — skipped, and its index was left untouched",
                    root.display()
                )],
            },
        );
        return;
    }

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

    let scan::Walk {
        files,
        rating_databases,
        mut errors,
    } = scan::walk_folder(root, &excluded, |count, current| {
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
        // Second guard, for the case `is_dir()` cannot catch: a share that is
        // mounted but empty because it has not finished coming up, or a
        // permission failure that made the walk yield nothing. Deleting
        // thousands of rows is never the right response to finding zero files.
        if !is_prune_trustworthy(files.len(), indexed.len()) {
            errors.push(format!(
                "{} returned no files but has {} indexed — nothing was pruned",
                root.display(),
                indexed.len()
            ));
        } else {
            for path in indexed {
                if !known.contains(path.as_str()) {
                    // Read the key before the row goes, then only drop the
                    // derived files once nothing else points at them — under
                    // content addressing a duplicate elsewhere shares them.
                    let key = pipeline.db.content_key_for_path(&path).ok().flatten();
                    let _ = pipeline.db.delete_media_by_path(&path);
                    if let Some(key) = key {
                        if pipeline.db.rows_with_content_key(&key).unwrap_or(1) == 0 {
                            thumbs::forget_derived(
                                &pipeline.thumb_root,
                                &pipeline.frame_root,
                                &key,
                            );
                        }
                    }
                }
            }
        }
    }

    let _ = pipeline.db.mark_scanned(folder_id, now);

    // Ratings travel with the folder. An Image Browser database sits inside the
    // webui whose output this is, so a walk that found the images has already
    // walked past the file recording what someone thought of them — and going
    // back for it by hand is a step nobody should have to know about.
    //
    // Staged rather than applied: the rows these name may not exist yet, and
    // each claims its rating as it is indexed.
    if !rating_databases.is_empty() {
        let staged = imports::import_discovered(&pipeline.db, &rating_databases, now);
        if staged > 0 {
            let _ = pipeline.db.apply_all_imported_stars();
        }
    }

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

/// Re-apply the rating rules to verdicts that predate them.
///
/// Runs only when `RATING_VERSION` has moved past what the index recorded, and
/// costs no inference at all: the detections are already stored per frame, so a
/// threshold change is arithmetic over data we have. On a 66,000-file library
/// that is the difference between seconds and an hour of model time.
///
/// Rows without frames are skipped rather than guessed at — there is nothing to
/// recompute from, and inventing a verdict would be worse than keeping a stale
/// one that at least came from a real detection.
fn rerate_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    let recorded = pipeline.db.rating_version().unwrap_or(0);
    if recorded == rating::RATING_VERSION {
        return;
    }

    let Ok(rows) = pipeline.db.rows_with_frames() else {
        return;
    };
    if rows.is_empty() {
        let _ = pipeline.db.set_rating_version(rating::RATING_VERSION);
        return;
    }

    let total = rows.len() as i64;
    eprintln!(
        "[luma] rating rules moved {recorded} -> {}; re-rating {total} rows from stored detections",
        rating::RATING_VERSION
    );

    let options = ClassifyOptions::default();
    let done = Arc::new(std::sync::atomic::AtomicI64::new(0));

    for row in &rows {
        let Ok(frames) = pipeline.db.frames_for_media(row.id) else {
            continue;
        };
        if frames.is_empty() {
            continue;
        }

        // Re-rate each frame from its detections, then roll up exactly as the
        // classify phase would. Same functions, so the two cannot drift.
        let rated: Vec<_> = frames
            .iter()
            .map(|frame| rate_frame(&frame.verdict.detections, options))
            .collect();

        let verdict = match row.kind {
            MediaKind::Image => from_single_frame(&rated[0]),
            MediaKind::Video => roll_up_video(&rated),
        };

        let stored: Vec<NewFrame> = frames
            .iter()
            .zip(&rated)
            .map(|(frame, verdict)| NewFrame {
                frame_index: frame.frame_index,
                timestamp_sec: frame.timestamp_sec,
                path: frame.path.clone(),
                verdict_json: serde_json::to_string(verdict).unwrap_or_else(|_| "{}".to_string()),
            })
            .collect();
        let _ = pipeline.db.replace_frames(row.id, &stored);

        // The poster follows the same rule as the rating, so a threshold change
        // can move it — the first sexy frame may now be an earlier one.
        if row.kind == MediaKind::Video {
            if let Some(index) = verdict.poster_frame_index {
                if let Some(frame) = frames.get(index as usize) {
                    let _ = pipeline.db.update_poster(row.id, &frame.path);
                }
            }
        }

        let _ = pipeline.db.update_verdict(row.id, &verdict, now_ms());

        let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
        if finished % 500 == 0 {
            pipeline.publish(
                app,
                ScanProgress {
                    phase: JobPhase::Classifying,
                    folder_id: None,
                    done: finished,
                    total,
                    current: Some(row.path.clone()),
                    errors: Vec::new(),
                },
            );
        }
    }

    // Only after the sweep completes: a version bump on a partial pass would
    // strand the remainder on the old rules forever.
    let _ = pipeline.db.set_rating_version(rating::RATING_VERSION);
    eprintln!("[luma] re-rating complete");
}

/// Record every file's dimensions, so the grid can lay out before it can paint.
///
/// Runs before thumbnailing and finishes far sooner: `image_dimensions` reads a
/// header, not pixels. Measured on the SMB library this was built against, a
/// full read is 12ms against a 400ms decode — and the header is a fraction of
/// the read. The whole library therefore stops moving within a minute, instead
/// of shifting for as long as thumbnailing runs.
///
/// A failure here is deliberately *not* recorded as a row failure: a header the
/// `image` crate cannot parse may still decode through the ffmpeg fallback
/// later, and marking it failed now would deny it that chance. The row simply
/// keeps its unknown size and the thumbnail phase fills it in.
fn measure_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    let outstanding = pipeline
        .db
        .pending_dimensions(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if outstanding == 0 {
        return;
    }
    // Report against the library, not this run — see `completed_in_phase`.
    let already = pipeline.db.completed_in_phase(PhaseQueue::Dimensions).unwrap_or(0);
    let total = already + outstanding;

    let done = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(thumbnail_threads(&pipeline.throttle))
        .thread_name(|i| format!("luma-measure-{i}"))
        .build()
        .ok();

    // Tracks rows this phase could not measure. Without it the queue — which is
    // "width IS NULL", and which this phase deliberately does not fail rows out
    // of — would hand back the same unreadable files forever.
    let mut stuck = std::collections::HashSet::new();

    loop {
        let batch = match pipeline.db.pending_dimensions(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };
        let batch: Vec<_> = batch.into_iter().filter(|f| !stuck.contains(&f.id)).collect();
        if batch.is_empty() {
            break;
        }

        let failed = Mutex::new(Vec::new());
        let work = || {
            batch.par_iter().for_each(|file| {
                let measured = match file.kind {
                    MediaKind::Image => image::image_dimensions(&file.path)
                        .ok()
                        .map(|(w, h)| (i64::from(w), i64::from(h), None)),
                    MediaKind::Video => video::probe(&file.path)
                        .ok()
                        .map(|i| (i64::from(i.width), i64::from(i.height), Some(i.duration_sec))),
                };

                // Two 64KB reads, taken here because this phase already has the
                // file open-ish and every later phase wants the key.
                let key = thumbs::content_key(&file.path).ok();

                match measured {
                    Some((width, height, duration)) if width > 0 && height > 0 => {
                        let _ = pipeline.db.update_dimensions(
                            file.id,
                            width,
                            height,
                            duration,
                            key.as_deref(),
                        );
                    }
                    _ => failed.lock().expect("failed mutex").push(file.id),
                }

                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                if finished % 100 == 0 {
                    pipeline.publish(
                        app,
                        ScanProgress {
                            phase: JobPhase::Measuring,
                            folder_id: None,
                            done: already + finished,
                            total,
                            current: Some(file.path.clone()),
                            errors: Vec::new(),
                        },
                    );
                }
            });
        };

        match pool.as_ref() {
            Some(pool) => pool.install(work),
            None => work(),
        }

        stuck.extend(failed.into_inner().expect("failed mutex"));
    }

    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Measuring,
            folder_id: None,
            done: total,
            total,
            current: None,
            errors: Vec::new(),
        },
    );
}

fn thumbnail_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    let outstanding = pipeline
        .db
        .pending_thumbnails(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if outstanding == 0 {
        return;
    }
    let already = pipeline.db.completed_in_phase(PhaseQueue::Thumbnails).unwrap_or(0);
    let total = already + outstanding;

    let done = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    // A dedicated pool rather than rayon's global one — see `thumbnail_threads`.
    // Falling back to the global pool on failure keeps a thread-starved machine
    // working rather than refusing to scan.
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(thumbnail_threads(&pipeline.throttle))
        .thread_name(|i| format!("luma-thumb-{i}"))
        .build()
        .ok();

    loop {
        let batch = match pipeline.db.pending_thumbnails(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };

        let work = || {
            batch.par_iter().for_each(|file| {
                let started = std::time::Instant::now();
                let result = match file.kind {
                    MediaKind::Image => thumbnail_one_image(pipeline, file),
                    MediaKind::Video => thumbnail_one_video(pipeline, file),
                };

                if let Err(error) = result {
                    let message = format!("{error:#}");
                    errors
                        .lock()
                        .expect("errors mutex")
                        .push(format!("{}: {message}", file.path));
                    // `mark_failed`, NOT a bare "mark classified": this queue is
                    // `thumb_path IS NULL AND error IS NULL`, so a row that fails
                    // without setting `error` comes straight back on the next
                    // iteration and the phase spins on it forever.
                    let _ = pipeline.db.mark_failed(file.id, &message, now_ms());
                }

                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                if finished % 25 == 0 {
                    let snapshot = errors.lock().expect("errors mutex").clone();
                    pipeline.publish(
                        app,
                        ScanProgress {
                            phase: JobPhase::Thumbnailing,
                            folder_id: None,
                            done: already + finished,
                            total,
                            current: Some(file.path.clone()),
                            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
                        },
                    );
                }
                // Per file rather than per batch: decoding is the single most
                // expensive thing this app does, and a 512-file batch would
                // hold the machine for minutes before the first sleep.
                pipeline.throttle.pace(started.elapsed());
            });
        };

        match pool.as_ref() {
            Some(pool) => pool.install(work),
            None => work(),
        }
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

/// The key derived files are addressed by, computed on demand if the measure
/// phase did not get there first.
fn key_for(file: &PendingFile) -> anyhow::Result<String> {
    match &file.content_key {
        Some(key) => Ok(key.clone()),
        None => thumbs::content_key(&file.path),
    }
}

fn thumbnail_one_image(pipeline: &Arc<Pipeline>, file: &PendingFile) -> anyhow::Result<()> {
    let key = key_for(file)?;
    let thumb = thumbs::thumbnail_image(&file.path, &key, &pipeline.thumb_root)?;
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
    let out_dir = thumbs::frame_dir(&pipeline.frame_root, &key_for(file)?);
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

/// Rate everything with no verdict yet.
///
/// A thin loop around one pass, because changing the CPU throttle has to take
/// effect on a phase that is *already running* — over a library this size a
/// single pass is hours. A pass abandons its work when the setting moves and
/// asks to be run again; its pools go out of scope with it, so the next one
/// builds them at the new size.
fn classify_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    while classify_pass(pipeline, app) {}
}

fn classify_pass(pipeline: &Arc<Pipeline>, app: &AppHandle) -> bool {
    let outstanding = pipeline
        .db
        .pending_classification(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if outstanding == 0 {
        return false;
    }
    let already = pipeline.db.completed_in_phase(PhaseQueue::Classification).unwrap_or(0);
    let total = already + outstanding;

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
        return false;
    };

    let options = ClassifyOptions::default();
    // Seeded with what the library already has, so the count this phase
    // publishes is library-wide rather than run-local.
    let done = Arc::new(std::sync::atomic::AtomicI64::new(already));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    // Captured so the loop can tell the setting changed under it.
    let generation = pipeline.throttle.generation();
    let drain = || loop {
        if pipeline.throttle.generation() != generation {
            return; // rebuild the pools at the new size
        }
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

            let started = std::time::Instant::now();
            let results = match pool.classify(&paths, ClassifyMode::Detect) {
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

                        // Keep the frame row for images too, not just videos.
                        //
                        // The rolled-up `MediaVerdict` records what was found —
                        // rating, top label, score — but not *where*: the boxes
                        // live on the per-frame verdict and were being dropped
                        // on the floor for every image. That left the lightbox
                        // with nothing to draw and "Show boxes" doing nothing on
                        // the entire image half of a library.
                        //
                        // An image is simply a one-frame video here, which is
                        // why this needs no new table, no wire-format change,
                        // and no branch in the UI: the lightbox already reads
                        // `frames[0].verdict.detections`.
                        if let Ok(verdict_json) = serde_json::to_string(&frame) {
                            let _ = pipeline.db.replace_frames(
                                file.id,
                                &[NewFrame {
                                    frame_index: 0,
                                    // The classifier reads the thumbnail, so
                                    // that is what the boxes are relative to.
                                    // Fractions make them resolution-agnostic,
                                    // so they still land correctly over the
                                    // full-size original in the lightbox.
                                    timestamp_sec: 0.0,
                                    path: file.thumb_path.clone().unwrap_or_default(),
                                    verdict_json,
                                }],
                            );
                        }
                    }
                    Err(reason) => {
                        errors
                            .lock()
                            .expect("errors mutex")
                            .push(format!("{}: {reason}", file.path));
                        let _ = pipeline.db.mark_failed(file.id, &reason, now_ms());
                    }
                }
            }

            report(
                pipeline,
                app,
                JobPhase::Classifying,
                &done,
                chunk.len() as i64,
                total,
                &errors,
                chunk.last(),
            );
            pipeline.throttle.pace(started.elapsed());
        });

        // Videos: one file at a time, but its frames batched. A long video is
        // 60 frames, so it is already a full unit of work for one worker.
        videos.par_iter().for_each(|file| {
            let started = std::time::Instant::now();
            if let Err(error) = classify_one_video(pipeline, &pool, file, options) {
                let message = format!("{error:#}");
                errors
                    .lock()
                    .expect("errors mutex")
                    .push(format!("{}: {message}", file.path));
                let _ = pipeline.db.mark_failed(file.id, &message, now_ms());
            }
            report(
                pipeline,
                app,
                JobPhase::Classifying,
                &done,
                1,
                total,
                &errors,
                Some(file),
            );
            pipeline.throttle.pace(started.elapsed());
        });
    };

    match phase_pool(pipeline, "classify") {
        Some(pool) => pool.install(drain),
        None => drain(),
    }
    if pipeline.throttle.generation() != generation {
        // Ask to be run again rather than looping in place. Returning is what
        // releases the classifier pool: restarting while this pass still held
        // its `Arc` would leave the old workers alive beside their
        // replacements.
        return true;
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

    false
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
        for result in pool.classify(&paths, ClassifyMode::Detect)? {
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

// ---------------------------------------------------------------------------
// Phase 5 — perceptual hashes
// ---------------------------------------------------------------------------

/// Give every image a perceptual hash, so duplicates can be found later.
///
/// Its own pass rather than part of thumbnailing, because the library that
/// needs it most is the one that was already scanned. Reads the thumbnail, not
/// the original: local instead of on a share, already decoded once, and already
/// normalised to a common size — which is the first thing a perceptual hash
/// does anyway, and the reason resolution stops mattering.
///
/// Images only. A video's duplicates are found by its content key, which the
/// scan already computed.
fn hash_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    let outstanding = pipeline
        .db
        .pending_hashes(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if outstanding == 0 {
        return;
    }
    let done = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    let drain = || loop {
        let batch = match pipeline.db.pending_hashes(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };

        batch.par_iter().for_each(|file| {
            let started = std::time::Instant::now();
            let Some(thumb) = file.thumb_path.as_deref() else {
                return;
            };
            match dupes::fingerprint(Path::new(thumb)) {
                Ok((hash, colour)) => {
                    let _ = pipeline.db.set_fingerprint(file.id, hash, &colour);
                }
                Err(error) => {
                    // A thumbnail that will not decode is not a scan failure —
                    // the row keeps its verdict and simply never participates
                    // in duplicate search. Marking it failed would pull it out
                    // of the grid over a feature it never asked for.
                    errors
                        .lock()
                        .expect("errors mutex")
                        .push(format!("{}: {error}", file.path));
                    let _ = pipeline.db.set_fingerprint(file.id, 0, &[]);
                }
            }
            report(
                pipeline,
                app,
                JobPhase::Hashing,
                &done,
                1,
                outstanding,
                &errors,
                Some(file),
            );
            pipeline.throttle.pace(started.elapsed());
        });
    };

    match phase_pool(pipeline, "hash") {
        Some(pool) => pool.install(drain),
        None => drain(),
    }

    let snapshot = errors.lock().expect("errors mutex").clone();
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Hashing,
            folder_id: None,
            done: outstanding,
            total: outstanding,
            current: None,
            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        },
    );
}

// ---------------------------------------------------------------------------
// Phase 6 — structural labels
// ---------------------------------------------------------------------------

/// Work out what *kind* of picture each row is, independent of its rating.
///
/// Two questions, answered together because they share a queue:
///
/// - **Is it a document?** Decided from the thumbnail by the Python worker,
///   which already has OpenCV and already has the file open.
/// - **Was it generated?** Decided from the original's first 96KB in Rust, so
///   it still works when the classifier is unavailable.
///
/// Neither answer touches a verdict. A scanned payslip and a generated
/// illustration are rated by exactly the same rules as anything else; these
/// tags only decide whether you are shown them.
fn label_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    while label_pass(pipeline, app) {}
}

fn label_pass(pipeline: &Arc<Pipeline>, app: &AppHandle) -> bool {
    let outstanding = pipeline
        .db
        .pending_labels(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if outstanding == 0 {
        return false;
    }

    let already = pipeline.db.completed_in_phase(PhaseQueue::Labels).unwrap_or(0);
    let total = already + outstanding;
    let done = Arc::new(std::sync::atomic::AtomicI64::new(already));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    // Optional: without it, rows still get their `generated` tag. Documents
    // need pixels, and pixels need the worker.
    let pool = pipeline.pool();

    // Captured so the loop can tell the setting changed under it.
    let generation = pipeline.throttle.generation();
    let drain = || loop {
        if pipeline.throttle.generation() != generation {
            return; // rebuild the pools at the new size
        }
        let batch = match pipeline.db.pending_labels(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };

        batch.par_chunks(BATCH_SIZE).for_each(|chunk| {
            let started = std::time::Instant::now();
            // Only images are examined for document structure — a video is not
            // a scan of anything, and sending 60 frames per file through this
            // would cost more than the whole pass is worth.
            let candidates: Vec<(usize, String)> = chunk
                .iter()
                .enumerate()
                .filter(|(_, file)| file.kind == MediaKind::Image)
                .filter_map(|(index, file)| {
                    file.thumb_path.clone().map(|thumb| (index, thumb))
                })
                .collect();

            let mut structural: Vec<Vec<String>> = vec![Vec::new(); chunk.len()];
            if let Some(pool) = pool.as_ref() {
                let paths: Vec<String> =
                    candidates.iter().map(|(_, thumb)| thumb.clone()).collect();
                match pool.label(&paths) {
                    Ok(results) => {
                        for ((index, _), outcome) in candidates.iter().zip(results) {
                            match outcome {
                                Ok(tags) => structural[*index] = tags,
                                Err(reason) => errors
                                    .lock()
                                    .expect("errors mutex")
                                    .push(format!("{}: {reason}", chunk[*index].path)),
                            }
                        }
                    }
                    Err(error) => errors
                        .lock()
                        .expect("errors mutex")
                        .push(format!("labeller: {error:#}")),
                }
            }

            for (index, file) in chunk.iter().enumerate() {
                let mut tags = std::mem::take(&mut structural[index]);
                let generation = generated::read_generation(Path::new(&file.path));
                if generation.is_some() {
                    tags.push("generated".to_string());
                }
                let _ = pipeline.db.set_tags(file.id, &tags, now_ms());
                let _ = pipeline.db.set_generation(file.id, generation.as_ref());
                // A rating imported from an Image Browser database is keyed by
                // where the file used to live, so it can only be applied once
                // the row exists. Doing it here means an import can precede the
                // scan that gives it something to attach to.
                let _ = pipeline.db.apply_imported_stars(file.id, &file.path);
            }

            report(
                pipeline,
                app,
                JobPhase::Labelling,
                &done,
                chunk.len() as i64,
                total,
                &errors,
                chunk.last(),
            );
            pipeline.throttle.pace(started.elapsed());
        });
    };

    match phase_pool(pipeline, "label") {
        Some(rayon_pool) => rayon_pool.install(drain),
        None => drain(),
    }
    if pipeline.throttle.generation() != generation {
        // Ask to be run again rather than looping in place. Returning is what
        // releases the classifier pool: restarting while this pass still held
        // its `Arc` would leave the old workers alive beside their
        // replacements.
        return true;
    }

    let snapshot = errors.lock().expect("errors mutex").clone();
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Labelling,
            folder_id: None,
            done: total,
            total,
            current: None,
            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        },
    );

    false
}

// ---------------------------------------------------------------------------
// Phase 6 — the anime tagger's second opinion
// ---------------------------------------------------------------------------

/// Re-examine SFW rows with the Danbooru tagger.
///
/// # Why this is a separate pass rather than part of classification
///
/// Running both models on every file measured at 2.13 files/s against 4.13 for
/// NudeNet alone on the same library — the tagger is a 378MB ViT at 448px and
/// roughly doubles the cost of rating a file. Paying that up front means
/// nothing is rated until everything is.
///
/// Splitting it gets the whole library rated at full speed, then improves the
/// drawn-content answer afterwards. The queue is a query like every other
/// phase, so it is resumable and interruptible: stopping here leaves a fully
/// rated library that is merely less accurate about illustrations.
///
/// Only SFW rows are queued. The tagger can raise a rating and never lower one,
/// so running it on something already flagged spends the most expensive model
/// in the app to confirm a decision that has already been made.
fn anime_phase(pipeline: &Arc<Pipeline>, app: &AppHandle) {
    while anime_pass(pipeline, app) {}
}

fn anime_pass(pipeline: &Arc<Pipeline>, app: &AppHandle) -> bool {
    let outstanding = pipeline
        .db
        .pending_anime(i64::MAX)
        .map(|rows| rows.len() as i64)
        .unwrap_or(0);
    if outstanding == 0 {
        return false;
    }

    let Some(pool) = pipeline.pool() else {
        return false; // no classifier: the library keeps its NudeNet verdicts
    };

    let already = pipeline.db.completed_in_phase(PhaseQueue::AnimeReview).unwrap_or(0);
    let total = already + outstanding;
    let options = ClassifyOptions::default();
    let done = Arc::new(std::sync::atomic::AtomicI64::new(already));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    // Captured so the loop can tell the setting changed under it.
    let generation = pipeline.throttle.generation();
    let drain = || loop {
        if pipeline.throttle.generation() != generation {
            return; // rebuild the pools at the new size
        }
        let batch = match pipeline.db.pending_anime(PAGE) {
            Ok(batch) if !batch.is_empty() => batch,
            _ => break,
        };

        batch.par_iter().for_each(|file| {
            let started = std::time::Instant::now();
            if let Err(error) = tag_one(pipeline, &pool, file, options) {
                errors
                    .lock()
                    .expect("errors mutex")
                    .push(format!("{}: {error:#}", file.path));
            }
            // Stamped whatever happened, including on failure: a row that
            // cannot be tagged must leave the queue or the phase never ends.
            let _ = pipeline.db.mark_anime_done(file.id, now_ms());
            report(
                pipeline,
                app,
                JobPhase::Tagging,
                &done,
                1,
                total,
                &errors,
                Some(file),
            );
            pipeline.throttle.pace(started.elapsed());
        });
    };

    match phase_pool(pipeline, "anime") {
        Some(rayon_pool) => rayon_pool.install(drain),
        None => drain(),
    }
    if pipeline.throttle.generation() != generation {
        // Ask to be run again rather than looping in place. Returning is what
        // releases the classifier pool: restarting while this pass still held
        // its `Arc` would leave the old workers alive beside their
        // replacements.
        return true;
    }

    let snapshot = errors.lock().expect("errors mutex").clone();
    pipeline.publish(
        app,
        ScanProgress {
            phase: JobPhase::Tagging,
            folder_id: None,
            done: total,
            total,
            current: None,
            errors: snapshot.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        },
    );

    false
}

/// Merge the tagger's findings into one row's stored detections and re-rate.
///
/// Works off the frames already in the index rather than re-running NudeNet, so
/// this pass costs exactly one tagger inference per frame and no more. An image
/// is a one-frame video here, the same way it is everywhere else.
fn tag_one(
    pipeline: &Arc<Pipeline>,
    pool: &ClassifierPool,
    file: &PendingFile,
    options: ClassifyOptions,
) -> anyhow::Result<()> {
    let existing = pipeline.db.frames_for_media(file.id)?;
    if existing.is_empty() {
        anyhow::bail!("no frames recorded to re-examine");
    }

    let mut verdicts = Vec::with_capacity(existing.len());
    for chunk in existing.chunks(BATCH_SIZE) {
        let paths: Vec<String> = chunk.iter().map(|frame| frame.path.clone()).collect();
        let found = pool.classify(&paths, ClassifyMode::Anime)?;
        for (frame, result) in chunk.iter().zip(found) {
            // Anything already carrying `ANIME_*` is being re-examined, so the
            // old opinion is dropped rather than appended to. Without this a
            // second pass would stack two copies of every finding.
            let mut merged: Vec<Detection> = frame
                .verdict
                .detections
                .iter()
                .filter(|detection| !detection.label.starts_with("ANIME_"))
                .cloned()
                .collect();
            merged.extend(result.unwrap_or_default());
            verdicts.push(rate_frame(&merged, options));
        }
    }

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

    let verdict = if file.kind == MediaKind::Video {
        let rolled = roll_up_video(&verdicts);
        // The poster follows the rating: a video the tagger just promoted
        // should show the frame that earned it, not its middle.
        if let Some(index) = rolled.poster_frame_index {
            if let Some(frame) = existing.get(index as usize) {
                let _ = pipeline.db.update_poster(file.id, &frame.path);
            }
        }
        rolled
    } else {
        from_single_frame(&verdicts[0])
    };

    pipeline.db.update_verdict(file.id, &verdict, now_ms())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn report(
    pipeline: &Arc<Pipeline>,
    app: &AppHandle,
    phase: JobPhase,
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
            phase,
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

/// Whether a walk result is trustworthy enough to delete rows from.
///
/// "Found nothing where there used to be something" is what an unmounted share,
/// a half-mounted share and a permission failure all look like — and it is
/// indistinguishable from a genuinely emptied folder. Deleting thousands of
/// rows is never the right response to that ambiguity: the cost of being wrong
/// is a wiped library, while the cost of skipping a legitimate prune is some
/// stale rows that the next successful scan cleans up.
fn is_prune_trustworthy(walked: usize, indexed: usize) -> bool {
    walked > 0 || indexed == 0
}

#[cfg(test)]
mod tests {
    use super::is_prune_trustworthy;

    #[test]
    fn a_normal_walk_prunes() {
        assert!(is_prune_trustworthy(500, 520), "some files gone is normal");
        assert!(is_prune_trustworthy(500, 500));
        assert!(is_prune_trustworthy(1, 9_000), "even a drastic drop, if real");
    }

    #[test]
    fn an_empty_walk_over_a_populated_index_never_prunes() {
        assert!(
            !is_prune_trustworthy(0, 1),
            "an unmounted share must not wipe the index"
        );
        assert!(!is_prune_trustworthy(0, 40_000));
    }

    #[test]
    fn an_empty_walk_over_an_empty_index_is_fine() {
        // Nothing to delete, so there is no ambiguity to be careful about.
        assert!(is_prune_trustworthy(0, 0));
    }
}
