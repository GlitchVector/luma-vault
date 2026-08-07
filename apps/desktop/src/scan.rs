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
        // `ts` is the one extension the list cannot decide on its own.
        if extension == "ts" && !is_transport_stream(path) {
            return None;
        }
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// Does this `.ts` file actually contain a transport stream?
///
/// `ts` is a genuine video extension and simultaneously the commonest source
/// extension on a developer's disk, so the name cannot separate the two: a scan
/// of one home directory matched 17,123 TypeScript files and not a single
/// video. Every one was indexed as a video and cost an `ffprobe` spawn to fail.
///
/// So the format is asked instead of the filename. A transport stream is a
/// sequence of 188-byte packets, each beginning with sync byte `0x47`; checking
/// three of them in a row is enough that source code will not pass by accident.
///
/// Unreadable or too short is "no": a file that cannot be opened here would
/// fail in ffprobe anyway, and 377 bytes is smaller than any real capture.
fn is_transport_stream(path: &Path) -> bool {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 377];
    if file.read_exact(&mut head).is_err() {
        return false;
    }
    head[0] == 0x47 && head[188] == 0x47 && head[376] == 0x47
}

/// Marker file that excludes a directory and everything under it.
///
/// The general escape hatch for the problem below: derived data that lives
/// inside a media tree and is indistinguishable from the real thing by name or
/// extension. Drop an empty `.lumaignore` into a directory and the scanner
/// walks straight past it.
///
/// This is also the *only* way a folder is excluded. "Exclude folder" in the UI
/// writes one of these ([`write_marker`]) rather than recording the exclusion
/// somewhere the walk would have to check separately — two mechanisms meant two
/// answers to one question, and a folder that was excluded in the app but not
/// on disk came back the moment the index was rebuilt.
pub const IGNORE_MARKER: &str = ".lumaignore";

/// What [`write_marker`] puts inside the file.
///
/// The scanner only asks whether the file exists, so this body is for two other
/// readers: whoever finds it in a folder months later with no memory of putting
/// it there, and [`remove_marker`], which will only delete a marker it wrote.
pub const MARKER_BODY: &str = "\
# Luma Vault skips this folder and everything under it.
#
# Written by \"Exclude folder\" in the app, and removed again by \"undo\" beside
# the folder in the sidebar. Deleting this file by hand has the same effect as
# that undo: the folder is scanned again from the next walk onwards.
";

/// Mark `dir` so the scanner walks past it. Safe to call on a folder that is
/// already marked.
///
/// A marker that is already there is left exactly as it is, whatever it says.
/// It is doing the job either way, and someone who wrote their own may have put
/// a reason in it worth more than our boilerplate.
pub fn write_marker(dir: &Path) -> std::io::Result<()> {
    let marker = dir.join(IGNORE_MARKER);
    if marker.exists() {
        return Ok(());
    }
    std::fs::write(marker, MARKER_BODY)
}

/// Unmark `dir`, but only if the marker is one we wrote.
///
/// `false` means a marker is still there and was not ours to delete — the
/// folder stays unscanned, and the caller has to say so rather than report an
/// undo that did not happen. A folder with no marker at all is already in the
/// wanted state and answers `true`.
pub fn remove_marker(dir: &Path) -> std::io::Result<bool> {
    let marker = dir.join(IGNORE_MARKER);
    match std::fs::read_to_string(&marker) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
        Ok(body) if is_our_marker(&body) => {
            std::fs::remove_file(&marker)?;
            Ok(true)
        }
        Ok(_) => Ok(false),
    }
}

/// Line endings normalised first: a marker opened in Notepad and saved comes
/// back with CRLF, and it is still ours.
fn is_our_marker(body: &str) -> bool {
    body.replace("\r\n", "\n").trim() == MARKER_BODY.trim()
}

