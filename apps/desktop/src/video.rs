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

/// What Windows falls back to when PATHEXT is unset.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Rewrite an indexed path into the spelling ffmpeg probes correctly.
///
/// The index stores canonicalized paths, which on Windows means the
/// extended-length form: `\\?\UNC\server\share\file` for a share, `\\?\D:\dir`
/// for a local disk. ffmpeg *opens* those fine — a normal video probes the same
/// either way — but its format detection does not survive them. Given a file
/// whose extension lies about its contents, the verbatim spelling makes ffmpeg
/// trust the extension and misdecode; the plain spelling lets content probing
/// win.
///
/// Measured on one real file, a GIF named `.jpg`: `width=0` and `bits 156 is
/// invalid` through the verbatim path, a correct `540x385` through the plain
/// one. That matters here because this fallback decoder exists precisely for
/// the files the `image` crate rejected — mislabeled ones prominent among them.
fn external_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` is the verbatim spelling of `\\server\share`.
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// The file names a binary can have on this platform, most likely first.
fn executable_names(binary: &str) -> Vec<String> {
    if !cfg!(windows) {
        return vec![binary.to_string()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| DEFAULT_PATHEXT.to_string());
    windows_names(binary, &pathext)
}

/// Windows PATH lookup is extension-driven: `ffmpeg` names no file, `ffmpeg.exe`
/// does. Consult PATHEXT rather than hardcoding `.exe`, because that is what the
/// shell itself does and package managers ship shims — a scoop or chocolatey
/// `ffmpeg.cmd` is as legitimate as winget's `ffmpeg.exe`.
///
/// Takes PATHEXT as an argument rather than reading it, so the rule can be
/// tested from any platform without mutating the process environment.
fn windows_names(binary: &str, pathext: &str) -> Vec<String> {
    let mut names: Vec<String> = pathext
        .split(';')
        .map(str::trim)
        .filter(|ext| ext.starts_with('.'))
        .map(|ext| format!("{binary}{}", ext.to_ascii_lowercase()))
        .collect();

    // Last resort: an extensionless binary on PATH is unusual on Windows, but it
    // runs fine when invoked by full path, which is how we invoke it.
    names.push(binary.to_string());
    names
}

fn locate(binary: &str) -> Option<PathBuf> {
    let names = executable_names(binary);

    // `which`-style PATH lookup first. Directory-major, matching the shell:
    // the first directory on PATH that holds *any* spelling of the binary wins.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    for dir in EXTRA_BIN_DIRS {
        for name in &names {
            let candidate = Path::new(dir).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
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
        .arg(external_path(path))
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

    if width == 0 || height == 0 {
        // A duration but no video stream: an audio file wearing a video
        // extension. Whole music libraries are like this — a DJ tool's `.mpg`
        // is usually MPEG *audio*. Saying so here beats letting frame
        // extraction run and fail later with "produced no frames", which
        // describes the symptom and hides the cause.
        bail!("no video stream in {path} — audio only");
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
        .arg(external_path(source))
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
        .arg(external_path(path))
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
                .arg(external_path(path))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verbatim_unc_path_becomes_the_plain_share_path() {
        // Measured: ffprobe reports width=0 for the verbatim form and 540x385
        // for this one, on the same file.
        assert_eq!(
            external_path(r"\\?\UNC\jebpot\vault\Images\a.jpg"),
            r"\\jebpot\vault\Images\a.jpg"
        );
    }

    #[test]
    fn a_verbatim_disk_path_loses_only_its_prefix() {
        assert_eq!(external_path(r"\\?\D:\vault\a.mp4"), r"D:\vault\a.mp4");
    }

    #[test]
    fn a_path_without_the_prefix_is_untouched() {
        assert_eq!(external_path("/Users/x/vault/a.mp4"), "/Users/x/vault/a.mp4");
        assert_eq!(external_path(r"D:\vault\a.mp4"), r"D:\vault\a.mp4");
        assert_eq!(external_path(r"\\jebpot\vault\a.mp4"), r"\\jebpot\vault\a.mp4");
    }

    #[test]
    fn looks_for_the_platform_spelling_of_a_binary() {
        let names = executable_names("ffmpeg");

        if cfg!(windows) {
            assert!(
                names.contains(&"ffmpeg.exe".to_string()),
                "a Windows PATH holds ffmpeg.exe, never a bare ffmpeg: {names:?}"
            );
        } else {
            assert_eq!(names, vec!["ffmpeg".to_string()]);
        }
    }

    // The Windows rule is checked from every platform on purpose: CI is Linux,
    // and a regression here is invisible until someone runs the app on Windows
    // and is told to install the ffmpeg they already have.
    #[test]
    fn the_windows_spelling_prefers_exe_and_keeps_pathext_order() {
        let names = windows_names("ffmpeg", DEFAULT_PATHEXT);

        assert_eq!(names, ["ffmpeg.com", "ffmpeg.exe", "ffmpeg.bat", "ffmpeg.cmd", "ffmpeg"]);
    }

    #[test]
    fn the_windows_spelling_lowercases_pathext_and_drops_its_junk() {
        // PATHEXT is conventionally uppercase and often carries a trailing
        // separator or a stray entry; neither may produce a bogus candidate.
        let names = windows_names("ffprobe", ".EXE; .CMD ;;bogus");

        assert_eq!(names, ["ffprobe.exe", "ffprobe.cmd", "ffprobe"]);
    }
}
