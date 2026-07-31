//! Turning raw detections into verdicts.
//!
//! # This logic exists twice, on purpose
//!
//! The scan pipeline runs in Rust, so the rules have to live here. The UI also
//! needs them — to re-derive a verdict when you move a threshold slider without
//! re-running a scan — so they also live in `packages/core/src/classify.ts`.
//!
//! Mirrored logic drifts. The mitigation is that **both implementations are
//! pinned by the same cases**, in `contracts/classify-vectors.json`. Changing a
//! rule means editing that file and watching two test suites fail together. Do
//! not "fix" one side alone.

use crate::types::{Detection, FrameVerdict, MediaVerdict, Rating};

/// Bumped whenever the rules below change what a given set of detections rates.
///
/// The detections are stored per frame, so a rule change does not need the
/// model run again — only the rollup recomputed. The app compares this against
/// the value recorded in the index and re-rates from stored detections when
/// they differ, which turns an hour of re-inference into a few seconds of
/// arithmetic. Forgetting to bump it means a library keeps its old verdicts and
/// silently disagrees with the code that produced them.
///
/// 2: `suggestive_min_score` lowered from 0.5 to 0.4.
/// 3: genitalia, anus, buttocks and exposed breasts rate on presence alone.
/// 4: the anime tagger's rating labels are weighted.
pub const RATING_VERSION: i64 = 4;

/// Thresholds applied on top of the detector's own NMS (which already drops
/// anything below score 0.25).
#[derive(Debug, Clone, Copy)]
pub struct ClassifyOptions {
    pub suggestive_min_score: f64,
    pub explicit_min_score: f64,
    pub person_min_score: f64,
}

