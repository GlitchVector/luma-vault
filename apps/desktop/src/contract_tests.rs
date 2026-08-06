//! The Rust half of the contract suite.
//!
//! Two kinds of check live here:
//!
//! 1. **Round trips** — every fixture in `/contracts` is deserialized into its
//!    serde struct, re-serialized, and compared as `serde_json::Value` against
//!    the original. A renamed field, an added field, a changed casing or a
//!    wrong nullability fails. The zod twin of this runs in
//!    `packages/core/src/contracts.test.ts`.
//!
//! 2. **Shared logic vectors** — `classify-vectors.json` drives both this file
//!    and `packages/core/src/classify.test.ts`, because the rating rules exist
//!    in both languages and would otherwise drift.

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::rating::{rate_frame, roll_up_video, ClassifyOptions};
use crate::sampling::{plan_frame_timestamps, SamplingOptions};
use crate::types::{Detection, FrameVerdict, Rating};

fn round_trip<T: DeserializeOwned + Serialize>(fixture: &str) {
    let value: Value = serde_json::from_str(fixture).expect("fixture is not valid JSON");
    let typed: T = serde_json::from_value(value.clone()).expect("fixture does not match the struct");
    let reserialized = serde_json::to_value(&typed).expect("struct does not serialize");
    assert_eq!(
        reserialized, value,
        "the struct and the fixture disagree — update both, or the frontend breaks"
    );
}

#[test]
fn media_item_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::MediaItem>>(include_str!("../../../contracts/media-item.json"));
}

#[test]
fn folder_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::Folder>>(include_str!("../../../contracts/folder.json"));
}

#[test]
fn scan_progress_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::ScanProgress>>(include_str!(
        "../../../contracts/scan-progress.json"
    ));
}

#[test]
fn media_frame_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::MediaFrame>>(include_str!("../../../contracts/media-frame.json"));
}

#[test]
fn library_stats_matches_the_shared_fixture() {
    round_trip::<crate::types::LibraryStats>(include_str!("../../../contracts/library-stats.json"));
}

#[test]
fn media_query_matches_the_shared_fixture() {
    round_trip::<crate::types::MediaQuery>(include_str!("../../../contracts/media-query.json"));
}

#[test]
fn character_count_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::CharacterCount>>(include_str!(
        "../../../contracts/character-count.json"
    ));
}

#[test]
fn timeline_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::TimelineBucket>>(include_str!(
        "../../../contracts/timeline.json"
    ));
}

#[test]
fn deviantart_draft_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::DeviantArtDraft>>(include_str!(
        "../../../contracts/deviantart-draft.json"
    ));
}

#[test]
fn deviantart_account_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::DeviantArtAccount>>(include_str!(
        "../../../contracts/deviantart-account.json"
    ));
}

#[test]
fn deviantart_summary_matches_the_shared_fixture() {
    round_trip::<crate::types::DeviantArtSummary>(include_str!(
        "../../../contracts/deviantart-summary.json"
    ));
}

#[test]
fn remote_status_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::RemoteStatus>>(include_str!(
        "../../../contracts/remote-status.json"
    ));
}

#[test]
fn share_status_matches_the_shared_fixture() {
    round_trip::<Vec<crate::types::ShareStatus>>(include_str!(
        "../../../contracts/share-status.json"
    ));
}

// ---------------------------------------------------------------------------
// Shared logic vectors
// ---------------------------------------------------------------------------

const VECTORS: &str = include_str!("../../../contracts/classify-vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("classify-vectors.json is not valid JSON")
}

#[test]
fn frame_vectors_agree_with_the_typescript_core() {
    let root = vectors();
    let cases = root["frameVectors"].as_array().expect("frameVectors is an array");
    assert!(!cases.is_empty(), "the vector file must not be empty");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let detections: Vec<Detection> =
            serde_json::from_value(case["detections"].clone()).expect("detections");
        let verdict = rate_frame(&detections, ClassifyOptions::default());
        let expect = &case["expect"];

        assert_eq!(verdict.person, expect["person"], "person mismatch in: {name}");
        assert_eq!(verdict.sexy, expect["sexy"], "sexy mismatch in: {name}");
        assert_eq!(verdict.nude, expect["nude"], "nude mismatch in: {name}");
        assert_eq!(
            verdict.rating.as_str(),
            expect["rating"].as_str().unwrap(),
            "rating mismatch in: {name}"
        );
        match expect["topLabel"].as_str() {
            Some(label) => assert_eq!(
                verdict.top_label.as_deref(),
                Some(label),
                "topLabel mismatch in: {name}"
            ),
            None => assert!(
                verdict.top_label.is_none(),
                "expected no topLabel in: {name}"
            ),
        }
    }
}

#[test]
fn video_vectors_agree_with_the_typescript_core() {
    let root = vectors();
    let cases = root["videoVectors"].as_array().expect("videoVectors is an array");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let frames: Vec<FrameVerdict> = case["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .map(|rating| stub_frame(rating.as_str().expect("rating string")))
            .collect();

        let verdict = roll_up_video(&frames);
        let expect = &case["expect"];

        assert_eq!(
            verdict.rating.as_str(),
            expect["rating"].as_str().unwrap(),
            "rating mismatch in: {name}"
        );
        assert_eq!(verdict.sexy, expect["sexy"], "sexy mismatch in: {name}");
        assert_eq!(
            verdict.sexy_frame_count,
            expect["sexyFrameCount"].as_i64().unwrap(),
            "sexyFrameCount mismatch in: {name}"
        );
        assert_eq!(
            verdict.poster_frame_index,
            expect["posterFrameIndex"].as_i64(),
            "posterFrameIndex mismatch in: {name}"
        );
    }
}

/// A frame verdict with only the fields the rollup reads, built from a rating
/// name. The TypeScript test builds the same stub from the same strings.
fn stub_frame(rating: &str) -> FrameVerdict {
    let rating = Rating::parse(rating);
    let sexy = matches!(rating, Rating::Suggestive | Rating::Explicit);
    FrameVerdict {
        person: true,
        sexy,
        nude: matches!(rating, Rating::Explicit),
        rating,
        top_label: sexy.then(|| "BUTTOCKS_EXPOSED".to_string()),
        top_label_title: sexy.then(|| "exposed buttocks".to_string()),
        top_score: if sexy { 0.7 } else { 0.0 },
        detections: Vec::new(),
    }
}

#[test]
fn sampling_vectors_agree_with_the_typescript_core() {
    let root = vectors();
    let cases = root["samplingVectors"].as_array().expect("samplingVectors");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let duration = case["durationSec"].as_f64().expect("durationSec");
        let stamps = plan_frame_timestamps(duration, SamplingOptions::default());

        assert_eq!(
            stamps.len(),
            case["expectCount"].as_u64().unwrap() as usize,
            "frame count mismatch in: {name}"
        );

        if let Some(first) = case["expectFirst"].as_f64() {
            assert!(
                (stamps[0] - first).abs() < 1e-9,
                "first timestamp mismatch in: {name} (got {})",
                stamps[0]
            );
        }

        for stamp in &stamps {
            assert!(
                *stamp >= 0.0 && *stamp < duration,
                "timestamp {stamp} out of range in: {name}"
            );
        }

        if case["expectEvenlySpaced"].as_bool() == Some(true) {
            let gaps: Vec<f64> = stamps.windows(2).map(|pair| pair[1] - pair[0]).collect();
            let first = gaps[0];
            for gap in &gaps {
                assert!(
                    (gap - first).abs() < 1e-6,
                    "gaps are not even in: {name} (expected {first}, saw {gap})"
                );
            }
        }
    }
}
