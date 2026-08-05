//! Running the upscaler over a selection.
//!
//! One process for the whole batch, not one per file: loading a model costs a
//! second or two and the batch would otherwise pay that per picture. The
//! selection is handed over as a list file rather than as arguments, because
//! Windows caps a command line at 32,767 characters and a few hundred UNC paths
//! clear that comfortably.
//!
//! Progress arrives as NDJSON on the child's stdout and is republished as the
//! same `luma://progress`-shaped event the scan uses, so the UI has one thing to
//! listen to rather than two.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::upscales::UPSCALE_SUFFIX;

/// The event the frontend listens on. Distinct from the scan's, because an
/// upscale can run while a scan is running and neither should overwrite the
/// other's progress bar.
pub const PROGRESS_EVENT: &str = "luma://upscale";

/// Where a model might be, in preference order.
///
/// Discovered rather than configured, because the models are large, already on
/// disk for anyone who generates images, and asking for a path before the
/// feature can be tried once is a poor first run. A setting overrides this.
const MODEL_DIRECTORIES: &[&str] = &[
    r"D:\AI\Stable Diffusion\webui\models\ESRGAN",
    r"D:\AI\Stable Diffusion\webui\models\RealESRGAN",
];

/// Preferred when several are installed. Anime-trained first: this library is
/// overwhelmingly illustration, and a photographic model on a flat-shaded
/// drawing invents texture that was never there.
const MODEL_PREFERENCE: &[&str] = &["anime", "ultrasharp", "esrgan"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleProgress {
    /// `start`, `begin`, `item`, `skip`, `failed`, `done`.
    pub phase: String,
    pub done: i64,
    pub total: i64,
    pub current: Option<String>,
    /// Set on `item`, so the UI can show the result as it lands.
    pub destination: Option<String>,
    pub final_width: Option<i64>,
    pub final_height: Option<i64>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleSummary {
    pub upscaled: i64,
    pub skipped: i64,
    /// Selected but already at or past the target, so never sent.
    pub already_large: i64,
    pub failed: i64,
    pub seconds: f64,
    pub peak_vram_mb: i64,
    pub model: String,
    pub architecture: String,
    /// What was produced, for the results view.
    pub outputs: Vec<UpscaledFile>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaledFile {
    pub source: String,
    pub destination: String,
    pub name: String,
    pub source_width: i64,
    pub source_height: i64,
    pub final_width: i64,
    pub final_height: i64,
    pub seconds: f64,
}

/// The interpreter and script, in a dev tree or a bundle.
///
/// Mirrors `classifier::resolve_python`: two levels up from the crate during
/// development, and the resource directory once packaged.
pub fn resolve(repo_root: &Path, resource_dir: Option<&Path>) -> Option<(PathBuf, PathBuf)> {
    let executable = if cfg!(windows) {
        Path::new("Scripts").join("python.exe")
    } else {
        Path::new("bin").join("python")
    };

    for base in [Some(repo_root), resource_dir].into_iter().flatten() {
        let python = base.join("venv-upscaler").join(&executable);
        let script = base.join("sidecar").join("upscaler").join("upscale.py");
        if python.is_file() && script.is_file() {
            return Some((python, script));
        }
    }
    None
}

/// Every upscale model on disk, best first.
pub fn find_models(configured: Option<&str>) -> Vec<PathBuf> {
    if let Some(path) = configured {
        let path = PathBuf::from(path);
        if path.is_file() {
            return vec![path];
        }
    }

    let mut found: Vec<PathBuf> = MODEL_DIRECTORIES
        .iter()
        .filter_map(|directory| std::fs::read_dir(directory).ok())
        .flatten()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("pth") || e.eq_ignore_ascii_case("safetensors"))
        })
        .collect();

    found.sort_by_key(|path| {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        MODEL_PREFERENCE
            .iter()
            .position(|hint| name.contains(hint))
            .unwrap_or(MODEL_PREFERENCE.len())
    });
    found
}