impl Default for ClassifyOptions {
    fn default() -> Self {
        Self {
            // 0.4, not 0.5, for the *suggestive* band only.
            //
            // Measured against a real 66,000-file library at 640px inference:
            // 20,978 sexy-weighted detections landed in the 0.25-0.50 band and
            // were discarded whole. One file the user flagged carried
            // `FEMALE_GENITALIA_COVERED` at 0.495 and rated SFW — missed by
            // five thousandths.
            //
            // `..._COVERED` labels are inherently less confident than exposed
            // anatomy: the detector is inferring a shape under fabric. Holding
            // them to the same bar as an unambiguous exposure is what produced
            // the miss. Explicit stays at 0.5, where a false positive is the
            // more expensive mistake.
            suggestive_min_score: 0.4,
            explicit_min_score: 0.5,
            person_min_score: 0.35,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LabelWeight {
    Explicit,
    Suggestive,
    Neutral,
}

/// Keyed by the label string, matching `packages/core/src/labels.ts`.
///
/// A previous generation of this code remapped labels onto a second numeric id
/// space and looked them up with `map[label] || -1`, which silently turned id 0
/// into -1 because 0 is falsy in JavaScript. Strings have no falsy member.
pub fn weight_of(label: &str) -> LabelWeight {
    match label {
        "FEMALE_GENITALIA_EXPOSED"
        | "MALE_GENITALIA_EXPOSED"
        | "ANUS_EXPOSED"
        | "FEMALE_BREAST_EXPOSED"
        // Danbooru's own rating, from the anime tagger. Whole-image rather
        // than anatomical, which is why it is not presence-rated: it is a
        // judgement about a picture, and a judgement deserves a threshold.
        | "ANIME_EXPLICIT" => LabelWeight::Explicit,

        "BUTTOCKS_EXPOSED"
        | "BELLY_EXPOSED"
        | "ARMPITS_EXPOSED"
        | "MALE_BREAST_EXPOSED"
        | "FEMALE_GENITALIA_COVERED"
        | "FEMALE_BREAST_COVERED"
        | "BUTTOCKS_COVERED"
        | "ANUS_COVERED"
        | "ANIME_QUESTIONABLE" => LabelWeight::Suggestive,

        // Faces, feet, covered belly/armpits — and anything a future model
        // revision adds that we do not know yet. Degrading an unknown label to
        // neutral means a model upgrade under-reports rather than crashing.
        _ => LabelWeight::Neutral,
    }
}

/// Labels whose *presence* rates, whatever the score.
///
/// Unambiguous sexual anatomy. The detector reporting genitalia, an anus, or
/// buttocks at all is the finding; how confident it is about the box is a
/// separate question, and one that a threshold answers badly. Measured on a
/// real library, 4,222 such detections sat below their threshold and were
/// discarded — including a file whose only detection was `BUTTOCKS_COVERED` at
/// 0.26, which is exactly the case this exists for.
///
/// Not a licence to include everything. `FEMALE_BREAST_COVERED` is excluded on
/// purpose: every clothed woman produces one, so presence-rating it would flag
/// a further 1,463 files largely on the basis of someone wearing a shirt.
/// `MALE_BREAST_EXPOSED` is excluded for the same reason — a shirtless man at a
/// beach is not the finding this app is for. Both still rate normally once they
/// clear their threshold.
///
/// "Whatever the score" means down to 0.25 in practice: the detector's own NMS
/// drops anything below that before we ever see it.
pub fn rates_on_presence(label: &str) -> bool {
    label.contains("GENITALIA") || label.contains("ANUS") || label.contains("BUTTOCKS")
        || label == "FEMALE_BREAST_EXPOSED"
}

pub fn title_of(label: &str) -> String {
    let title = match label {
        "FEMALE_GENITALIA_COVERED" => "covered vagina",
        "FEMALE_GENITALIA_EXPOSED" => "exposed vagina",
        "MALE_GENITALIA_EXPOSED" => "exposed penis",
        "ANUS_COVERED" => "covered anus",
        "ANUS_EXPOSED" => "exposed anus",
        "FEMALE_BREAST_COVERED" => "covered breast",
        "FEMALE_BREAST_EXPOSED" => "exposed breast",
        "MALE_BREAST_EXPOSED" => "exposed chest",
        "BUTTOCKS_COVERED" => "covered buttocks",
        "BUTTOCKS_EXPOSED" => "exposed buttocks",
        "BELLY_COVERED" => "covered belly",
        "BELLY_EXPOSED" => "exposed belly",
        "ARMPITS_COVERED" => "covered armpits",
        "ARMPITS_EXPOSED" => "exposed armpits",
        "FEET_COVERED" => "covered feet",
        "FEET_EXPOSED" => "exposed feet",
        "FACE_FEMALE" => "female face",
        "FACE_MALE" => "male face",
        "ANIME_QUESTIONABLE" => "drawn, suggestive",
        "ANIME_EXPLICIT" => "drawn, explicit",
        other => return other.to_lowercase().replace('_', " "),
    };
    title.to_string()
}

/// Collapse one frame's detections into a verdict.
///
/// Order-independent: every detection folds into a max, and the stored
/// detection list is sorted by a total order. Without that sort, re-classifying
/// an unchanged file would produce a different JSON blob every time (NMS output
/// order is not stable) and every row would look dirty.
pub fn rate_frame(detections: &[Detection], options: ClassifyOptions) -> FrameVerdict {
    let mut person = false;
    let mut sexy = false;
    let mut nude = false;
    let mut top_label: Option<String> = None;
    let mut top_score = 0.0_f64;

    for detection in detections {
        let weight = weight_of(&detection.label);

        if detection.score >= options.person_min_score {
            person = true;
        }

        let presence = rates_on_presence(&detection.label);
        let rated = match weight {
            LabelWeight::Explicit => presence || detection.score >= options.explicit_min_score,
            LabelWeight::Suggestive => presence || detection.score >= options.suggestive_min_score,
            // Neutral labels never rate, presence or not: a face is a face.
            LabelWeight::Neutral => false,
        };
        if !rated {
            continue;
        }

        sexy = true;
        if weight == LabelWeight::Explicit {
            nude = true;
        }

        if detection.score > top_score {
            top_score = detection.score;
            top_label = Some(detection.label.clone());
        }
    }

    let rating = if nude {
        Rating::Explicit
    } else if sexy {
        Rating::Suggestive
    } else {
        Rating::Sfw
    };

    FrameVerdict {
        person,
        sexy,
        nude,
        rating,
        top_label_title: top_label.as_deref().map(title_of),
        top_label,
        top_score,
        detections: sort_detections(detections),
    }
}

/// Highest score first, then label, then box position. A total order, so the
/// serialized blob is reproducible.
fn sort_detections(detections: &[Detection]) -> Vec<Detection> {
    let mut sorted = detections.to_vec();
    sorted.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| {
                a.box_[0]
                    .partial_cmp(&b.box_[0])
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                a.box_[1]
                    .partial_cmp(&b.box_[1])
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    sorted
}

/// Roll a video's sampled frames up into one verdict.
///
/// **If any sampled frame is sexy, the whole video is sexy.** A max, not a
/// vote: one explicit frame in an hour still makes the video explicit, because
/// the flag answers "can this be on screen", not "how much of it".
///
/// The poster follows the same rule — the *first* sexy frame if there is one,
/// so the tile shows what earned the flag; otherwise the middle frame, so an
/// SFW video gets a representative tile rather than a black opening frame.
pub fn roll_up_video(frames: &[FrameVerdict]) -> MediaVerdict {
    if frames.is_empty() {
        return MediaVerdict {
            person: false,
            sexy: false,
            nude: false,
            rating: Rating::Unrated,
            top_label: None,
            top_label_title: None,
            top_score: 0.0,
            frame_count: 0,
            sexy_frame_count: 0,
            poster_frame_index: None,
        };
    }

    let mut person = false;
    let mut sexy = false;
    let mut nude = false;
    let mut rating = Rating::Sfw;
    let mut top_label: Option<String> = None;
    let mut top_score = 0.0_f64;
    let mut sexy_frame_count = 0_i64;
    let mut first_sexy_index: Option<i64> = None;

    for (index, frame) in frames.iter().enumerate() {
        person |= frame.person;
        sexy |= frame.sexy;
        nude |= frame.nude;
        if frame.rating > rating {
            rating = frame.rating;
        }

        if frame.sexy {
            sexy_frame_count += 1;
            if first_sexy_index.is_none() {
                first_sexy_index = Some(index as i64);
            }
        }

        if frame.top_label.is_some() && frame.top_score > top_score {
            top_score = frame.top_score;
            top_label = frame.top_label.clone();
        }
    }

    let poster_frame_index = first_sexy_index.unwrap_or((frames.len() / 2) as i64);

    MediaVerdict {
        person,
        sexy,
        nude,
        rating,
        top_label_title: top_label.as_deref().map(title_of),
        top_label,
        top_score,
        frame_count: frames.len() as i64,
        sexy_frame_count,
        poster_frame_index: Some(poster_frame_index),
    }
}

/// Promote a single image's frame verdict to a media verdict.
pub fn from_single_frame(frame: &FrameVerdict) -> MediaVerdict {
    MediaVerdict {
        person: frame.person,
        sexy: frame.sexy,
        nude: frame.nude,
        rating: frame.rating,
        top_label: frame.top_label.clone(),
        top_label_title: frame.top_label_title.clone(),
        top_score: frame.top_score,
        frame_count: 1,
        sexy_frame_count: if frame.sexy { 1 } else { 0 },
        poster_frame_index: Some(0),
    }
}