/// Does any directory between `path` and `root` carry [`IGNORE_MARKER`]?
///
/// The walk asks this once per directory, as part of pruning the traversal. The
/// watcher cannot: it is handed one changed path at a time, with no idea which
/// directories it already visited. Without the cache a debounced batch — a bulk
/// copy is thousands of paths sharing a handful of directories — would stat the
/// same ancestors thousands of times, and on an SMB share that is the expensive
/// part of handling the batch at all.
#[derive(Default)]
pub struct MarkerCache {
    known: std::collections::HashMap<PathBuf, bool>,
}

impl MarkerCache {
    pub fn covers(&mut self, path: &Path, root: &Path) -> bool {
        // A path that was deleted cannot be asked what it was, so start from
        // the parent unless the directory is still there to say otherwise. The
        // only marker that misses is one inside a directory that is itself
        // gone, which excludes nothing any more either.
        let start = if path.is_dir() { Some(path) } else { path.parent() };
        start.is_some_and(|dir| self.covered(dir, root))
    }

    /// Cached per directory as the answer for the *whole chain above it*, not
    /// for the one stat: a sibling asking about the same parent gets the
    /// finished answer rather than starting the climb again.
    fn covered(&mut self, dir: &Path, root: &Path) -> bool {
        if !dir.starts_with(root) {
            return false;
        }
        if let Some(known) = self.known.get(dir) {
            return *known;
        }
        let covered = dir.join(IGNORE_MARKER).exists()
            || dir.parent().is_some_and(|parent| self.covered(parent, root));
        self.known.insert(dir.to_path_buf(), covered);
        covered
    }
}

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
/// - `*-grids` — see [`is_generated_grid_dir`].
///
/// Anything not on this list is excluded with `.lumaignore` instead.
///
/// **Changing this list means bumping [`IGNORE_RULES_VERSION`]**, or the new
/// name stops future walks without reaching anything already indexed under it.
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
        || is_generated_grid_dir(name)
}

/// Stable Diffusion's contact sheets.
///
/// A1111 and Forge write one montage per batch into a directory named for the
/// tab that produced it — `txt2img-grids`, `img2img-grids` — beside the
/// `-images` directory holding the pictures themselves. So every grid is a
/// composite of files that are *already indexed individually*, which makes it
/// the same derived-copy problem as `@eaDir`, only worse in three ways:
///
/// - it is one row standing for a whole batch, so a rating applies to the
///   montage rather than to any picture in it,
/// - the montage is enormous — a 2x2 of 1040x1520 is 2080x3040 and megabytes —
///   so it is expensive to thumbnail and to rate,
/// - and it is a near-duplicate of several rows at once, which is noise the
///   perceptual hash cannot resolve into anything useful.
///
/// Matched on the suffix rather than the two literal names, because the prefix
/// is whatever tab made it and extensions add their own.
fn is_generated_grid_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with("-grids") || lower.ends_with("-grid")
}

/// Other apps' private storage: `~/Library`, minus the one part of it people
/// put files in themselves.
///
/// Watching a whole disk is a supported thing to do here, and this is nearly
/// everything such a scan finds: one home directory produced 668,957 files
/// under `~/Library` against 31,803 everywhere else — 658,909 of them inside a
/// single messaging app's group container, 282 GB nobody browsed to. Left in,
/// it is 95% of the library, and every phase behind it pays for that.
///
/// `Mobile Documents` is the exception, because it is iCloud Drive.
///
/// Read as a *position*, never as a name: a media folder called `Library` is
/// ordinary, especially on a share, so only a `Library` sitting directly in a
/// home directory counts.
fn is_home_library_storage(segments: &[&str]) -> bool {
    segments.windows(4).any(|w| {
        w[0].eq_ignore_ascii_case("Users")
            && w[2].eq_ignore_ascii_case("Library")
            && !w[3].eq_ignore_ascii_case("Mobile Documents")
    })
}

