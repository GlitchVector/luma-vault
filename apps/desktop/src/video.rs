//! Video probing and frame extraction, via the ffmpeg CLI.
//!
//! Every invocation passes an argv array rather than a formatted shell string.
//! The corn-dog generation of this code built commands by interpolating the
//! video path into a string and running it through `execSync`, which means a
//! filename containing a quote or a `$(` was a command-injection vector on a
//! tool whose entire job is pointing at arbitrary user folders.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};

use crate::thumbs::fit_within;

/// Where to look when ffmpeg is not on PATH.
///
/// A GUI app launched from Finder or the Dock does not inherit the shell's
/// PATH, so a Homebrew ffmpeg is invisible to it even though it works fine in
/// a terminal. This is the single most common "videos silently do not scan"
/// report, so we look in the usual places rather than blaming the user.
const EXTRA_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/opt/local/bin",
    "/snap/bin",
];

static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
static FFPROBE: OnceLock<Option<PathBuf>> = OnceLock::new();

fn locate(binary: &str) -> Option<PathBuf> {
    // `which`-style PATH lookup first.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(binary);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in EXTRA_BIN_DIRS {
        let candidate = Path::new(dir).join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn ffmpeg_path() -> Option<&'static Path> {
    FFMPEG.get_or_init(|| locate("ffmpeg")).as_deref()
}

pub fn ffprobe_path() -> Option<&'static Path> {
    FFPROBE.get_or_init(|| locate("ffprobe")).as_deref()
}

/// True when videos can be scanned at all.
pub fn available() -> bool {
    ffmpeg_path().is_some() && ffprobe_path().is_some()
}

pub struct VideoInfo {
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
}

/// Duration and dimensions in one ffprobe call.
pub fn probe(path: &str) -> Result<VideoInfo> {
    let ffprobe = ffprobe_path().ok_or_else(|| {
        anyhow!("ffprobe not found — install ffmpeg to scan videos")
    })?;

    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("cannot run ffprobe on {path}"))?;

    if !output.status.success() {
        bail!(
            "ffprobe failed on {path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut width = 0_u32;
    let mut height = 0_u32;
    let mut duration = 0.0_f64;

    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "width" => width = value.trim().parse().unwrap_or(0),
            "height" => height = value.trim().parse().unwrap_or(0),
            "duration" => duration = value.trim().parse().unwrap_or(0.0),
            _ => {}
        }
    }

    if !duration.is_finite() || duration <= 0.0 {
        // Streams remuxed without a container duration are common; without it
        // there is nothing to sample, so this is a per-file failure, not a crash.
        bail!("ffprobe reported no usable duration for {path}");
    }

    Ok(VideoInfo {
        duration_sec: duration,
        width,
        height,
    })
}

/// Decode a still image ffmpeg understands but the `image` crate does not.
///
/// This is the HEIC/AVIF path. ffmpeg is already required for video, so reusing
/// it as a universal fallback decoder costs nothing and covers every format it
/// knows — which is far more than any pure-Rust decoder set.
pub fn thumbnail_via_ffmpeg(
    source: &str,
    destination: &Path,
    bound: u32,
) -> Result<crate::thumbs::Thumbnail> {
    let ffmpeg = ffmpeg_path()
        .ok_or_else(|| anyhow!("ffmpeg is not installed, so this format cannot be decoded"))?;

    let (source_width, source_height) = probe_image_size(source)?;
    let (thumb_width, thumb_height) = fit_within(source_width, source_height, bound);

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }

    let status = Command::new(ffmpeg)
        .args(["-loglevel", "error", "-nostdin"])
        .arg("-i")
        .arg(source)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={thumb_width}:{thumb_height}"),
            "-q:v",
            "3",
            "-y",
        ])
        .arg(destination)
        .status()
        .with_context(|| format!("cannot run ffmpeg on {source}"))?;

    if !status.success() || !destination.is_file() {
        bail!("ffmpeg could not decode {source}");
    }

    Ok(crate::thumbs::Thumbnail {
        path: destination.to_path_buf(),
        thumb_width,
        thumb_height,
        source_width,
        source_height,
    })
}

/// Dimensions of a still image, via ffprobe.
fn probe_image_size(path: &str) -> Result<(u32, u32)> {
    let ffprobe = ffprobe_path().ok_or_else(|| anyhow!("ffprobe not found"))?;

    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("cannot run ffprobe on {path}"))?;

    if !output.status.success() {
        bail!(
            "ffprobe failed on {path}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut width = 0_u32;
    let mut height = 0_u32;
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "width" => width = value.trim().parse().unwrap_or(0),
                "height" => height = value.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }

    if width == 0 || height == 0 {
        bail!("ffprobe reported no dimensions for {path}");
    }
    Ok((width, height))
}

pub struct ExtractedFrame {
    pub frame_index: i64,
    pub timestamp_sec: f64,
    pub path: PathBuf,
}

/// Pull one JPEG per timestamp into `out_dir`, scaled to fit `bound`.
///
/// Frames are extracted sequentially per video. The parallelism in this app is
/// across *files*, not within one — running six ffmpeg processes against one
/// file mostly fights over the same disk reads, whereas six files genuinely
/// use six cores.
pub fn extract_frames(
    path: &str,
    info: &VideoInfo,
    timestamps: &[f64],
    out_dir: &Path,
    bound: u32,
) -> Result<Vec<ExtractedFrame>> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| anyhow!("ffmpeg not found"))?;

    std::fs::create_dir_all(out_dir)
        .with_context(|| format!("cannot create {}", out_dir.display()))?;

    let (target_width, target_height) = if info.width > 0 && info.height > 0 {
        fit_within(info.width, info.height, bound)
    } else {
        (bound, bound)
    };
    let scale = format!("scale={target_width}:{target_height}");

    let mut frames = Vec::with_capacity(timestamps.len());

    for (index, timestamp) in timestamps.iter().enumerate() {
        let destination = out_dir.join(format!("frame_{index:04}.jpg"));

        if !destination.is_file() {
            let status = Command::new(ffmpeg)
                .args(["-loglevel", "error", "-nostdin"])
                // -ss BEFORE -i is the fast input seek: ffmpeg jumps to the
                // nearest keyframe instead of decoding from the start, which is
                // the difference between milliseconds and minutes on a long file.
                .args(["-ss", &format!("{timestamp:.3}")])
                .arg("-i")
                .arg(path)
                .args(["-frames:v", "1", "-vf", &scale, "-q:v", "3", "-y"])
                .arg(&destination)
                .status()
                .with_context(|| format!("cannot run ffmpeg on {path}"))?;

            if !status.success() || !destination.is_file() {
                // A seek past the last keyframe of a truncated file produces no
                // frame. Skip it; the remaining samples still classify the video.
                continue;
            }
        }

        frames.push(ExtractedFrame {
            frame_index: index as i64,
            timestamp_sec: *timestamp,
            path: destination,
        });
    }

    if frames.is_empty() {
        bail!("ffmpeg produced no frames for {path}");
    }

    Ok(frames)
}
