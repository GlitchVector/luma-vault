//! Walking a folder for indexable media.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

use crate::db::ScannedFile;
use crate::types::MediaKind;

/// Kept in lockstep with `IMAGE_EXTENSIONS` / `VIDEO_EXTENSIONS` in
/// `packages/core/src/media.ts`.
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "tif", "tiff",
];

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "ts",
];

pub fn kind_of(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_str()?.to_lowercase();
    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Image)
    } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// Marker file that excludes a directory and everything under it.
///
/// The general escape hatch for the problem below: derived data that lives
/// inside a media tree and is indistinguishable from the real thing by name or
/// extension. Drop an empty `.lumaignore` into a directory and the scanner
/// walks straight past it.
pub const IGNORE_MARKER: &str = ".lumaignore";

/// Directories that are never worth walking.
///
/// These all share one property: they mirror the media tree with *derived*
/// copies, so indexing them silently doubles or triples the library with
/// duplicates of things already in it.
///
/// - `@eaDir` — Synology's thumbnail sidecar, a small JPEG per real file.
/// - `_corndog_meta` — the sibling corn-dog project stores its extracted video
///   frames here, roughly 73 JPEGs per video across 718 videos. Pointing this
///   scanner at a vault root that contains it added ~52,000 frame grabs that
///   duplicated the videos they came from.
///
/// Anything not on this list is excluded with `.lumaignore` instead.
fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "@eaDir"
            | ".Trashes"
            | "$RECYCLE.BIN"
            | "System Volume Information"
            | ".luma"
            | "_corndog_meta"
    ) || name == ".thumbnails"
}

/// Is this a Stable Diffusion Image Browser database?
///
/// Matched by name because that is what the extension writes and the only
/// thing available without opening every SQLite file on the share. Whether it
/// really is one is decided by looking for a `ranking` table when it is opened;
/// anything else is refused there, so a false match here costs one failed open.
fn is_rating_database(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with("wib") && (lower.ends_with(".sqlite3") || lower.ends_with(".sqlite"))
}

/// Everything one walk of a folder turned up.
pub struct Walk {
    pub files: Vec<ScannedFile>,
    /// Image Browser databases found along the way.
    ///
    /// Collected *during* the walk rather than by a second search: these live
    /// inside the tree being scanned — `<webui>/extensions/…-images-browser/` —
    /// and re-walking a 200,000-file share to find a handful of files nobody
    /// asked about would cost more than the ratings are worth.
    pub rating_databases: Vec<PathBuf>,
    pub errors: Vec<String>,
}

