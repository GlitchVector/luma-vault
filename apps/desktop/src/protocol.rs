//! The `luma://` scheme — how local files reach the webview.
//!
//! ```text
//! luma://localhost/?path=<percent-encoded absolute path>
//! ```
//!
//! # Why a custom scheme at all
//!
//! The alternatives are worse. Base64 data URLs inflate every payload by 33%,
//! cost a JSON parse and a React state update per image, and defeat the
//! browser's image cache entirely — that is what the previous generation of
//! this app did, and replacing it was the single largest speedup it ever got.
//! Serving over HTTP from a local server means a second process, a port, and
//! CORS. A custom scheme is a direct read with none of that.
//!
//! # Access control
//!
//! Requests are only served for files inside a watched folder or inside the
//! app's own derived-data directories. The previous implementation had no
//! allowlist at all: any absolute path on disk was readable by the webview.
//! Combined with the strict CSP in `tauri.conf.json` — which forbids the page
//! from talking to any remote origin — an allowlisted read cannot be exfiltrated
//! even if a page were somehow compromised.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response};

use crate::db::Db;

pub const SCHEME: &str = "luma";

pub struct ProtocolRoots {
    pub db: Arc<Db>,
    pub thumb_root: PathBuf,
    pub frame_root: PathBuf,
}

/// Extract the `path` query parameter and percent-decode it as UTF-8.
///
/// The decode is the important part. A hand-rolled hex decoder that builds a
/// `char` from `(high << 4) | low` — which is what the previous version did —
/// mangles every non-ASCII filename, because a UTF-8 path is a byte sequence
/// and each byte is not a character. `percent_decode_str` decodes to bytes and
/// then validates UTF-8, which is correct for `Ä`, `日本語`, and emoji alike.
pub fn extract_path(uri: &str) -> Option<String> {
    let query_start = uri.find("?path=")?;
    let encoded = &uri[query_start + "?path=".len()..];
    // Anything after a subsequent `&` is not part of the path.
    let encoded = encoded.split('&').next().unwrap_or(encoded);
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
    let decoded = decoded.into_owned();
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

/// True when `candidate` sits inside one of `roots`.
///
/// Both sides are canonicalized, so `..` segments and symlinks cannot be used
/// to escape a watched folder.
pub fn is_allowed(candidate: &Path, roots: &[PathBuf]) -> bool {
    let Ok(real) = candidate.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        root.canonicalize()
            .map(|real_root| real.starts_with(real_root))
            .unwrap_or(false)
    })
}

pub fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("heic" | "heif") => "image/heic",
        Some("tif" | "tiff") => "image/tiff",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

/// Most bytes handed back for one request.
///
/// The handler used to `fs::read` the whole file. That is survivable for a
/// thumbnail and fatal for a video: this library holds 13 files over 4GB and
/// one of 20GB, and reading one allocates it in this process and then again in
/// the webview. Chromium aborts with its OOM exception (0xE0000008) and takes
/// the app down.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

/// Above this, a request with no `Range` still gets a partial response.
///
/// A `<video>`'s first request carries no `Range` — it discovers it can seek
/// from `Accept-Ranges` in the reply. Answering that first request with the
/// whole file is what runs out of memory, so past this size the first chunk is
/// returned instead and the element takes it from there. Below it, whole-file
/// replies keep `<img>` simple.
const MAX_WHOLE_FILE: u64 = 32 * 1024 * 1024;

