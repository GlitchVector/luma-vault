//! The path spelling everything *outside* this process understands.
//!
//! The index stores canonicalized paths, which on Windows means the
//! extended-length form: `\\?\UNC\server\share\file` for a share, `\\?\D:\dir`
//! for a local disk. Rust's own `std::fs` handles those happily, which is why
//! the scanner, the thumbnailer and the `luma://` handler never noticed.
//!
//! Anything else does notice. Two independent consumers have already been
//! broken by it, in different ways:
//!
//! - **ffmpeg** opens them but misdetects the format, so a file whose extension
//!   lies about its contents decodes as garbage rather than by content probing.
//! - **The Windows shell** cannot resolve them at all — `Shell.NameSpace` on a
//!   `\\?\UNC\` path returns nothing, so "Reveal in Explorer" silently did
//!   nothing.
//!
//! Hence one place for the rule rather than a fix at each call site.

/// Rewrite an indexed path into the form external tools and the shell accept.
///
/// Returns the input unchanged when there is no verbatim prefix, so it is safe
/// to apply unconditionally and is a no-op everywhere but Windows.
pub fn external_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` is the verbatim spelling of `\\server\share`.
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verbatim_unc_path_becomes_the_plain_share_path() {
        // Measured two ways: ffprobe reports width=0 for the verbatim form and
        // 540x385 for this one on the same file, and the Windows shell resolves
        // only this one.
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
}
