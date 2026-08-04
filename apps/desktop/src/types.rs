//! The Rust half of the wire format.
//!
//! Every struct here has a zod twin in `packages/core/src/schemas.ts` and a
//! golden fixture in `/contracts`. `contract_tests.rs` deserializes each fixture
//! into these types, re-serializes, and asserts byte-identical output — so a
//! renamed field or a changed casing fails here before it can reach the UI.
//!
//! `rename_all = "camelCase"` on everything: the frontend is the consumer, and
//! a mixed-casing wire format is the kind of thing that produces one confusing
//! `undefined` a month from now.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub label: String,
    pub score: f64,
    /// `[x, y, w, h]` as fractions of the classified image, never pixels.
    ///
    /// `box` is a Rust keyword, so the field is `box_` and serde renames it on
    /// the wire. An attribute rather than a wrapper type keeps the struct flat.
    #[serde(rename = "box")]
    pub box_: [f64; 4],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Rating {
    Unrated,
    Sfw,
    Suggestive,
    Explicit,
}

impl Rating {
    pub fn as_str(self) -> &'static str {
        match self {
            Rating::Unrated => "unrated",
            Rating::Sfw => "sfw",
            Rating::Suggestive => "suggestive",
            Rating::Explicit => "explicit",
        }
    }

    /// Inverse of [`Rating::as_str`]. Used by the shared-vector tests, which
    /// read rating names out of `contracts/classify-vectors.json`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn parse(value: &str) -> Rating {
        match value {
            "sfw" => Rating::Sfw,
            "suggestive" => Rating::Suggestive,
            "explicit" => Rating::Explicit,
            _ => Rating::Unrated,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameVerdict {
    pub person: bool,
    pub sexy: bool,
    pub nude: bool,
    pub rating: Rating,
    pub top_label: Option<String>,
    pub top_label_title: Option<String>,
    pub top_score: f64,
    pub detections: Vec<Detection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaVerdict {
    pub person: bool,
    pub sexy: bool,
    pub nude: bool,
    pub rating: Rating,
    pub top_label: Option<String>,
    pub top_label_title: Option<String>,
    pub top_score: f64,
    pub frame_count: i64,
    pub sexy_frame_count: i64,
    pub poster_frame_index: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub added_at: i64,
    pub last_scan_at: Option<i64>,
    pub available: bool,
    pub media_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: i64,
    pub folder_id: i64,
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    pub width: i64,
    pub height: i64,
    pub size_bytes: i64,
    pub modified_at: i64,
    pub added_at: i64,
    pub thumb_path: Option<String>,
    pub thumb_width: Option<i64>,
    pub thumb_height: Option<i64>,
    pub duration_sec: Option<f64>,
    pub verdict: Option<MediaVerdict>,
    pub classified_at: Option<i64>,
    /// A person's 1-5 judgement, never a model's. `None` means unrated.
    #[serde(default)]
    pub stars: Option<i64>,
    /// What the file says about how it was made, when it says anything.
    #[serde(default)]
    pub generation: Option<crate::generated::Generation>,
    /// Which set of duplicates this row belongs to, or `None` for none. Shared
    /// by every member, and numbered from the lowest — see `dupes::group`.
    #[serde(default)]
    pub dupe_group: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFrame {
    pub id: i64,
    pub media_id: i64,
    pub frame_index: i64,
    pub timestamp_sec: f64,
    pub path: String,
    pub verdict: FrameVerdict,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobPhase {
    Idle,
    Globbing,
    /// Recording each file's dimensions, before any thumbnail exists.
    ///
    /// Its own phase because it is what makes the grid stable: a tile sized
    /// from the index never moves, and until a row has dimensions it has no
    /// size to be laid out with. Header-only reads, so it finishes in a
    /// fraction of the time thumbnailing takes.
    Measuring,
    Thumbnailing,
    Classifying,
    /// Fingerprinting each image so duplicates can be found.
    Hashing,
    /// Working out what kind of picture each row is — a scan, a generated
    /// image — independent of how it was rated.
    Labelling,
    /// The anime tagger's second opinion on what NudeNet called SFW.
    ///
    /// Last, and its own phase, because it is the only optional one: the
    /// library is fully rated before it starts, so interrupting it costs
    /// accuracy on drawn content and nothing else.
    Tagging,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: JobPhase,
    pub folder_id: Option<i64>,
    pub done: i64,
    pub total: i64,
    pub current: Option<String>,
    /// Non-fatal per-item failures. One unreadable file never aborts a scan —
    /// it becomes a row here and the sweep continues.
    pub errors: Vec<String>,
}

impl ScanProgress {
    pub fn idle() -> Self {
        Self {
            phase: JobPhase::Idle,
            folder_id: None,
            done: 0,
            total: 0,
            current: None,
            errors: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub folders: i64,
    pub images: i64,
    pub videos: i64,
    pub classified: i64,
    pub pending: i64,
    pub sexy: i64,
    /// Files the pipeline gave up on, with a reason recorded on the row.
    /// Surfaced so a shrunken library is explained rather than just smaller.
    pub failed: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    Recent,
    /// When the *vault* first saw the file, not when the file was written.
    ///
    /// The two differ by years: a folder of decade-old photos added today is
    /// new to the library and ancient by `modified_at`. This is the question
    /// "what just came in", which is what the recently-added strip answered
    /// before the search field took its place.
    Added,
    Oldest,
    Name,
    Largest,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaQuery {
    /// `None` means "every watched folder in one view", which is the default.
    pub folder_id: Option<i64>,
    pub kind: Option<MediaKind>,
    pub rating: Option<Rating>,
    pub sexy_only: bool,
    pub search: String,
    /// Show only rows carrying this structural tag. `None` means "no filter".
    #[serde(default)]
    pub tag: Option<String>,
    /// Show only rows rated at least this many stars. `Some(1)` is therefore
    /// "anything I have rated at all".
    #[serde(default)]
    pub min_stars: Option<i64>,
    /// Show only files that have at least one duplicate, grouped together.
    #[serde(default)]
    pub duplicates_only: bool,
    /// Hide rows carrying any of these. Separate from `tag` rather than a
    /// signed list because the two are genuinely different questions — "show
    /// me the documents" and "never show me documents" are both wanted, and
    /// the second is the reason this exists.
    #[serde(default)]
    pub hide_tags: Vec<String>,
    pub sort: SortOrder,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<MediaItem>,
    pub total: i64,
    pub offset: i64,
}