/// Run the upscaler over `sources`, reporting as it goes.
///
/// Blocking: the caller runs it on its own thread. Errors from one file are
/// collected rather than raised — a batch of two hundred must not end on the
/// one that happened to be truncated.
pub fn run(
    app: &AppHandle,
    python: &Path,
    script: &Path,
    model: &Path,
    sources: &[String],
    long_edge: i64,
) -> Result<UpscaleSummary> {
    let list = std::env::temp_dir().join(format!("luma-upscale-{}.txt", std::process::id()));
    std::fs::write(&list, sources.join("\n")).context("could not write the batch list")?;

    let mut child = Command::new(python)
        .arg(script)
        .arg("--input-list")
        .arg(&list)
        .arg("--in-place")
        .arg("--json")
        .arg("--model")
        .arg(model)
        .arg("--long-edge")
        .arg(long_edge.to_string())
        .arg("--suffix")
        .arg(UPSCALE_SUFFIX)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("could not start {}", python.display()))?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let mut summary = UpscaleSummary {
        model: model.file_name().unwrap_or_default().to_string_lossy().to_string(),
        ..Default::default()
    };
    let mut total = sources.len() as i64;
    let mut done = 0_i64;

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let phase = event["event"].as_str().unwrap_or("").to_string();

        match phase.as_str() {
            "start" => {
                total = event["total"].as_i64().unwrap_or(total);
                summary.architecture = event["architecture"].as_str().unwrap_or("").to_string();
            }
            "item" => {
                done += 1;
                summary.upscaled += 1;
                summary.outputs.push(UpscaledFile {
                    source: event["source"].as_str().unwrap_or_default().to_string(),
                    destination: event["destination"].as_str().unwrap_or_default().to_string(),
                    name: event["name"].as_str().unwrap_or_default().to_string(),
                    source_width: event["sourceWidth"].as_i64().unwrap_or(0),
                    source_height: event["sourceHeight"].as_i64().unwrap_or(0),
                    final_width: event["finalWidth"].as_i64().unwrap_or(0),
                    final_height: event["finalHeight"].as_i64().unwrap_or(0),
                    seconds: event["seconds"].as_f64().unwrap_or(0.0),
                });
            }
            "skip" => {
                done += 1;
                summary.skipped += 1;
            }
            "failed" => {
                done += 1;
                summary.failed += 1;
                summary.errors.push(format!(
                    "{}: {}",
                    event["name"].as_str().unwrap_or("?"),
                    event["message"].as_str().unwrap_or("failed")
                ));
            }
            "done" => {
                summary.seconds = event["seconds"].as_f64().unwrap_or(0.0);
                summary.peak_vram_mb = event["peakVramMb"].as_i64().unwrap_or(0);
            }
            _ => {}
        }

        let _ = app.emit(
            PROGRESS_EVENT,
            UpscaleProgress {
                phase,
                done,
                total,
                current: event["name"].as_str().map(str::to_string),
                destination: event["destination"].as_str().map(str::to_string),
                final_width: event["finalWidth"].as_i64(),
                final_height: event["finalHeight"].as_i64(),
                errors: Vec::new(),
            },
        );
    }

    // Read stderr only after stdout closes: the child writes almost nothing
    // there, so it cannot fill its pipe and deadlock.
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        use std::io::Read;
        let _ = pipe.read_to_string(&mut stderr);
    }
    let status = child.wait().context("the upscaler did not exit cleanly")?;
    let _ = std::fs::remove_file(&list);

    if summary.outputs.is_empty() && !status.success() {
        anyhow::bail!(
            "the upscaler failed: {}",
            stderr.trim().lines().last().unwrap_or("no output")
        );
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_an_anime_model_over_a_photographic_one() {
        // This library is illustration. A photographic model on flat shading
        // invents texture that was never in the drawing.
        let mut names = [
            PathBuf::from("RealESRGAN_x4plus.pth"),
            PathBuf::from("4x-AnimeSharp.pth"),
            PathBuf::from("4xUltrasharp_v10.pth"),
        ];
        names.sort_by_key(|path| {
            let name = path.file_name().unwrap().to_string_lossy().to_lowercase();
            MODEL_PREFERENCE
                .iter()
                .position(|hint| name.contains(hint))
                .unwrap_or(MODEL_PREFERENCE.len())
        });
        assert_eq!(names[0], PathBuf::from("4x-AnimeSharp.pth"));
    }

    #[test]
    fn a_configured_model_that_exists_wins_outright() {
        // No discovery at all when the setting names a real file — otherwise a
        // deliberate choice could be silently overruled by whatever is on disk.
        let temp = tempfile::tempdir().unwrap();
        let model = temp.path().join("chosen.pth");
        std::fs::write(&model, b"x").unwrap();
        let found = find_models(Some(model.to_str().unwrap()));
        assert_eq!(found, vec![model]);
    }

    #[test]
    fn a_configured_model_that_is_missing_falls_back_to_discovery() {
        // The file moved. Refusing outright would strand the feature behind a
        // setting the user has to find and fix.
        let found = find_models(Some(r"Z:\nope\gone.pth"));
        assert!(found.iter().all(|p| p != Path::new(r"Z:\nope\gone.pth")));
    }
}
