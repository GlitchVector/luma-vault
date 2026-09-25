//! The training data behind a character LoRA, read for the LoRAs page.
//!
//! kohya's dataset config is the truth about what a LoRA saw: every
//! `[[datasets.subsets]]` names a folder and how many times an epoch repeats
//! it, and each image has its caption beside it as `.txt`. This reads exactly
//! that, on request, and keeps no copy — so the page cannot drift from the
//! folder the trainer actually read.
//!
//! The datasets live outside every watched folder (`D:\AI\lora-train` by
//! default, `LUMA_LORA_TRAIN` to move it) and they stay outside the `luma://`
//! allowlist. What the page shows are thumbnails written into the app's own
//! thumbs directory, addressed by content like every other thumbnail, which the
//! protocol already serves. The originals are never served, and nothing here
//! widens what is.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rayon::prelude::*;

use crate::thumbs;
use crate::types::{LoraDataset, LoraImage, LoraSubset};

/// Where the trainer, its datasets and its output live.
pub fn train_root() -> PathBuf {
    std::env::var_os("LUMA_LORA_TRAIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\AI\lora-train"))
}

const IMAGE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// Read `datasets/<name>` under `root`: its newest `.toml`, every subset it
/// names, every image in each, with a thumbnail under `thumb_root`.
pub fn read(root: &Path, name: &str, thumb_root: &Path) -> Result<LoraDataset> {
    // One path segment. The name arrives from the page, and `..` must never
    // reach the filesystem.
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        bail!("not a dataset name: {name:?}");
    }
    let folder = root.join("datasets").join(name);
    if !folder.is_dir() {
        bail!("no dataset folder at {}", folder.display());
    }
    let config = newest_toml(&folder)?;
    let text = std::fs::read_to_string(&config)
        .with_context(|| format!("cannot read {}", config.display()))?;
    let parsed: toml::Value =
        toml::from_str(&text).with_context(|| format!("{} is not valid TOML", config.display()))?;

    let mut subsets = Vec::new();
    for dataset in parsed.get("datasets").and_then(|d| d.as_array()).into_iter().flatten() {
        for subset in dataset.get("subsets").and_then(|s| s.as_array()).into_iter().flatten() {
            let Some(dir) = subset.get("image_dir").and_then(|v| v.as_str()) else {
                continue;
            };
            let repeats = subset.get("num_repeats").and_then(|v| v.as_integer()).unwrap_or(1);
            let dir_path = PathBuf::from(dir);
            subsets.push(LoraSubset {
                dir: label(&folder, &dir_path),
                repeats,
                images: read_images(&dir_path, thumb_root),
            });
        }
    }
    let images = subsets.iter().map(|s| s.images.len() as i64).sum();
    let per_epoch = subsets.iter().map(|s| s.images.len() as i64 * s.repeats).sum();
    // The prep copies the owner's sheet into `reference/` so a dataset keeps the
    // picture it was made from. No subset names it, so it is shown, never trained;
    // a subset that did name it would already appear above and is not repeated.
    let reference_dir = folder.join("reference");
    let trained = subsets.iter().any(|s| s.dir == "reference");
    let reference = if trained { Vec::new() } else { read_images(&reference_dir, thumb_root) };
    Ok(LoraDataset {
        name: name.to_string(),
        config: config.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        subsets,
        reference,
        images,
        per_epoch,
    })
}

/// A viewer-sized copy of one training image, written under the app's own
/// thumbs root like the thumbnails. `path` is checked to lie inside the named
/// dataset's folder before anything is opened: it arrives from the page, and
/// this must never become a way to read a file anywhere else.
pub fn preview(root: &Path, name: &str, path: &str, thumb_root: &Path) -> Result<PathBuf> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        bail!("not a dataset name: {name:?}");
    }
    let folder = root
        .join("datasets")
        .join(name)
        .canonicalize()
        .with_context(|| format!("no dataset folder for {name}"))?;
    let file = Path::new(path)
        .canonicalize()
        .with_context(|| format!("no such training image: {path}"))?;
    if !file.starts_with(&folder) {
        bail!("{path} is not inside the {name} dataset");
    }
    let source = file.to_string_lossy().into_owned();
    let key = thumbs::content_key(&source)?;
    thumbs::preview_image(&source, &key, thumb_root)
}

