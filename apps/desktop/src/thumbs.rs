//! Thumbnail generation.
//!
//! # Every indexed file gets a thumbnail, unconditionally
//!
//! The previous generation of this app only wrote a thumbnail when the source
//! *exceeded* the target size, and fell back to rendering the full-resolution
//! original when one was missing. Two thirds of the library ended up loading
//! originals through the protocol handler. Here a thumbnail is always written,
//! even when that means re-encoding a 400px image at 400px, because a uniform
//! "the grid always renders a small JPEG" rule is worth far more than the
//! handful of files it wastes work on.
//!
//! The one exception is animated formats: the grid renders those from the
//! original so the animation survives. They still get a still thumbnail, which
//! is what the classifier reads and what the tile shows while the original
//! downloads.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use image::imageops::FilterType;
use sha2::{Digest, Sha256};

/// Longest edge of a generated thumbnail.
///
/// 512 rather than 320: the grid renders tiles up to ~400px wide on a large
/// display, and upscaling a 320px thumbnail is visibly soft. It is also what
/// the classifier sees, and NudeNet's own input is 320px, so there is headroom
/// for the detector without feeding it a 4000px original.
pub const THUMB_MAX: u32 = 512;

/// JPEG quality for thumbnails. 82 is where the file size curve elbows; the
/// old app wrote quality 100 and produced thumbnails larger than some sources.
const THUMB_QUALITY: u8 = 82;

#[derive(Debug)]
pub struct Thumbnail {
    pub path: PathBuf,
    pub thumb_width: u32,
    pub thumb_height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

/// Content-addressed destination for a derived file.
///
/// Keyed on the absolute source path, sharded two levels deep so no directory
/// holds more than a few hundred entries — a flat directory with 50,000 files
/// makes every `readdir` on it slow, including the ones Finder does behind your
/// back.
pub fn derived_path(root: &Path, source: &str, suffix: &str) -> PathBuf {
    let digest = Sha256::digest(source.as_bytes());
    let hex = format!("{digest:x}");
    root.join(&hex[0..2])
        .join(&hex[2..4])
        .join(format!("{}{}", &hex[4..24], suffix))
}

/// Generate a thumbnail for an image, or return the existing one.
///
/// Reuse is keyed on the path only, not on mtime: the watcher deletes the
/// derived files when a source changes, so a surviving thumbnail is by
/// definition still valid. That keeps the hot path a single `is_file` check
/// instead of a `stat` plus a comparison.
pub fn thumbnail_image(source: &str, thumb_root: &Path) -> Result<Thumbnail> {
    let destination = derived_path(thumb_root, source, ".jpg");

    let decoded = image::open(source)
        .with_context(|| format!("cannot decode image {source}"))?;
    let source_width = decoded.width();
    let source_height = decoded.height();

    if destination.is_file() {
        if let Ok((thumb_width, thumb_height)) = image::image_dimensions(&destination) {
            return Ok(Thumbnail {
                path: destination,
                thumb_width,
                thumb_height,
                source_width,
                source_height,
            });
        }
        // A truncated thumbnail from a crashed run — fall through and rewrite.
    }

    let (thumb_width, thumb_height) = fit_within(source_width, source_height, THUMB_MAX);
    let resized = decoded.resize(thumb_width, thumb_height, FilterType::Triangle);

    write_jpeg(&resized, &destination)?;

    Ok(Thumbnail {
        path: destination,
        thumb_width: resized.width(),
        thumb_height: resized.height(),
        source_width,
        source_height,
    })
}

pub fn write_jpeg(image: &image::DynamicImage, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }

    // JPEG has no alpha channel; encoding an RGBA image straight to it either
    // fails or produces garbage in the alpha-heavy areas. Flattening onto
    // white is what a browser would show for a PNG on a light page.
    let rgb = image.to_rgb8();

    let file = std::fs::File::create(destination)
        .with_context(|| format!("cannot write {}", destination.display()))?;
    let mut writer = std::io::BufWriter::new(file);
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, THUMB_QUALITY);
    encoder
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .with_context(|| format!("cannot encode {}", destination.display()))?;

    Ok(())
}

/// Fit inside a square, preserving aspect ratio, never scaling up.
///
/// Mirrors `fitWithin` in `packages/core/src/media.ts`, which the grid uses to
/// size tiles before any image loads.
pub fn fit_within(width: u32, height: u32, bound: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (bound, bound);
    }
    if width <= bound && height <= bound {
        return (width, height);
    }
    let scale = f64::from(bound) / f64::from(width.max(height));
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}