/// Walk `root` and return every indexable file.
///
/// `on_progress` is called with the running count so the UI can show the glob
/// growing — on a large NAS share this phase alone can take a minute, and a
/// motionless progress bar reads as a hang.
pub fn walk_folder<F>(root: &Path, excluded: &[String], mut on_progress: F) -> Walk
where
    F: FnMut(usize, &Path),
{
    // Compared case-insensitively: the index stores whatever case the
    // filesystem reported, and on Windows the same folder can be reached under
    // several. An exclusion that silently stopped matching would be worse than
    // one that never worked, because the folder would quietly come back.
    let excluded: Vec<String> = excluded.iter().map(|path| path.to_lowercase()).collect();
    let is_excluded = |path: &Path| {
        let lower = path.to_string_lossy().to_lowercase();
        excluded.contains(&lower)
    };
    let mut files = Vec::new();
    let mut rating_databases = Vec::new();
    let mut errors = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false) // a symlink loop would walk forever
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_dir() {
                if is_ignored_dir(&name) || is_excluded(entry.path()) {
                    return false;
                }
                // One stat per directory, not per file — cheap even on SMB.
                return !entry.path().join(IGNORE_MARKER).exists();
            }
            // Skip AppleDouble sidecars and other dot-files outright.
            !name.starts_with("._") && !name.starts_with('.')
        });

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                // An unreadable subdirectory is a row in the error list, never
                // an aborted scan — one permission-denied folder must not cost
                // you the other 40,000 files.
                errors.push(format!("{error}"));
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        if is_rating_database(&entry.file_name().to_string_lossy()) {
            rating_databases.push(entry.path().to_path_buf());
            continue;
        }

        let Some(kind) = kind_of(entry.path()) else {
            continue;
        };

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(format!("{}: {error}", entry.path().display()));
                continue;
            }
        };

        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);

        let Some(path) = entry.path().to_str() else {
            // A path that is not valid UTF-8 cannot round-trip through the
            // JSON wire format, so it cannot be indexed.
            errors.push(format!("{}: path is not valid UTF-8", entry.path().display()));
            continue;
        };

        files.push(ScannedFile {
            path: path.to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            kind,
            size_bytes: metadata.len() as i64,
            modified_at,
        });

        if files.len() % 200 == 0 {
            on_progress(files.len(), entry.path());
        }
    }

    on_progress(files.len(), root);
    Walk {
        files,
        rating_databases,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_media_extensions_case_insensitively() {
        assert_eq!(kind_of(Path::new("/a/b.JPG")), Some(MediaKind::Image));
        assert_eq!(kind_of(Path::new("/a/b.MkV")), Some(MediaKind::Video));
        assert_eq!(kind_of(Path::new("/a/b.txt")), None);
        assert_eq!(kind_of(Path::new("/a/README")), None);
    }

    #[test]
    fn skips_nas_and_vcs_noise() {
        assert!(is_ignored_dir("@eaDir"));
        assert!(is_ignored_dir("node_modules"));
        assert!(
            is_ignored_dir("_corndog_meta"),
            "a sibling project's extracted-frame cache is 52k derived JPEGs"
        );
        assert!(!is_ignored_dir("Holiday 2024"));
    }

    #[test]
    fn a_lumaignore_marker_excludes_a_directory_and_its_children() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        std::fs::create_dir_all(root.join("keep")).unwrap();
        std::fs::create_dir_all(root.join("derived/nested")).unwrap();
        std::fs::write(root.join("keep/a.jpg"), b"x").unwrap();
        std::fs::write(root.join("derived/frame.jpg"), b"x").unwrap();
        std::fs::write(root.join("derived/nested/frame.jpg"), b"x").unwrap();
        std::fs::write(root.join("derived").join(IGNORE_MARKER), b"").unwrap();

        let files = walk_folder(root, &[], |_, _| {}).files;
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();

        assert_eq!(
            names,
            vec!["a.jpg"],
            "the marker must exclude the whole subtree, not just its own level"
        );
    }

    #[test]
    fn an_excluded_folder_is_walked_straight_past() {
        // The texture-pack case: a directory full of files that are images by
        // extension and noise by intent, sitting inside a tree worth scanning.
        let root = tempfile::tempdir().unwrap();
        let textures = root.path().join("assets").join("Texture Pack");
        std::fs::create_dir_all(&textures).unwrap();
        std::fs::write(textures.join("brick_diffuse.png"), b"x").unwrap();
        std::fs::write(textures.join("brick_normal.png"), b"x").unwrap();
        std::fs::create_dir_all(root.path().join("photos")).unwrap();
        std::fs::write(root.path().join("photos").join("keep.jpg"), b"x").unwrap();

        let all = walk_folder(root.path(), &[], |_, _| {});
        assert_eq!(all.files.len(), 3, "nothing excluded yet");

        // Case-insensitively, because the index stores whatever case the
        // filesystem reported and Windows will happily hand back another.
        let shouted = textures.to_string_lossy().to_uppercase();
        let walk = walk_folder(root.path(), &[shouted], |_, _| {});
        let names: Vec<&str> = walk.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["keep.jpg"], "the pack and everything under it");
    }

    #[test]
    fn finds_an_image_browser_database_without_indexing_it() {
        // The one file in a scanned tree that is neither media nor noise: the
        // ratings someone already gave this folder's images. Found during the
        // walk that is happening anyway, because re-walking a 200,000-file
        // share to look for it would cost more than the ratings are worth.
        let root = tempfile::tempdir().unwrap();
        let extension = root
            .path()
            .join("extensions")
            .join("stable-diffusion-webui-images-browser");
        std::fs::create_dir_all(&extension).unwrap();
        std::fs::write(extension.join("wib.sqlite3"), b"not really sqlite").unwrap();
        std::fs::write(extension.join("wib - Copy.sqlite3"), b"a backup of one").unwrap();
        std::fs::write(root.path().join("keep.png"), b"x").unwrap();
        // Neither of these is an Image Browser database.
        std::fs::write(root.path().join("notes.sqlite3"), b"x").unwrap();
        std::fs::write(extension.join("wib_db.py"), b"x").unwrap();

        let walk = walk_folder(root.path(), &[], |_, _| {});

        let names: Vec<String> = walk
            .rating_databases
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2, "found {names:?}");
        assert!(names.iter().any(|n| n == "wib.sqlite3"));
        assert!(names.iter().any(|n| n == "wib - Copy.sqlite3"));

        // And none of them is mistaken for something to index.
        let indexed: Vec<&str> = walk.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(indexed, vec!["keep.png"]);
    }

    #[test]
    fn walks_a_real_tree_and_reports_only_media() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("sub/@eaDir")).unwrap();
        std::fs::write(root.join("a.jpg"), b"x").unwrap();
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        std::fs::write(root.join("._a.jpg"), b"x").unwrap();
        std::fs::write(root.join("sub/b.mp4"), b"x").unwrap();
        std::fs::write(root.join("sub/@eaDir/c.jpg"), b"x").unwrap();

        let Walk { files, errors, .. } = walk_folder(root, &[], |_, _| {});
        let mut names: Vec<_> = files.iter().map(|f| f.name.clone()).collect();
        names.sort();

        assert_eq!(names, vec!["a.jpg", "b.mp4"]);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    }
}
