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

/// Whether deleting this file could put it in a Recycle Bin.
///
/// False for a network share, where Windows has no bin at all — Explorer
/// deletes outright there and warns you it is doing so. It matters because
/// every path in this index is a share, so "you can restore it from the bin"
/// would be a lie on every file in the library.
///
/// Takes the *external* spelling: a share is `\\server\share\…` once
/// [`external_path`] has run, and `\\?\UNC\…` before it, so both are caught.
pub fn has_recycle_bin(path: &str) -> bool {
    let unc = path.starts_with(r"\\?\UNC\") || path.starts_with(r"\\?\unc\");
    // A plain `\\server\share`, but not the `\\?\D:\` verbatim disk form, which
    // starts with the same two backslashes and *is* local.
    let plain_unc = path.starts_with(r"\\") && !path.starts_with(r"\\?\");
    !(unc || plain_unc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_share_has_no_recycle_bin_in_either_spelling() {
        // Measured: `trash::delete` on a file here fails with 0x80070002, and
        // the shell's own recycle call deletes the file outright and reports
        // success. Neither leaves anything to restore.
        assert!(!has_recycle_bin(r"\\?\UNC\jebpot\devs\AI\a.jpg"));
        assert!(!has_recycle_bin(r"\\jebpot\devs\AI\a.jpg"));
    }

    #[test]
    fn a_local_disk_has_one_despite_the_leading_backslashes() {
        assert!(has_recycle_bin(r"\\?\D:\vault\a.mp4"));
        assert!(has_recycle_bin(r"D:\vault\a.mp4"));
        assert!(has_recycle_bin("/Users/x/vault/a.mp4"));
    }

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
