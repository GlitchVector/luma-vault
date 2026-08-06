//! Finding the picture an img2img was made from.
//!
//! # The problem this solves
//!
//! An img2img keeps its subject in the **init image**, and no parameter block
//! carries that image — see [`crate::generated::Generation::needs_source_image`].
//! So a block whose entire prompt is twelve words about a face can belong to a
//! picture of a named character in a black dress with gold trim, and reading the
//! prompt tells you nothing about the dress. The words are not missing; they
//! were never typed, because the dress arrived in the init image.
//!
//! In a library assembled by generating from your own output, that init image is
//! usually **still here**. It cannot be named — nothing records it — but it can
//! be *recognised*: an img2img at a normal denoising strength keeps the
//! composition it started from, which is exactly what a perceptual hash
//! measures.
//!
//! # Why this is not the duplicate finder
//!
//! [`crate::dupes`] answers "is this the same picture", at 3 bits. This answers
//! "was this made from that picture", which is a different and looser question:
//! the whole point of an img2img pass is that the result is *not* the same
//! picture. Measured on this library, an img2img sits a median of **5 bits**
//! from its nearest older neighbour where an ordinary image sits at **12**.
//!
//! Matches at 3 bits or under are therefore excluded rather than included: that
//! is a re-save, a re-encode or an upscale — the same picture under another
//! name, which `dupes` already pairs and which is not what anything was
//! generated *from*.
//!
//! # The thresholds, measured
//!
//! txt2img rows are the negative control: they have no init image, so any link
//! proposed for one is wrong by construction. Sampling 250 of each and sweeping
//! both thresholds against a 155,000-row library:
//!
//! | rule | img2img linked | control linked |
//! |---|---|---|
//! | 6 bits, colour 8 | 50% | 2% |
//! | **8 bits, colour 16** | **65%** | **4%** |
//! | 10 bits, colour 16 | 68% | 5% |
//! | 12 bits, colour 25 | 70% | 10% |
//!
//! Eight bits and a colour distance of 16 is the knee. Going wider buys three
//! points of recall and doubles the false rate; going tighter costs fourteen
//! points and saves two. As in `dupes`, the hash proposes and the colour
//! signature disposes — the colour check is doing real work here, not
//! decoration: among candidates the hash alone accepted, genuine links scored a
//! median colour distance of 8.2 against 42.6 for the control's.
//!
//! # Why the walk, rather than one hop
//!
//! Nine times in ten the picture an img2img was made from is **itself an
//! img2img**, so stopping at the first hop usually lands on another prompt that
//! does not describe the picture either. Walking back until a row that is not an
//! img2img — a txt2img generation, or a photograph — reaches the prompt someone
//! actually typed about this composition. One real chain runs six hops from a
//! prompt reading `very detailed human left hand` (an inpaint repairing a hand)
//! to a root naming the character, her hair, her eyes and her dress.
//!
//! Every hop is strictly older than the one before it, so a walk cannot cycle
//! and needs no visited set. [`MAX_HOPS`] is a backstop against a pathological
//! chain, not a tuning knob: the median walk is two hops.

use crate::dupes::{colour_distance, MAX_DISTANCE as SAME_PICTURE};

/// How many bits may differ before one picture cannot have been made from the
/// other. See the module note for the measurement behind it.
pub const MAX_HASH_DISTANCE: u32 = 8;

/// How far apart two colour signatures may be and still be one lineage.
///
/// Twice [`crate::dupes::MAX_COLOUR_DISTANCE`], because a denoising pass is
/// allowed to change the palette in a way a re-encode is not — it repaints the
/// picture — while a link across a genuinely different scene still scores in the
/// forties.
pub const MAX_COLOUR_DISTANCE: f64 = 16.0;

/// A backstop against a pathological chain, not a tuning knob. Median 2.
pub const MAX_HOPS: u32 = 12;

/// One row as the walk sees it.
///
/// Deliberately without the colour signature: 155,000 of them is 30MB of blob
/// to answer a question about a handful of rows, and this runs every time a
/// picture is opened. The signature is fetched per candidate instead, for the
/// few that clear the hash test.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: i64,
    pub phash: u64,
    pub modified_at: i64,
    /// The row's own `needsSourceImage` claim. A row that is not an img2img
    /// ends the walk — it is where the lineage started.
    pub img2img: bool,
}