/// The config the trainer read last. A prep script rewrites the toml it is
/// about to train on, so when a folder holds more than one the newest is the
/// one that describes the installed file.
fn newest_toml(folder: &Path) -> Result<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(folder)
        .with_context(|| format!("cannot list {}", folder.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("toml"))
        .filter_map(|path| {
            let modified = path.metadata().and_then(|m| m.modified()).ok()?;
            Some((modified, path))
        })
        .collect();
    found.sort();
    found
        .pop()
        .map(|(_, path)| path)
        .with_context(|| format!("no dataset .toml in {}", folder.display()))
}

/// A subset's folder as the page names it: relative to the dataset when it is
/// inside it (`refs`, `undress`), the whole path when a config reaches outside.
fn label(folder: &Path, dir: &Path) -> String {
    dir.strip_prefix(folder)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| dir.to_string_lossy().replace('\\', "/"))
}

/// Every image in one subset folder, in name order, thumbnailed in parallel.
///
/// Per-image failures are rows, not errors: a file the decoder rejects still
/// lists, without a thumbnail, rather than hiding the whole subset.
fn read_images(dir: &Path, thumb_root: &Path) -> Vec<LoraImage> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        .collect();
    // `a-flip.png` sorts before `a.png` bytewise ('-' < '.'), which would put
    // every mirror ahead of its original; order by the original's name, then
    // the mirror after it.
    files.sort_by_cached_key(|path| {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        match stem.strip_suffix("-flip") {
            Some(original) => (original.to_string(), true),
            None => (stem.to_string(), false),
        }
    });
    files
        .par_iter()
        .map(|path| {
            let source = path.to_string_lossy().into_owned();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let caption = std::fs::read_to_string(path.with_extension("txt"))
                .ok()
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty());
            let thumb = thumbs::content_key(&source)
                .and_then(|key| thumbs::thumbnail_image(&source, &key, thumb_root))
                .ok();
            LoraImage {
                path: source,
                thumb_path: thumb.as_ref().map(|t| t.path.to_string_lossy().into_owned()),
                width: thumb.as_ref().map(|t| i64::from(t.source_width)).unwrap_or(0),
                height: thumb.as_ref().map(|t| i64::from(t.source_height)).unwrap_or(0),
                caption,
                // The prep scripts mirror by appending `-flip`; the page folds
                // those away since they say nothing the original does not.
                flipped: stem.ends_with("-flip"),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn png(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        image::RgbImage::from_pixel(8, 12, image::Rgb([200, 100, 50])).save(path).unwrap();
    }

    #[test]
    fn reads_subsets_repeats_captions_and_flips_from_the_toml() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("datasets").join("ari-gen");
        let refs = folder.join("refs");
        png(&refs.join("ari-01.png"));
        write(&refs.join("ari-01.txt"), "ari, 1girl, solo, full body\n");
        png(&refs.join("ari-01-flip.png"));
        write(&refs.join("ari-01-flip.txt"), "ari, 1girl, solo, full body\n");
        write(&refs.join("ari-01_1024x1536_sdxl.npz"), "not an image");
        let faces = folder.join("refs-face");
        png(&faces.join("face-01.png"));
        write(
            &folder.join("dataset-ari-gen.toml"),
            &format!(
                "[general]\nkeep_tokens = 1\n\n[[datasets]]\nresolution = 1024\n\n  [[datasets.subsets]]\n  image_dir = \"{}\"\n  num_repeats = 6\n\n  [[datasets.subsets]]\n  image_dir = \"{}\"\n  num_repeats = 5\n",
                refs.to_string_lossy().replace('\\', "/"),
                faces.to_string_lossy().replace('\\', "/"),
            ),
        );
        let thumbs = root.path().join("thumbs");

        let dataset = read(root.path(), "ari-gen", &thumbs).unwrap();
        assert_eq!(dataset.config, "dataset-ari-gen.toml");
        assert_eq!(dataset.subsets.len(), 2);
        assert_eq!(dataset.subsets[0].dir, "refs");
        assert_eq!(dataset.subsets[0].repeats, 6);
        assert_eq!(dataset.subsets[0].images.len(), 2, "the .npz cache is not an image");
        assert_eq!(dataset.subsets[1].dir, "refs-face");
        assert_eq!(dataset.images, 3);
        assert_eq!(dataset.per_epoch, 2 * 6 + 5);

        let first = &dataset.subsets[0].images[0];
        assert_eq!(first.caption.as_deref(), Some("ari, 1girl, solo, full body"));
        assert!(!first.flipped);
        assert!(dataset.subsets[0].images[1].flipped);
        assert_eq!((first.width, first.height), (8, 12));
        let thumb = first.thumb_path.as_deref().expect("a thumbnail was written");
        assert!(Path::new(thumb).starts_with(&thumbs), "thumbnails go under the app's own root, never beside the data");
        assert!(dataset.subsets[1].images[0].caption.is_none());
        assert!(dataset.reference.is_empty(), "no reference/ folder, nothing to show");
    }

    #[test]
    fn shows_the_reference_sheet_beside_the_data_without_counting_it() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("datasets").join("ari-gala-dress");
        let refs = folder.join("refs");
        png(&refs.join("ari-01.png"));
        png(&folder.join("reference").join("ari-gala-dress-sheet.png"));
        write(
            &folder.join("dataset.toml"),
            &format!("[[datasets]]\n  [[datasets.subsets]]\n  image_dir = \"{}\"\n  num_repeats = 6\n", refs.to_string_lossy().replace('\\', "/")),
        );
        let thumbs = root.path().join("thumbs");

        let dataset = read(root.path(), "ari-gala-dress", &thumbs).unwrap();
        assert_eq!(dataset.reference.len(), 1);
        assert!(dataset.reference[0].thumb_path.is_some());
        assert_eq!(dataset.images, 1, "the sheet is not a training image");
        assert_eq!(dataset.per_epoch, 6);
        // Inside the dataset folder, so the viewer may open it at full size.
        assert!(preview(root.path(), "ari-gala-dress", &dataset.reference[0].path, &thumbs).is_ok());
    }

    #[test]
    fn previews_only_files_inside_the_named_dataset() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("datasets").join("ari-gen").join("refs").join("a.png");
        png(&inside);
        let outside = root.path().join("elsewhere.png");
        png(&outside);
        let thumbs = root.path().join("thumbs");

        let made = preview(root.path(), "ari-gen", &inside.to_string_lossy(), &thumbs).unwrap();
        assert!(made.starts_with(&thumbs));
        assert!(made.to_string_lossy().ends_with("-preview.jpg"));
        // The same call again is answered by the file already there.
        assert_eq!(preview(root.path(), "ari-gen", &inside.to_string_lossy(), &thumbs).unwrap(), made);

        assert!(preview(root.path(), "ari-gen", &outside.to_string_lossy(), &thumbs).is_err());
        assert!(preview(root.path(), "..", &inside.to_string_lossy(), &thumbs).is_err());
        assert!(preview(root.path(), "ari-gen", "D:/nowhere/x.png", &thumbs).is_err());
    }

    #[test]
    fn refuses_a_name_that_is_not_one_segment() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["..", "a/b", "a\\b", ""] {
            assert!(read(root.path(), bad, root.path()).is_err(), "{bad:?} must be refused");
        }
        assert!(read(root.path(), "missing", root.path()).is_err());
    }
}
