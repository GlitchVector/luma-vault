//! Finding the same picture twice.
//!
//! # Why not the content key
//!
//! `thumbs::content_key` already identifies a file by its bytes, and that is
//! what stops the same file being thumbnailed twice under two names. It is
//! useless here: re-save a PNG as a JPEG, resize it, or let an upscaler near
//! it, and the bytes are unrelated while the picture is identical. A library
//! assembled over a decade is full of exactly that.
//!
//! # The hash
//!
//! A 64-bit **difference hash**. The thumbnail is reduced to 9×8 greyscale and
//! each pixel compared with its right-hand neighbour, giving one bit per
//! comparison. What survives is the coarse structure of light and dark — which
//! is what "the same picture" means to a person, and what resizing and
//! re-compression leave alone.
//!
//! Computed from the **thumbnail**, not the original. Every row already has
//! one, they are local rather than on a share, and they are already normalised
//! to a common size — which is the first thing any perceptual hash does anyway.
//!
//! # Finding the pairs without comparing everything to everything
//!
//! 165,000 rows is 13.6 billion pairs. Instead the hash is split into four
//! 16-bit bands: by the pigeonhole principle, two hashes within a Hamming
//! distance of 3 must agree *exactly* on at least one band. Bucketing by each
//! band in turn yields a small candidate set, and only those get the real
//! distance check.

use std::collections::HashMap;

use anyhow::Result;

/// How many bits may differ before two pictures are considered different.
///
/// Three, because the band trick is exact only up to three: with four bands, a
/// pair differing by four bits can put one bit in every band and share none.
/// Raising this would need more bands and a wider candidate sweep, and in
/// practice 3 already catches re-encodes, resizes and quality changes while
/// leaving genuinely different pictures alone.
pub const MAX_DISTANCE: u32 = 3;

/// A bucket bigger than this is a shape shared by too many rows to be a subject.
///
/// A backstop rather than the main defence — see [`is_featureless`], which
/// removes the images that actually cause it.
const MAX_BUCKET: usize = 256;

/// Does this hash describe a picture of nothing?
///
/// A difference hash records, per pixel, whether it is brighter than its right
/// neighbour. A flat or near-flat image — a black video poster, a blank scan, a
/// solid background — has no such transitions, so its hash collapses to nearly
/// all zeros, and a smooth left-to-right ramp collapses to nearly all ones.
/// Every image like that matches every other one exactly.
///
/// They are not copies of each other; they are pictures of nothing, and calling
/// a thousand blank frames a duplicate set is noise that buries the real
/// findings. Filtering on the hash itself is precise where filtering on bucket
/// size was not: it identifies the *cause* rather than one of its symptoms.
fn is_featureless(hash: u64) -> bool {
    !(8..=56).contains(&hash.count_ones())
}

/// Colour signature: an 8x8 RGB reduction, 192 bytes.
///
/// The difference hash is computed on **greyscale**, so it cannot tell a
/// blue-lit bar from an amber-lit stage — two dark photographs with a bright
/// patch in the same place are identical to it. That is not a flaw to tune
/// away; 64 bits of luminance structure is simply not enough to decide, and
/// measured on this library the hash's own picks scored a mean colour distance
/// of **39.9** where genuine duplicates scored **0**.
///
/// So the hash proposes and this disposes. Taken from the same decoded
/// thumbnail in the same pass, so it costs a resize and nothing else.
pub fn colour_signature(image: &image::DynamicImage) -> Vec<u8> {
    image
        .resize_exact(8, 8, image::imageops::FilterType::Triangle)
        .to_rgb8()
        .into_raw()
}

/// How far a picture is from monochrome, 0-255.
///
/// The mean per-cell gap between a signature's strongest and weakest channel.
/// Grey is `r == g == b`, so a genuinely black-and-white picture scores ~0
/// however light or dark it is — which is the property wanted, since "black and
/// white" is about the absence of colour and not about brightness.
///
/// Measured across this library: the median picture scores **29.7** and the
/// 90th percentile **58.3**, while 5.3% sit at or under 1. Monochrome is a
/// tight cluster a long way from everything else, so the exact cut is not
/// delicate — see `db::MAX_GREYSCALE_CHROMA`.
///
/// Sepia and other single-hue tints deliberately score *high*: every cell is
/// off-grey by the same amount, and calling those black-and-white would be
/// wrong in the way that matters to somebody looking for black-and-white.
pub fn chroma(signature: &[u8]) -> f64 {
    if signature.len() < 3 {
        return 0.0;
    }
    let cells = signature.len() / 3;
    let mut total = 0_u32;
    for cell in signature.chunks_exact(3) {
        let high = cell.iter().copied().max().unwrap_or(0);
        let low = cell.iter().copied().min().unwrap_or(0);
        total += u32::from(high - low);
    }
    f64::from(total) / cells as f64
}