/// Where a picture came from, as far back as the trail can be followed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    /// The furthest ancestor reached.
    pub id: i64,
    /// How many img2img passes back it was found. Never zero: no link at all is
    /// reported as `None` rather than as an origin that is the picture itself.
    pub hops: u32,
    /// Whether that ancestor is where the lineage actually started, or merely
    /// where the trail went cold.
    ///
    /// The distinction is the difference between "this is the picture it all
    /// came from" and "this is as far back as I can see", and a UI that states
    /// the first when it means the second is lying. Measured on this library:
    /// 28% of img2img rows walk to a real root, 40% go cold part-way, 33% have
    /// no link at all.
    pub reached_root: bool,
    /// The widest hash distance of any hop in the chain — its weakest link.
    ///
    /// Confidence is set by the worst step, not the first: a chain of six tight
    /// hops and one loose one is only as trustworthy as the loose one.
    pub weakest_hop: u32,
}

fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// The most likely picture `from` was made from.
///
/// Among candidates that clear both thresholds the closest by hash wins, and
/// ties go to the **newest**: an img2img chain generates forward in time, so
/// when two ancestors are equally alike the later one is the more likely parent
/// and the earlier one is probably its own grandparent.
fn source_of(
    rows: &[Candidate],
    from: &Candidate,
    from_colour: &[u8],
    colour_of: &mut dyn FnMut(i64) -> Option<Vec<u8>>,
) -> Option<(usize, u32)> {
    let mut best: Option<(usize, u32)> = None;
    for (index, row) in rows.iter().enumerate() {
        // Strictly older. This is what makes the walk acyclic, and it is also
        // the claim being made: a picture cannot be made from one that did not
        // exist yet.
        if row.modified_at >= from.modified_at || row.id == from.id {
            continue;
        }
        let d = distance(row.phash, from.phash);
        if d <= SAME_PICTURE || d > MAX_HASH_DISTANCE {
            continue;
        }
        match best {
            Some((_, best_d)) if d > best_d => continue,
            Some((best_index, best_d)) if d == best_d && row.modified_at <= rows[best_index].modified_at => {
                continue
            }
            _ => {}
        }
        // Last, because it costs a query and 192 bytes where the hash costs an
        // xor. Only rows that already look right get asked about their colour.
        let Some(colour) = colour_of(row.id) else {
            continue;
        };
        if colour_distance(from_colour, &colour) > MAX_COLOUR_DISTANCE {
            continue;
        }
        best = Some((index, d));
    }
    best
}

