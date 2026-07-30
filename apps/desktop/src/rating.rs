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
            suggestive_min_score: 0.5,
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
        | "FEMALE_BREAST_EXPOSED" => LabelWeight::Explicit,

        "BUTTOCKS_EXPOSED"
        | "BELLY_EXPOSED"
        | "ARMPITS_EXPOSED"
        | "MALE_BREAST_EXPOSED"
        | "FEMALE_GENITALIA_COVERED"
        | "FEMALE_BREAST_COVERED"
        | "BUTTOCKS_COVERED"
        | "ANUS_COVERED" => LabelWeight::Suggestive,

        // Faces, feet, covered belly/armpits — and anything a future model
        // revision adds that we do not know yet. Degrading an unknown label to
        // neutral means a model upgrade under-reports rather than crashing.
        _ => LabelWeight::Neutral,
    }
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

        let rated = match weight {
            LabelWeight::Explicit => detection.score >= options.explicit_min_score,
            LabelWeight::Suggestive => detection.score >= options.suggestive_min_score,
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
