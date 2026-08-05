//! Pairing an upscaled variant with the picture it came from.
//!
//! The upscaler writes its output beside the original, as
//! `<name>_upscaled_4k.png`. That naming *is* the link — there is no sidecar
//! file and no separate table, because the pair has to survive the library
//! being moved, backed up, or rebuilt from scratch, and a filename survives all
//! three where a row in a database the user can delete does not.
//!
//! Derived once, at insert, into `media.upscaled_from`. Recomputing it per query
//! would mean string work on every row of a 165,000-row scan for a question
//! whose answer cannot change while the file keeps its name.

/// What the upscaler appends. Also what the app passes it as `--suffix`, so the
/// two cannot disagree about which files are variants.
pub const UPSCALE_SUFFIX: &str = "_upscaled_4k";

/// The picture this path is an upscale of, or `None` if it is not one.
///
/// # Why the extension is replaced rather than kept
///
/// The upscaler always writes PNG, whatever it read. So a JPEG original named
/// `holiday.jpg` produces `holiday_upscaled_4k.png`, and the original's own
/// extension is not recoverable from the variant's name — the best this can do
/// is name `holiday.png`, which will not match.
///
/// Left deliberately: the failure is that both files stay visible in the grid,
/// which is the *previous* behaviour and merely unhelpful. Guessing at
/// extensions instead risks pairing a variant with a different picture that
/// happens to share a stem, which would hide the wrong file.
pub fn original_of(path: &str) -> Option<String> {
    let separator = path.rfind(['/', '\\']).map_or(0, |at| at + 1);
    let (directory, name) = path.split_at(separator);

    // Split the extension off the *name*, so a dot in a directory further up
    // cannot be mistaken for one.
    let (stem, extension) = match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at..]),
        _ => (name, ""),
    };

    let base = stem.strip_suffix(UPSCALE_SUFFIX)?;
    if base.is_empty() {
        // A file called exactly `_upscaled_4k.png` is not a variant of anything.
        return None;
    }
    Some(format!("{directory}{base}{extension}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_picture_a_variant_came_from() {
        assert_eq!(
            original_of(r"D:\out\00118-2582348952_upscaled_4k.png").as_deref(),
            Some(r"D:\out\00118-2582348952.png"),
        );
        assert_eq!(
            original_of("/vault/out/holiday_upscaled_4k.png").as_deref(),
            Some("/vault/out/holiday.png"),
        );
    }

    #[test]
    fn survives_the_extended_length_paths_the_index_actually_stores() {
        // Every path in this library is a UNC share in canonical form, and the
        // separator search has to find the last backslash in one of those.
        assert_eq!(
            original_of(r"\\?\UNC\jebpot\devs\AI\a\00301_upscaled_4k.png").as_deref(),
            Some(r"\\?\UNC\jebpot\devs\AI\a\00301.png"),
        );
    }

    #[test]
    fn leaves_ordinary_files_alone() {
        assert_eq!(original_of(r"D:\out\00118-2582348952.png"), None);
        assert_eq!(original_of("/vault/holiday.jpg"), None);
        // The suffix in the middle is not the suffix.
        assert_eq!(original_of("/vault/_upscaled_4k_notes.png"), None);
        // A directory named for the suffix must not make its contents variants.
        assert_eq!(original_of("/vault/_upscaled_4k/a.png"), None);
    }

    #[test]
    fn refuses_a_file_that_is_only_the_suffix() {
        // Stripping would leave nothing, and `.png` names no picture.
        assert_eq!(original_of("/vault/_upscaled_4k.png"), None);
    }

    #[test]
    fn handles_a_name_with_no_extension_at_all() {
        assert_eq!(
            original_of("/vault/holiday_upscaled_4k").as_deref(),
            Some("/vault/holiday"),
        );
    }
}