/// Walk back from `start` to the furthest ancestor the trail reaches.
///
/// `colour_of` is asked only about rows that already clear the hash test, so a
/// caller may make it a database round trip.
pub fn walk(
    rows: &[Candidate],
    start: i64,
    colour_of: &mut dyn FnMut(i64) -> Option<Vec<u8>>,
) -> Option<Origin> {
    let mut at = rows.iter().find(|row| row.id == start)?.clone();
    let mut hops = 0;
    let mut weakest_hop = 0;

    while hops < MAX_HOPS {
        // A row whose thumbnail never produced a signature ends the walk. It
        // must not discard the hops already made: `break`, not `return None`.
        let Some(colour) = colour_of(at.id) else {
            break;
        };
        let Some((index, d)) = source_of(rows, &at, &colour, &mut *colour_of) else {
            break;
        };
        at = rows[index].clone();
        hops += 1;
        weakest_hop = weakest_hop.max(d);
        // A row that was not made from another image is where this started.
        if !at.img2img {
            return Some(Origin {
                id: at.id,
                hops,
                reached_root: true,
                weakest_hop,
            });
        }
    }

    // The trail went cold, or ran out of hops, on a row that is itself an
    // img2img. Reporting it anyway is the difference between answering 68% of
    // the time and 28%: an ancestor four passes back whose prompt names the
    // character is worth having even when it is not the first one.
    (hops > 0).then_some(Origin {
        id: at.id,
        hops,
        reached_root: false,
        weakest_hop,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hash with the mixture of set and clear bits a real picture produces.
    const BASE: u64 = 0x00ff_00ff_0f0f_3333;

    /// `count` bits flipped from `from_bit` up.
    ///
    /// Chains are built by flipping *disjoint* regions, so the distance between
    /// two rows is exactly the number of bits the two flips cover between them —
    /// which is what lets these tests state a hop width and mean it.
    fn flip(base: u64, from_bit: u32, count: u32) -> u64 {
        let mut hash = base;
        for bit in 0..count {
            hash ^= 1 << (from_bit + bit);
        }
        hash
    }

    fn row(id: i64, phash: u64, modified_at: i64, img2img: bool) -> Candidate {
        Candidate {
            id,
            phash,
            modified_at,
            img2img,
        }
    }

    /// Every row the same colour, for the tests that are about the hash.
    fn flat() -> impl FnMut(i64) -> Option<Vec<u8>> {
        |_| Some(vec![9; 192])
    }

    #[test]
    fn walks_a_chain_back_to_the_txt2img_that_started_it() {
        // An inpaint made from an img2img made from a txt2img — the real shape.
        // Five bits per hop puts the root ten bits from the top and so out of
        // reach in one step: the walk has to actually walk.
        let root = BASE;
        let mid = flip(BASE, 0, 5);
        let top = flip(mid, 20, 5);
        let rows = vec![
            row(1, root, 1_000, false),
            row(2, mid, 2_000, true),
            row(3, top, 3_000, true),
        ];

        let origin = walk(&rows, 3, &mut flat()).expect("a chain to walk");
        assert_eq!(origin.id, 1, "the root, not the row one hop back");
        assert_eq!(origin.hops, 2);
        assert!(origin.reached_root);
    }

    #[test]
    fn says_so_when_the_trail_goes_cold_on_an_img2img() {
        // 40% of real cases. The ancestor is still worth reporting — its prompt
        // may well name the character — but calling it the root would be a lie.
        let rows = vec![
            row(1, flip(BASE, 0, 5), 1_000, true),
            row(2, BASE, 2_000, true),
        ];
        let origin = walk(&rows, 2, &mut flat()).expect("one hop is still a link");
        assert_eq!(origin.id, 1);
        assert_eq!(origin.hops, 1);
        assert!(!origin.reached_root, "an img2img is not where a lineage starts");
    }

    #[test]
    fn a_picture_with_no_ancestor_has_no_origin() {
        let rows = vec![row(1, BASE, 1_000, false), row(2, !BASE, 2_000, true)];
        assert_eq!(walk(&rows, 2, &mut flat()), None);
    }

    #[test]
    fn the_same_picture_re_saved_is_not_what_it_was_made_from() {
        // Exactly on the dupe threshold: an upscale or a re-encode. `dupes`
        // pairs these already, and calling one the *source* of the other would
        // put a picture's own duplicate in front of the person as its origin.
        let rows = vec![
            row(1, BASE, 1_000, false),
            row(2, flip(BASE, 0, 3), 2_000, true),
        ];
        assert_eq!(walk(&rows, 2, &mut flat()), None);
    }

    #[test]
    fn a_picture_cannot_be_made_from_a_later_one() {
        // Also what makes the walk acyclic — there is no visited set because
        // time already is one.
        let rows = vec![
            row(1, flip(BASE, 0, 5), 5_000, false),
            row(2, BASE, 2_000, true),
        ];
        assert_eq!(walk(&rows, 2, &mut flat()), None);
    }

    #[test]
    fn colour_overrules_a_hash_that_likes_the_shape() {
        // The dupes lesson at this threshold: greyscale structure alone put a
        // blue-lit bar together with an amber-lit stage. A repaint may move the
        // palette; a different scene is not a repaint.
        let rows = vec![
            row(1, flip(BASE, 0, 5), 1_000, false),
            row(2, BASE, 2_000, true),
        ];
        let mut colours = |id: i64| Some(if id == 1 { vec![200; 192] } else { vec![10; 192] });
        assert_eq!(walk(&rows, 2, &mut colours), None);
    }

    #[test]
    fn reports_the_weakest_link_rather_than_the_hop_it_ended_on() {
        // Seven bits back to the middle, four from there to the root. The chain
        // is worth what the seven-bit hop is worth.
        let mid = flip(BASE, 0, 4);
        let rows = vec![
            row(1, BASE, 1_000, false),
            row(2, mid, 2_000, true),
            row(3, flip(mid, 20, 7), 3_000, true),
        ];
        let origin = walk(&rows, 3, &mut flat()).expect("a chain to walk");
        assert_eq!(origin.hops, 2);
        assert_eq!(origin.weakest_hop, 7, "the loose hop, not the tight one");
    }

    #[test]
    fn a_tie_goes_to_the_newer_ancestor() {
        // Two equally close candidates: the later one is the likelier parent,
        // and the earlier one probably its parent in turn.
        let tie = flip(BASE, 0, 5);
        let rows = vec![
            row(1, tie, 1_000, false),
            row(2, tie, 2_000, false),
            row(3, BASE, 3_000, true),
        ];
        let origin = walk(&rows, 3, &mut flat()).expect("a link");
        assert_eq!(origin.id, 2, "the later of two equally close ancestors");
    }

    #[test]
    fn a_long_chain_stops_at_the_hop_limit() {
        // Without a bound this is unbounded work on a library that generates
        // from its own output all day. Each row flips a different four-bit
        // region, so neighbours are eight bits apart — inside the threshold,
        // and never inside the dupe one.
        let rows: Vec<Candidate> = (0..40_i64)
            .map(|step| {
                row(
                    step + 1,
                    flip(BASE, (step as u32 % 15) * 4, 4),
                    (step + 1) * 1_000,
                    true,
                )
            })
            .collect();
        let origin = walk(&rows, 40, &mut flat()).expect("a chain");
        assert_eq!(origin.hops, MAX_HOPS);
        assert!(!origin.reached_root);
    }
}
