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

    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime_for(&path))
            // Derived files are content-addressed and originals are immutable
            // for as long as the row exists — the watcher deletes the row when
            // the file changes, so a long cache is safe and keeps scrolling
            // back through a large grid free.
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap_or_else(|_| error(500, "cannot build response")),
        Err(read_error) => {
            if read_error.kind() == std::io::ErrorKind::NotFound {
                error(404, "not found")
            } else {
                error(500, "cannot read file")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