/// Split the way the index stores paths, not the way this host writes them: a
/// database written on Windows carries backslashes and must stay readable here.
fn path_segments(path: &str) -> Vec<&str> {
    path.split(['/', '\\']).collect()
}

/// Bump when a name is added to or removed from the ignore list above.
///
/// The index sweep that applies these rules retroactively is a table scan, and
/// on a real library `media` is hundreds of megabytes — so it runs once per
/// rule change rather than once per launch. Forgetting to bump this means a
/// newly-ignored directory stops being walked but its existing rows stay, which
/// is the exact failure the sweep exists to prevent.
pub const IGNORE_RULES_VERSION: &str = "2-home-library";

/// Would the walk have skipped the directory this file sits in?
///
/// The index needs to be able to ask the same question the walk does, for rows
/// that were added *before* a name joined the list above. Without it, adding a
/// name only stops future walks and leaves everything already indexed sitting
/// in the grid — which reads as the rule not working.
///
/// Split on both separators regardless of host: the index stores whatever the
/// filesystem reported, so a database written on Windows carries backslashes
/// and must still be readable by a build that is not running there.
pub fn is_in_ignored_dir(path: &str) -> bool {
    let mut segments = path_segments(path);
    // The file's own name is not a directory, and a picture called `x-grid.png`
    // is a picture.
    segments.pop();
    segments.iter().any(|segment| is_ignored_dir(segment))
        || is_home_library_storage(&segments)
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
pub fn walk_folder<F>(root: &Path, mut on_progress: F) -> Walk
where
    F: FnMut(usize, &Path),
{
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
                let path = entry.path().to_string_lossy();
                if is_ignored_dir(&name) || is_home_library_storage(&path_segments(&path)) {
                    return false;
                }
                // One stat per directory, not per file — cheap even on SMB.
                // Pruning here rather than filtering files later is also what
                // makes an excluded folder free: a marked directory holding
                // 50,000 texture maps is one stat, not 50,000.
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
    fn skips_stable_diffusions_contact_sheets() {
        // Every one is a montage of files already indexed one by one, so it is
        // a near-duplicate of several rows at once and its rating belongs to
        // none of them.
        assert!(is_ignored_dir("txt2img-grids"));
        assert!(is_ignored_dir("img2img-grids"));
        assert!(is_ignored_dir("TXT2IMG-GRIDS"), "case is the filesystem's to choose");
        assert!(is_ignored_dir("extras-grid"), "singular, for an extension that spells it that way");

        // The suffix is the rule, so a folder that merely mentions grids is not
        // one of these.
        assert!(!is_ignored_dir("txt2img-images"));
        assert!(!is_ignored_dir("grids and things"));
        assert!(!is_ignored_dir("my-grids-backup"));
    }

    #[test]
    fn reads_the_rule_off_a_whole_path_either_way_round() {
        // Windows, as the index actually stores it — including the
        // extended-length prefix every path on a share carries.
        assert!(is_in_ignored_dir(
            r"\\?\UNC\jebpot\devs\AI\Stable Diffusion\outputs\txt2img-grids\2026-08-04\grid-0008.png"
        ));
        // Posix, and a build that is not running on the machine that wrote it.
        assert!(is_in_ignored_dir("/vault/outputs/txt2img-grids/a.png"));
        assert!(is_in_ignored_dir("/vault/sub/@eaDir/thumb.jpg"));

        // The sibling directory holding the actual generations, which is the
        // entire point of the distinction.
        assert!(!is_in_ignored_dir(
            r"\\?\UNC\jebpot\devs\AI\Stable Diffusion\outputs\txt2img-images\2026-08-04\00166.png"
        ));

        // Only directories. A picture whose own name ends that way is a
        // picture — the last segment is never tested.
        assert!(!is_in_ignored_dir("/vault/photos/wedding-grid.png"));
        assert!(!is_in_ignored_dir("/vault/photos/holiday.jpg"));
    }

    /// 188-byte packets, each starting with sync byte 0x47.
    fn write_transport_stream(path: &Path) {
        let mut bytes = vec![0u8; 377];
        for offset in [0, 188, 376] {
            bytes[offset] = 0x47;
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_real_transport_stream_is_still_a_video() {
        let dir = tempfile::tempdir().unwrap();
        let capture = dir.path().join("recording.ts");
        write_transport_stream(&capture);

        assert_eq!(kind_of(&capture), Some(MediaKind::Video));
    }

    #[test]
    fn a_typescript_file_is_not_a_video() {
        // `ts` is a real video extension and the commonest source extension
        // there is; one whole-home scan matched 17,123 of these and no videos.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("media.ts");
        std::fs::write(&source, b"export const IMAGE_EXTENSIONS = ['jpg']\n").unwrap();

        assert_eq!(kind_of(&source), None);
    }

    #[test]
    fn skips_other_apps_private_storage_under_a_home_library() {
        // What a whole-home scan actually turns up: 659k files in WhatsApp's
        // group container alone, none of them anything you went looking for.
        assert!(is_in_ignored_dir(
            "/Users/someone/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media/0@s.whatsapp.net/8/b/x.mp4"
        ));
        assert!(is_in_ignored_dir(
            "/Users/someone/Library/Containers/net.whatsapp.WhatsApp/Data/x.jpg"
        ));
        assert!(is_in_ignored_dir(
            "/Users/someone/Library/Application Support/Google/Chrome/Default/x.png"
        ));
        assert!(is_in_ignored_dir(
            "/Users/someone/Library/Developer/CoreSimulator/Devices/7E/data/x.png"
        ));
        assert!(is_in_ignored_dir("/Users/someone/Library/Caches/x.jpg"));
    }

    #[test]
    fn keeps_icloud_drive_which_lives_under_the_same_library() {
        // `Mobile Documents` is the one directory under `~/Library` holding
        // files a person put there themselves, so the rule stops short of it.
        assert!(!is_in_ignored_dir(
            "/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/Photos/holiday.jpg"
        ));
    }

    #[test]
    fn only_a_home_library_counts_as_app_storage() {
        // The rule reads a position, not a name: a media folder is free to be
        // called `Library`, and on a share it very often is.
        assert!(!is_in_ignored_dir("/Volumes/Media/Library/Caches/holiday.jpg"));
        assert!(!is_in_ignored_dir("/Users/someone/Pictures/Library/holiday.jpg"));
        // The home directory itself is not app storage.
        assert!(!is_in_ignored_dir("/Users/someone/Pictures/holiday.jpg"));
    }

    #[test]
    fn a_home_library_is_walked_straight_past() {
        // Not just pruned afterwards: descending into a group container costs
        // the walk hundreds of thousands of stats before anything can drop them.
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("Users").join("someone");
        let container = home.join("Library").join("Group Containers").join("app.shared");
        let icloud = home.join("Library").join("Mobile Documents").join("com~apple~CloudDocs");
        let pictures = home.join("Pictures");
        std::fs::create_dir_all(&container).unwrap();
        std::fs::create_dir_all(&icloud).unwrap();
        std::fs::create_dir_all(&pictures).unwrap();
        std::fs::write(container.join("received.jpg"), b"x").unwrap();
        std::fs::write(icloud.join("scan.jpg"), b"x").unwrap();
        std::fs::write(pictures.join("holiday.jpg"), b"x").unwrap();

        let walk = walk_folder(root.path(), |_, _| {});
        let mut names: Vec<&str> = walk.files.iter().map(|f| f.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec!["holiday.jpg", "scan.jpg"],
            "iCloud Drive and the real folders survive; the app container does not"
        );
    }

    #[test]
    fn a_grid_directory_is_walked_straight_past() {
        // The layout Automatic1111 and Forge actually write.
        let root = tempfile::tempdir().unwrap();
        let outputs = root.path().join("outputs");
        let images = outputs.join("txt2img-images").join("2026-08-04");
        let grids = outputs.join("txt2img-grids").join("2026-08-04");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::create_dir_all(&grids).unwrap();
        std::fs::write(images.join("00166-3997412987.png"), b"x").unwrap();
        std::fs::write(grids.join("grid-0008.png"), b"x").unwrap();

        let walk = walk_folder(root.path(), |_, _| {});
        let names: Vec<&str> = walk.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["00166-3997412987.png"],
            "the generations are indexed and the contact sheet is not"
        );
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

        let files = walk_folder(root, |_, _| {}).files;
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

        let all = walk_folder(root.path(), |_, _| {});
        assert_eq!(all.files.len(), 3, "nothing excluded yet");

        // Excluding is writing the marker. There is no second list the walk
        // also consults, which is what stops the two from ever disagreeing.
        write_marker(&textures).unwrap();
        let walk = walk_folder(root.path(), |_, _| {});
        let names: Vec<&str> = walk.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["keep.jpg"], "the pack and everything under it");
    }

    #[test]
    fn undo_removes_our_marker_and_leaves_a_hand_written_one_alone() {
        let dir = tempfile::tempdir().unwrap();
        let ours = dir.path().join("ours");
        let theirs = dir.path().join("theirs");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();

        write_marker(&ours).unwrap();
        std::fs::write(theirs.join(IGNORE_MARKER), b"scratch renders, never index").unwrap();

        assert!(remove_marker(&ours).unwrap());
        assert!(!ours.join(IGNORE_MARKER).exists());

        assert!(
            !remove_marker(&theirs).unwrap(),
            "a marker we did not write is not ours to delete, and undo has to say so"
        );
        assert!(theirs.join(IGNORE_MARKER).exists());

        assert!(
            remove_marker(&ours).unwrap(),
            "a folder with no marker is already in the state undo is asking for"
        );
    }

    #[test]
    fn a_marker_saved_in_notepad_is_still_ours() {
        // Windows editors rewrite the line endings of anything they touch, and
        // a marker that stopped being recognised would make undo stop working
        // for the one user who opened the file to see what it was.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(IGNORE_MARKER), MARKER_BODY.replace('\n', "\r\n"))
            .unwrap();

        assert!(remove_marker(dir.path()).unwrap());
        assert!(!dir.path().join(IGNORE_MARKER).exists());
    }

    #[test]
    fn write_marker_does_not_overwrite_what_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(IGNORE_MARKER), b"mine, with a reason in it").unwrap();

        write_marker(dir.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join(IGNORE_MARKER)).unwrap(),
            "mine, with a reason in it",
            "already excluded is already excluded; the file is not ours to rewrite"
        );
    }

    #[test]
    fn the_marker_cache_answers_for_every_directory_up_to_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let excluded = root.join("assets").join("Texture Pack");
        let deep = excluded.join("brick").join("4k");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(root.join("photos")).unwrap();
        write_marker(&excluded).unwrap();

        let mut cache = MarkerCache::default();
        assert!(cache.covers(&deep.join("normal.png"), root), "two levels under the marker");
        assert!(cache.covers(&excluded, root), "the marked directory itself");
        assert!(!cache.covers(&root.join("photos").join("keep.jpg"), root));
        // The second ask is the one the cache exists for, and it must not
        // change the answer.
        assert!(cache.covers(&deep.join("diffuse.png"), root));

        // Nothing above the watched root is ever stat'd, whatever sits there.
        assert!(!cache.covers(root.parent().unwrap(), root));
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

        let walk = walk_folder(root.path(), |_, _| {});

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

        let Walk { files, errors, .. } = walk_folder(root, |_, _| {});
        let mut names: Vec<_> = files.iter().map(|f| f.name.clone()).collect();
        names.sort();

        assert_eq!(names, vec!["a.jpg", "b.mp4"]);
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    }
}
