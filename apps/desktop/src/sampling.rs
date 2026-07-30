//! Where to sample a video for classification.
//!
//! Mirrored in `packages/core/src/sampling.ts` and pinned by the shared vectors
//! in `contracts/classify-vectors.json` — see the note at the top of
//! `rating.rs` about why this logic exists twice.

#[derive(Debug, Clone, Copy)]
pub struct SamplingOptions {
    /// Seconds between sampled frames, before the clamp stretches it.
    pub interval_sec: f64,
    /// Never sample more than this many frames from one video.
    pub max_frames: usize,
    /// Seconds to skip at the start (long videos only).
    pub skip_start_sec: f64,
    /// Seconds to skip at the end (long videos only).
    pub skip_end_sec: f64,
    /// Videos at or below this duration skip nothing.
    pub short_video_sec: f64,
}

impl Default for SamplingOptions {
    fn default() -> Self {
        Self {
            interval_sec: 10.0,
            max_frames: 60,
            skip_start_sec: 60.0,
            skip_end_sec: 45.0,
            short_video_sec: 420.0,
        }
    }
}

/// Timestamps (seconds) to grab, ascending.
///
/// Sample on an interval rather than a fixed count so a 3-minute clip and a
/// 3-hour film get comparable coverage per minute; clamp the total so one very
/// long file cannot monopolise the classifier pool; skip the head and tail of
/// long videos where logos and credits are representative of nothing. Short
/// videos skip nothing — trimming two minutes off a four-minute clip would
/// leave almost no signal.
pub fn plan_frame_timestamps(duration_sec: f64, options: SamplingOptions) -> Vec<f64> {
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return Vec::new();
    }

    let is_short = duration_sec <= options.short_video_sec;
    let mut start = if is_short { 0.0 } else { options.skip_start_sec };
    let mut end = duration_sec - if is_short { 0.0 } else { options.skip_end_sec };

    // The skips can swallow the whole video (a 70-second file with a 60s head
    // skip). Fall back to the untrimmed range rather than returning nothing.
    if end - start < options.interval_sec {
        start = 0.0;
        end = duration_sec;
    }

    let span = end - start;
    let wanted = ((span / options.interval_sec).floor() as usize).max(1);
    let count = wanted.min(options.max_frames);
    let step = if count == 1 { 0.0 } else { span / count as f64 };

    // Never seek to the exact final byte — some containers return no frame there.
    let ceiling = (duration_sec - 0.1).max(0.0);

    (0..count)
        .map(|i| {
            let at = if count == 1 {
                start + span / 2.0
            } else {
                start + step * i as f64
            };
            at.min(ceiling)
        })
        .collect()
}