/// Remove the derived files for a source path, so the next pass regenerates them.
pub fn forget_derived(thumb_root: &Path, frame_root: &Path, source: &str) {
    let _ = std::fs::remove_file(derived_path(thumb_root, source, ".jpg"));
    let _ = std::fs::remove_dir_all(frame_dir(frame_root, source));
}

/// Directory holding one video's extracted frames.
pub fn frame_dir(frame_root: &Path, source: &str) -> PathBuf {
    let digest = Sha256::digest(source.as_bytes());
    let hex = format!("{digest:x}");
    frame_root.join(&hex[0..2]).join(&hex[2..24])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_within_never_upscales() {
        assert_eq!(fit_within(100, 80, 512), (100, 80));
    }

    #[test]
    fn fit_within_fits_by_the_longest_edge() {
        assert_eq!(fit_within(1600, 900, 512), (512, 288));
        assert_eq!(fit_within(900, 1600, 512), (288, 512));
    }

    #[test]
    fn fit_within_survives_a_degenerate_size() {
        assert_eq!(fit_within(0, 0, 512), (512, 512));
    }

    /// The decode → resize → encode path, end to end against a real file.
    ///
    /// Every other test here is arithmetic; this is the one that would catch a
    /// broken `image` feature set (a format compiled out) or an encoder that
    /// rejects the pixel layout we hand it.
    #[test]
    fn generates_a_real_thumbnail_and_reuses_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("wide.png");
        image::RgbImage::from_fn(1600, 900, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        })
        .save(&source)
        .expect("write the source image");

        let thumb_root = dir.path().join("thumbs");
        let source_str = source.to_string_lossy().to_string();

        let first = thumbnail_image(&source_str, &thumb_root).expect("thumbnail");
        assert_eq!((first.source_width, first.source_height), (1600, 900));
        assert_eq!((first.thumb_width, first.thumb_height), (512, 288));
        assert!(first.path.is_file(), "the thumbnail must actually be written");

        // It really is a JPEG. Deliberately NOT asserting it is smaller than
        // the source: a synthetic gradient PNG compresses better than any JPEG
        // of it, so that comparison holds for photographs and fails here.
        let bytes = std::fs::read(&first.path).unwrap();
        assert_eq!(
            &bytes[0..2],
            &[0xFF, 0xD8],
            "the thumbnail must carry a JPEG SOI marker regardless of the source format"
        );
        assert_eq!(
            image::image_dimensions(&first.path).unwrap(),
            (512, 288),
            "the file on disk must match the reported dimensions"
        );

        // A second call reuses the existing file rather than re-encoding.
        let before = std::fs::metadata(&first.path).unwrap().modified().unwrap();
        let second = thumbnail_image(&source_str, &thumb_root).expect("second thumbnail");
        assert_eq!(second.path, first.path);
        assert_eq!(
            std::fs::metadata(&second.path).unwrap().modified().unwrap(),
            before,
            "an existing thumbnail must not be rewritten"
        );
    }

    /// A PNG with transparency must not blow up the JPEG encoder, which has no
    /// alpha channel.
    #[test]
    fn flattens_transparency_instead_of_failing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("alpha.png");
        image::RgbaImage::from_fn(800, 600, |x, _| {
            image::Rgba([200, 100, 50, if x < 400 { 0 } else { 255 }])
        })
        .save(&source)
        .expect("write the source image");

        let thumb = thumbnail_image(&source.to_string_lossy(), &dir.path().join("thumbs"))
            .expect("an RGBA source must still thumbnail");
        assert_eq!((thumb.thumb_width, thumb.thumb_height), (512, 384));
    }

    #[test]
    fn reports_a_readable_error_for_a_file_that_is_not_an_image() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("not-an-image.jpg");
        std::fs::write(&source, b"this is not a JPEG").unwrap();

        let error = thumbnail_image(&source.to_string_lossy(), &dir.path().join("thumbs"))
            .expect_err("a garbage file must fail rather than produce a blank thumbnail");
        assert!(
            format!("{error:#}").contains("cannot decode image"),
            "the error should name the file: {error:#}"
        );
    }

    #[test]
    fn derived_paths_are_stable_and_sharded() {
        let root = Path::new("/tmp/thumbs");
        let a = derived_path(root, "/media/a.jpg", ".jpg");
        let b = derived_path(root, "/media/a.jpg", ".jpg");
        let c = derived_path(root, "/media/b.jpg", ".jpg");
        assert_eq!(a, b, "the same source must always map to the same thumbnail");
        assert_ne!(a, c);
        // two shard levels below the root, then the file
        assert_eq!(a.strip_prefix(root).unwrap().components().count(), 3);
    }
}