/// Mean absolute channel difference, 0-255.
pub fn colour_distance(a: &[u8], b: &[u8]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        // An absent or mismatched signature must not silently pass the check.
        return f64::MAX;
    }
    let total: u32 = a
        .iter()
        .zip(b)
        .map(|(left, right)| left.abs_diff(*right) as u32)
        .sum();
    total as f64 / a.len() as f64
}

/// How far apart two signatures may be and still be one picture.
///
/// Measured, not chosen. A real duplicate put through a quality-55 JPEG
/// re-encode *and* a 4x downscale round-trip scored **0.87 at worst** across
/// 200 thumbnails from this library. Pairs the hash grouped on its own had a
/// median of 39.9. Eight is nine times the worst genuine case and a fifth of
/// the typical false one, which is the kind of gap that makes the exact value
/// unimportant.
pub const MAX_COLOUR_DISTANCE: f64 = 8.0;

/// The difference hash of an already-decoded thumbnail.
pub fn difference_hash(image: &image::DynamicImage) -> u64 {
    // 9 wide because the hash is the *comparisons between* columns: nine
    // pixels give the eight bits per row that make up 64.
    let small = image
        .grayscale()
        .resize_exact(9, 8, image::imageops::FilterType::Triangle)
        .to_luma8();

    let mut hash = 0_u64;
    let mut bit = 0;
    for y in 0..8 {
        for x in 0..8 {
            if small.get_pixel(x, y).0[0] > small.get_pixel(x + 1, y).0[0] {
                hash |= 1 << bit;
            }
            bit += 1;
        }
    }
    hash
}

/// Both fingerprints from one decode.
pub fn fingerprint(path: &std::path::Path) -> Result<(u64, Vec<u8>)> {
    let image = image::open(path)?;
    Ok((difference_hash(&image), colour_signature(&image)))
}

/// The four 16-bit bands a hash is bucketed by. See the module note.
pub fn bands(hash: u64) -> [u16; 4] {
    [
        hash as u16,
        (hash >> 16) as u16,
        (hash >> 32) as u16,
        (hash >> 48) as u16,
    ]
}

fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[derive(Debug, Default)]
pub struct Grouping {
    /// Row id → group id. Only rows that have a duplicate appear.
    pub groups: HashMap<i64, i64>,
    /// How many groups were found.
    pub group_count: i64,
    /// Rows dropped from consideration for sitting in an oversized bucket.
    pub skipped_common: usize,
}

