//! Walking a folder for indexable media.

use std::path::Path;
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

/// Directories that are never worth walking.
///
/// `@eaDir` is Synology's thumbnail sidecar directory and it mirrors the entire
/// media tree with small JPEGs — walking it on a NAS share doubles the file
/// count and fills the library with 100px duplicates of everything.
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
    ) || name == ".thumbnails"
}

/// Walk `root` and return every indexable file.
///
/// `on_progress` is called with the running count so the UI can show the glob
/// growing — on a large NAS share this phase alone can take a minute, and a
/// motionless progress bar reads as a hang.
pub fn walk_folder<F>(root: &Path, mut on_progress: F) -> (Vec<ScannedFile>, Vec<String>)
where
    F: FnMut(usize, &Path),
{
    let mut files = Vec::new();
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
                return !is_ignored_dir(&name);
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
    (files, errors)
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
        assert!(!is_ignored_dir("Holiday 2024"));
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

        let (files, errors) = walk_folder(root, |_, _| {});
        let mut names: Vec<_> = files.iter().map(|f| f.name.clone()).collect();
        names.sort();

        assert_eq!(names, vec!["a.jpg", "b.mp4"]);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    }
}