/// Parse a `Range` header into an inclusive byte range, clamped to the file.
///
/// Handles the three forms a browser sends: `bytes=0-1023`, `bytes=512-` and
/// the suffix form `bytes=-512` (the *last* 512 bytes, which is how a player
/// finds an MP4 moov atom at the end of the file). Anything malformed or
/// unsatisfiable returns `None`, and the caller falls back to the start.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    // Multi-range requests are legal but rare; serving the first range is a
    // conforming response and avoids multipart encoding.
    let spec = spec.split(',').next()?.trim();
    let (from, to) = spec.split_once('-')?;

    if from.is_empty() {
        // Suffix: the last N bytes.
        let n: u64 = to.parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        let start = len.saturating_sub(n);
        return Some((start, len - 1));
    }

    let start: u64 = from.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if to.is_empty() {
        len - 1
    } else {
        to.parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// Read `[start, end]` inclusive without pulling the rest of the file in.
fn read_span(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let wanted = (end - start + 1) as usize;
    let mut buffer = vec![0_u8; wanted];
    let mut filled = 0;
    while filled < wanted {
        match file.read(&mut buffer[filled..])? {
            0 => break, // truncated underneath us; serve what exists
            n => filled += n,
        }
    }
    buffer.truncate(filled);
    Ok(buffer)
}

fn error(status: u16, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("static response always builds")
}

pub fn handle(roots: &ProtocolRoots, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();

    let Some(path_str) = extract_path(&uri) else {
        return error(400, "missing ?path= parameter");
    };
    let path = PathBuf::from(&path_str);

    let mut allowed: Vec<PathBuf> = roots.db.folder_paths().unwrap_or_default();
    allowed.push(roots.thumb_root.clone());
    allowed.push(roots.frame_root.clone());

    if !is_allowed(&path, &allowed) {
        // Deliberately terse: a 403 that echoes the path back would make this
        // endpoint a filesystem-existence oracle.
        return error(403, "path is not inside a watched folder");
    }

    let len = match std::fs::metadata(&path) {
        Ok(meta) => meta.len(),
        Err(meta_error) => {
            return if meta_error.kind() == std::io::ErrorKind::NotFound {
                error(404, "not found")
            } else {
                error(500, "cannot read file")
            };
        }
    };

    let requested = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, len));

    // Whole-file replies only for things small enough to hold twice over.
    let whole_file = requested.is_none() && len <= MAX_WHOLE_FILE;

    let (start, end) = match requested {
        Some((start, end)) => (start, end.min(start + MAX_CHUNK - 1)),
        None if whole_file => (0, len.saturating_sub(1)),
        None => (0, (MAX_CHUNK - 1).min(len.saturating_sub(1))),
    };

    let bytes = match read_span(&path, start, end) {
        Ok(bytes) => bytes,
        Err(read_error) => {
            return if read_error.kind() == std::io::ErrorKind::NotFound {
                error(404, "not found")
            } else {
                error(500, "cannot read file")
            };
        }
    };

    let builder = Response::builder()
        .header("Content-Type", mime_for(&path))
        // Advertised unconditionally: it is what tells a <video> it may seek,
        // and without it the element re-requests from zero to scrub.
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", bytes.len().to_string())
        // Derived files are content-addressed and originals are immutable
        // for as long as the row exists — the watcher deletes the row when
        // the file changes, so a long cache is safe and keeps scrolling
        // back through a large grid free.
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*");

    let builder = if len == 0 || whole_file {
        builder.status(200)
    } else {
        builder
            .status(206)
            .header("Content-Range", format!("bytes {start}-{end}/{len}"))
    };

    builder
        .body(bytes)
        .unwrap_or_else(|_| error(500, "cannot build response"))
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn parses_the_three_range_forms_a_browser_sends() {
        assert_eq!(parse_range("bytes=0-1023", 5000), Some((0, 1023)));
        // Open-ended: everything from here on.
        assert_eq!(parse_range("bytes=512-", 5000), Some((512, 4999)));
        // Suffix: the LAST n bytes. A player asks for this to find an MP4's
        // moov atom, which sits at the end of the file.
        assert_eq!(parse_range("bytes=-500", 5000), Some((4500, 4999)));
    }

    #[test]
    fn a_range_past_the_end_is_clamped_or_refused() {
        // Clamped: a browser routinely asks for more than exists.
        assert_eq!(parse_range("bytes=4000-999999", 5000), Some((4000, 4999)));
        // Refused: a start beyond the file is unsatisfiable, not empty.
        assert_eq!(parse_range("bytes=5000-", 5000), None);
        assert_eq!(parse_range("bytes=6000-7000", 5000), None);
    }

    #[test]
    fn malformed_ranges_fall_back_rather_than_panic() {
        assert_eq!(parse_range("", 5000), None);
        assert_eq!(parse_range("items=0-10", 5000), None);
        assert_eq!(parse_range("bytes=abc-def", 5000), None);
        assert_eq!(parse_range("bytes=10", 5000), None);
        assert_eq!(parse_range("bytes=900-100", 5000), None, "end before start");
    }

    #[test]
    fn a_multi_range_request_serves_its_first_range() {
        // Legal but rare. Serving the first range is conforming and avoids
        // having to encode a multipart body.
        assert_eq!(parse_range("bytes=0-99,200-299", 5000), Some((0, 99)));
    }

    #[test]
    fn a_span_is_read_without_touching_the_rest_of_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("big.bin");
        let body: Vec<u8> = (0..=255_u8).cycle().take(10_000).collect();
        std::fs::write(&file, &body).unwrap();

        let span = read_span(&file, 1000, 1099).expect("span");
        assert_eq!(span.len(), 100);
        assert_eq!(span, &body[1000..=1099]);

        // Asking past the end yields what exists rather than erroring, so a
        // file truncated mid-request degrades instead of failing the response.
        let tail = read_span(&file, 9_950, 10_500).expect("tail");
        assert_eq!(tail.len(), 50);
    }

    #[test]
    fn extracts_and_decodes_a_path() {
        let uri = "luma://localhost/?path=%2FUsers%2Fx%2FBilder%2FGr%C3%BCn.jpg";
        assert_eq!(
            extract_path(uri).as_deref(),
            Some("/Users/x/Bilder/Grün.jpg"),
            "non-ASCII paths must survive the round trip"
        );
    }

    #[test]
    fn decodes_multibyte_and_emoji_paths() {
        let uri = "luma://localhost/?path=%2Fa%2F%E6%97%A5%E6%9C%AC%E8%AA%9E%2F%F0%9F%93%B7.png";
        assert_eq!(extract_path(uri).as_deref(), Some("/a/日本語/📷.png"));
    }

    #[test]
    fn rejects_a_uri_with_no_path() {
        assert!(extract_path("luma://localhost/").is_none());
        assert!(extract_path("luma://localhost/?path=").is_none());
    }

    #[test]
    fn ignores_trailing_query_parameters() {
        let uri = "luma://localhost/?path=%2Fa%2Fb.jpg&v=2";
        assert_eq!(extract_path(uri).as_deref(), Some("/a/b.jpg"));
    }

    #[test]
    fn allows_a_file_inside_a_root_and_rejects_one_outside() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("watched");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("a.jpg");
        std::fs::write(&inside, b"x").unwrap();

        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();

        let roots = vec![root.clone()];
        assert!(is_allowed(&inside, &roots));
        assert!(!is_allowed(&outside, &roots));
    }

    #[test]
    fn rejects_traversal_out_of_a_watched_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("watched");
        std::fs::create_dir_all(&root).unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();

        let traversal = root.join("../secret.txt");
        assert!(
            !is_allowed(&traversal, &[root]),
            "canonicalization must collapse .. before the prefix check"
        );
    }

    #[test]
    fn maps_common_media_types() {
        assert_eq!(mime_for(Path::new("/a/b.JPG")), "image/jpeg");
        assert_eq!(mime_for(Path::new("/a/b.mp4")), "video/mp4");
        assert_eq!(mime_for(Path::new("/a/b.unknown")), "application/octet-stream");
    }
}