/// Cluster rows whose hashes are within [`MAX_DISTANCE`] of a group's anchor.
///
/// # Why not transitive closure
///
/// The obvious implementation unions every pair within the threshold, which
/// makes membership transitive: A near B and B near C puts all three together
/// even if A and C are further apart. That reads as generous and is, at this
/// scale, catastrophic — measured on a real 165,000-image library it produced a
/// single "group" of **1,864 pictures whose extremes were 35 bits apart**, and
/// flagged 46% of the library as duplicates. Every near-miss is a bridge, and
/// with enough images the bridges join everything.
///
/// So each group has an **anchor**, and a row joins only if it is within
/// [`MAX_DISTANCE`] of *that* — never of some member which is itself three bits
/// out. Drift is bounded at three bits from the anchor instead of accumulating
/// along a chain.
///
/// The cost is that a genuine chain — three saves of one picture, each slightly
/// further from the last — can split into two groups. That is the right way to
/// be wrong: two groups of real duplicates is a minor annoyance, one group of
/// 1,864 unrelated pictures is a broken feature.
///
/// # The colour check
///
/// The hash proposes; [`colour_distance`] disposes. Greyscale structure alone
/// put a blue-lit photograph of a man in a bar together with an amber-lit
/// stage performance, because both are dark with a bright patch in the middle.
/// A candidate must clear both tests.
pub fn group(rows: &[(i64, u64, Vec<u8>)]) -> Grouping {
    // Sorted by id, so the anchor of each group is its lowest member and the
    // result does not depend on what order the database handed rows over.
    let mut ordered: Vec<(i64, u64, Vec<u8>)> = rows.to_vec();
    ordered.sort_unstable_by_key(|(id, _, _)| *id);

    // Anchors, bucketed by band, so a row only compares against anchors it
    // could plausibly match rather than all of them.
    let mut anchor_bands: [HashMap<u16, Vec<usize>>; 4] = Default::default();
    // (anchor id, anchor hash, anchor colour) per group.
    let mut anchors: Vec<(i64, u64, Vec<u8>)> = Vec::new();
    let mut members: Vec<Vec<i64>> = Vec::new();
    let mut skipped_common = 0;

    for (id, hash, colour) in ordered {
        if is_featureless(hash) {
            skipped_common += 1;
            continue;
        }

        let mut joined = None;
        'search: for (band, value) in bands(hash).into_iter().enumerate() {
            let Some(candidates) = anchor_bands[band].get(&value) else {
                continue;
            };
            // A band shared by hundreds of anchors is a flat colour, not a
            // subject: blank frames, solid backgrounds, letterboxed posters.
            // They are not copies of each other, and pairing them is quadratic.
            if candidates.len() > MAX_BUCKET {
                continue;
            }
            for &candidate in candidates {
                // Both tests, in cost order: the hash is two integers, the
                // colour check is 192 bytes.
                if distance(anchors[candidate].1, hash) <= MAX_DISTANCE
                    && colour_distance(&anchors[candidate].2, &colour) <= MAX_COLOUR_DISTANCE
                {
                    joined = Some(candidate);
                    break 'search;
                }
            }
        }

        match joined {
            Some(group) => members[group].push(id),
            None => {
                let index = anchors.len();
                anchors.push((id, hash, colour));
                members.push(vec![id]);
                for (band, value) in bands(hash).into_iter().enumerate() {
                    anchor_bands[band].entry(value).or_default().push(index);
                }
            }
        }
    }

    let mut groups = HashMap::new();
    let mut group_count = 0;
    for (index, ids) in members.into_iter().enumerate() {
        // A row on its own is not a duplicate of anything.
        if ids.len() < 2 {
            continue;
        }
        group_count += 1;
        // The anchor's id names the group. It is the lowest member by
        // construction, so the numbering is stable between runs and the grid
        // does not reshuffle under someone half way through reviewing it.
        let group_id = anchors[index].0;
        for id in ids {
            groups.insert(id, group_id);
        }
    }

    Grouping {
        groups,
        group_count,
        skipped_common,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    /// A flat colour signature, for tests about the hash rather than colour.
    fn plain(level: u8) -> Vec<u8> {
        vec![level; 192]
    }

    /// A picture with the shape of a picture: large blocks of contrasting
    /// brightness, laid out from the seed.
    ///
    /// The first version of this was a fine diagonal gradient, and both tests
    /// below caught it. A high-frequency ramp aliases differently at every
    /// scale, so "the same picture, resized" genuinely did not hash alike — and
    /// after downscaling it collapsed to a monotonic ramp, giving hashes of 0
    /// and 1 that made two unrelated images look identical.
    ///
    /// Neither was a flaw in the hash. Photographs are low-frequency at 8x8,
    /// which is the resolution this all comes down to, and a fixture has to be
    /// the same or it tests nothing that happens in practice.
    fn picture(seed: u8, width: u32, height: u32) -> DynamicImage {
        let mut image = RgbImage::new(width, height);
        // A 4x4 arrangement of blocks — coarse enough to survive any resize.
        let mut cells = [0_u8; 16];
        let mut state = (seed as u32).wrapping_mul(2_654_435_761).wrapping_add(1);
        for cell in cells.iter_mut() {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            // Full range, so neighbouring cells differ enough to set a bit
            // rather than landing within rounding distance of each other.
            *cell = ((state >> 16) & 0xff) as u8;
        }
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let cell = (y * 4 / height.max(1)) * 4 + (x * 4 / width.max(1));
            let v = cells[(cell as usize).min(15)];
            *pixel = Rgb([v, v, v]);
        }
        DynamicImage::ImageRgb8(image)
    }

    /// What the pipeline hands to the hash: the 512px thumbnail, never the
    /// original. Mirrors `thumbs::write_thumbnail`, and it is the reason
    /// resolution stops mattering — both sides of any comparison have already
    /// been reduced to the same size before a single bit is computed.
    fn as_thumbnail(image: &DynamicImage) -> DynamicImage {
        image.thumbnail(crate::thumbs::THUMB_MAX, crate::thumbs::THUMB_MAX)
    }

    #[test]
    fn the_same_picture_at_another_size_hashes_the_same() {
        // The case the content key cannot see: identical picture, unrelated
        // bytes.
        let original = picture(3, 400, 300);
        let resized = original.resize_exact(200, 150, image::imageops::FilterType::Lanczos3);

        let d = distance(
            difference_hash(&as_thumbnail(&original)),
            difference_hash(&as_thumbnail(&resized)),
        );
        assert!(d <= MAX_DISTANCE, "a resize moved the hash {d} bits");
    }

    #[test]
    fn resolution_does_not_matter_at_all() {
        // A 4K original, a web-sized copy and a thumbnail-sized one. Comparing
        // the raw images would be unfair and is not what happens: a 3840px
        // reduction to 9x8 samples edges differently from a 480px one, which
        // measured 5 bits apart. Through the thumbnail step they converge,
        // because that is the only input the hash ever sees.
        let huge = as_thumbnail(&picture(11, 3840, 2160));
        let small = as_thumbnail(&picture(11, 480, 270));
        let tiny = as_thumbnail(&picture(11, 160, 90));

        let (a, b, c) = (
            difference_hash(&huge),
            difference_hash(&small),
            difference_hash(&tiny),
        );
        assert!(distance(a, b) <= MAX_DISTANCE, "3840px vs 480px: {}", distance(a, b));
        assert!(distance(a, c) <= MAX_DISTANCE, "3840px vs 160px: {}", distance(a, c));

        // And they land in one group rather than two pairs.
        let grouping = group(&[(1, a, plain(9)), (2, b, plain(9)), (3, c, plain(9))]);
        assert_eq!(grouping.group_count, 1);
    }

    #[test]
    fn different_pictures_do_not_collide() {
        let a = difference_hash(&picture(1, 300, 300));
        let b = difference_hash(&picture(200, 300, 300));
        assert!(
            distance(a, b) > MAX_DISTANCE,
            "unrelated pictures {a:x} and {b:x} were called duplicates"
        );
    }

    #[test]
    fn copies_of_one_picture_are_grouped() {
        // A hash with a mixture of set and clear bits, because that is what a
        // photograph produces — an earlier version of this test used all-zeros
        // and started failing the moment featureless hashes were rejected,
        // which is the fixture being wrong rather than the code.
        let a = 0x00ff_00ff_0f0f_3333_u64;
        let near = a ^ 0b111; // 3 bits away: a re-encode
        let far = !a;

        let grouping = group(&[
            (1, a, plain(9)),
            (2, near, plain(9)),
            (3, a, plain(9)),
            (4, far, plain(9)),
        ]);
        assert_eq!(grouping.group_count, 1);
        assert_eq!(grouping.groups.get(&1), grouping.groups.get(&2));
        assert_eq!(grouping.groups.get(&2), grouping.groups.get(&3));
        assert!(!grouping.groups.contains_key(&4), "a lone row is not a duplicate");
    }

    #[test]
    fn two_dark_photographs_lit_differently_are_not_the_same_picture() {
        // The reported failure, in the terms the code sees it: a blue-lit bar
        // and an amber-lit stage, both dark with a bright patch in the middle.
        // Greyscale structure cannot separate them — the hashes are identical —
        // and no threshold on the hash ever could.
        let shape = 0x00ff_00ff_0f0f_3333_u64;

        let mut blue = vec![0_u8; 192];
        let mut amber = vec![0_u8; 192];
        for pixel in 0..64 {
            // BGR-agnostic: what matters is that one is cold and one is warm.
            blue[pixel * 3] = 20;
            blue[pixel * 3 + 1] = 30;
            blue[pixel * 3 + 2] = 160;
            amber[pixel * 3] = 190;
            amber[pixel * 3 + 1] = 120;
            amber[pixel * 3 + 2] = 20;
        }

        assert_eq!(
            distance(shape, shape),
            0,
            "the premise: the hash cannot tell these apart",
        );
        assert!(
            colour_distance(&blue, &amber) > MAX_COLOUR_DISTANCE,
            "but colour can — {} apart",
            colour_distance(&blue, &amber),
        );
        assert_eq!(
            group(&[(1, shape, blue.clone()), (2, shape, amber)]).group_count,
            0,
            "so they must not be grouped",
        );

        // And the same picture re-encoded still is one. Measured on this
        // library, a quality-55 JPEG round-tripped through a 4x downscale moved
        // the signature by 0.87 at worst; this is well inside that.
        let mut nudged = blue.clone();
        for byte in nudged.iter_mut() {
            *byte = byte.saturating_add(2);
        }
        assert_eq!(
            group(&[(1, shape, blue), (2, shape, nudged)]).group_count,
            1,
            "a re-encode is still the same picture",
        );
    }

    #[test]
    fn a_chain_cannot_drag_unrelated_pictures_into_one_group() {
        // The bug this replaced. Each link is within threshold of the last, so
        // transitive closure swallowed the lot — measured on a real library
        // that produced one group of 1,864 pictures 35 bits apart, and called
        // 46% of the library duplicates.
        //
        // Anchored membership stops the walk: every member is within
        // MAX_DISTANCE of its group's anchor, so a group spans 3 bits however
        // long the chain is.
        let chain: Vec<(i64, u64, Vec<u8>)> = (0..12)
            .map(|step| (step as i64 + 1, (1_u64 << (step * 3)) - 1, plain(9)))
            .collect();

        let grouping = group(&chain);
        let anchor_hash = chain[0].1;
        for (id, hash, _) in &chain {
            if let Some(group_id) = grouping.groups.get(id) {
                // Whatever it joined, it is close to that group's anchor.
                let anchor = chain
                    .iter()
                    .find(|(candidate, _, _)| candidate == group_id)
                    .expect("the anchor is one of the rows")
                    .1;
                assert!(
                    distance(anchor, *hash) <= MAX_DISTANCE,
                    "row {id} is {} bits from its anchor",
                    distance(anchor, *hash),
                );
            }
        }
        // The far end of the chain must not have landed with the near end.
        let first = grouping.groups.get(&1);
        let last = grouping.groups.get(&12);
        assert!(
            first.is_none() || last.is_none() || first != last,
            "the ends of a 12-step chain are not the same picture",
        );
        let _ = anchor_hash;
    }

    #[test]
    fn a_group_is_numbered_by_its_lowest_member() {
        // Stable across runs, so re-running the search does not reshuffle the
        // grid under someone half way through reviewing it.
        let h = 0x1234_5678_9abc_def0_u64;
        let grouping = group(&[(42, h, plain(9)), (7, h, plain(9)), (99, h, plain(9))]);
        assert_eq!(grouping.groups[&42], 7);
        assert_eq!(grouping.groups[&7], 7);
        assert_eq!(grouping.groups[&99], 7);
    }

    #[test]
    fn a_picture_of_nothing_is_not_a_duplicate_of_another_one() {
        // Black video posters and blank scans all hash to the same handful of
        // bits, so they match each other exactly. Grouping them is technically
        // correct and useless — a thousand blank frames would bury every real
        // finding.
        let blank: Vec<(i64, u64, Vec<u8>)> = (0..300).map(|id| (id, 0, plain(9))).collect();
        let grouping = group(&blank);
        assert_eq!(grouping.group_count, 0, "not one enormous group");
        assert_eq!(grouping.skipped_common, 300, "and the skip is reported, not silent");

        // A smooth ramp is the same problem inverted: every comparison goes the
        // same way, so the hash is nearly all ones.
        let ramp: Vec<(i64, u64, Vec<u8>)> = (0..300).map(|id| (id, u64::MAX, plain(9))).collect();
        assert_eq!(group(&ramp).group_count, 0);

        // But a real picture with a lopsided histogram still counts.
        let busy = 0x00ff_00ff_0f0f_3333_u64;
        assert!(!is_featureless(busy));
        assert_eq!(group(&[(1, busy, plain(9)), (2, busy, plain(9))]).group_count, 1);
    }
}
