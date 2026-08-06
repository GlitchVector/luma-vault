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
    /// The picture this row is an upscaled variant of, by path, or `None` when
    /// it is not one — see `upscales::original_of`.
    ///
    /// A path rather than a row id because the pair is derived from the
    /// filename the moment the variant is indexed, and the original may not
    /// have been walked yet. The grid hides whatever a variant names here; the
    /// lightbox offers it as the way back.
    #[serde(default)]
    pub upscaled_from: Option<String>,
    /// The upscaled variant made *from* this row, by path, when one exists.
    ///
    /// The other direction of the same pair. Derived per query rather than
    /// stored, because it is a fact about a different row: storing it would
    /// mean writing to the original every time a variant appeared or was
    /// deleted, and getting that wrong leaves a link pointing at nothing.
    #[serde(default)]
    pub upscaled_to: Option<String>,
}

/// The picture an img2img was made from — see [`crate::origin`] for the rule
/// and the measurements behind it.
///
/// Carries the whole ancestor rather than its id because the one thing every
/// caller wants from it is the prompt, and a second round trip to fetch the row
/// that was just found would be the only reason to have the id at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceOrigin {
    /// The furthest ancestor the trail reached.
    pub item: MediaItem,
    /// How many img2img passes back it was found. Never zero.
    pub hops: u32,
    /// Whether that ancestor is where the lineage started, or merely where the
    /// trail went cold. Stating the first when it means the second is a lie the
    /// UI must not tell — 28% of img2img rows reach a real root, 40% do not.
    pub reached_root: bool,
    /// The widest hop in the chain. Confidence is set by the worst step.
    pub weakest_hop: u32,
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
    /// Show only rows nobody has starred yet — the triage queue.
    ///
    /// A separate field rather than `min_stars: Some(0)`, which under an
    /// *at least* comparison means "everything" and would quietly do nothing.
    #[serde(default)]
    pub unstarred: bool,
    /// Only rows with (true) or without (false) a recovered prompt. Not the
    /// `generated` tag's axis: a marker can survive a re-encode that the
    /// parameter block did not.
    #[serde(default)]
    pub has_prompt: Option<bool>,
    /// Only rows made from another image (true) or not (false) — the block's
    /// own `needsSourceImage` claim.
    #[serde(default)]
    pub img2img: Option<bool>,
    /// Only rows from (true) or not from (false) the Extras tab.
    #[serde(default)]
    pub extras: Option<bool>,
    /// Only rows the detector found this label on, at or above
    /// [`crate::db::LABEL_MIN_SCORE`].
    ///
    /// Every label found, not the one the verdict happens to name: `topLabel`
    /// is picked by rating weight, so six labels — `FACE_FEMALE` among them,
    /// on 85,000 rows — can never appear there at all.
    #[serde(default)]
    pub label: Option<String>,
    /// Only animated images (true), or only still ones (false).
    ///
    /// By extension, which is what [`crate::types::MediaKind`] cannot express:
    /// a GIF and a PNG are both `image`. A static WebP is caught by `true` and
    /// excluded by `false` — the container allows animation and the name is all
    /// there is to go on without decoding every file.
    #[serde(default)]
    pub animated: Option<bool>,
    /// Only black-and-white rows (true), or only colour ones (false).
    #[serde(default)]
    pub greyscale: Option<bool>,
    /// Show only rows whose longest edge is at least this many pixels.
    ///
    /// A number rather than a `four_k_only` flag, because the rule is a number
    /// and it is defined once — in `FOUR_K_EDGE` in the TypeScript core, which
    /// the grid's badge also reads. Sending the threshold rather than a name
    /// keeps the badge and the filter from ever disagreeing about what 4K is.
    #[serde(default)]
    pub min_longest_edge: Option<i64>,
    /// Show only files that have at least one duplicate, grouped together.
    #[serde(default)]
    pub duplicates_only: bool,
    /// Hide rows carrying any of these. Separate from `tag` rather than a
    /// signed list because the two are genuinely different questions — "show
    /// me the documents" and "never show me documents" are both wanted, and
    /// the second is the reason this exists.
    #[serde(default)]
    pub hide_tags: Vec<String>,
    /// Show only rows modified inside `[modified_after, modified_before)`,
    /// unix ms. Half-open, so adjacent week selections share a boundary
    /// without double-counting the file sitting exactly on it.
    #[serde(default)]
    pub modified_after: Option<i64>,
    #[serde(default)]
    pub modified_before: Option<i64>,
    pub sort: SortOrder,
    pub limit: i64,
    pub offset: i64,
}

/// One week of the library, for the timeline's bars. `start` is the Monday
/// 00:00 UTC of the week, unix ms. Empty weeks are not sent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBucket {
    pub start: i64,
    pub count: i64,
}

/// One row of the character leaderboard: a danbooru-form name and how many
/// pictures the grid holds of them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPage {
    pub items: Vec<MediaItem>,
    pub total: i64,
    pub offset: i64,
}

// ---------------------------------------------------------------------------
// DeviantArt
// ---------------------------------------------------------------------------

/// One submission, as a person approved it.
///
/// Deserialized rather than derived. `packages/core/src/publish.ts` works out
/// what a row *should* say and the panel lets someone change it; this side
/// uploads what it is handed and decides nothing, which is why the mapping has
/// no second copy here to drift out of sync with the first.
///
/// `media_id` rather than a path: the webview never names a file for the
/// backend to read, the same rule the upscaler follows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviantArtDraft {
    pub media_id: i64,
    pub title: String,
    /// `artist_comments` on the wire.
    pub description: String,
    pub tags: Vec<String>,
    pub is_mature: bool,
    /// `moderate` or `strict`. `None` exactly when `is_mature` is false — the
    /// API rejects a level without the flag and the flag without a level.
    pub mature_level: Option<String>,
    pub mature_classification: Vec<String>,
    pub is_ai_generated: bool,
    pub noai: bool,
}

/// Which account is connected, and what it is actually allowed to do.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviantArtAccount {
    /// A client id has been entered. Without one there is nothing to connect.
    pub configured: bool,
    /// A refresh token is held. Says nothing about whether it still works —
    /// DeviantArt expires them after three months.
    pub connected: bool,
    pub username: Option<String>,
    pub client_id: Option<String>,
    /// Shown in the settings panel, because it has to be pasted into the app's
    /// whitelist on DeviantArt *exactly* or the callback never arrives.
    pub redirect_uri: String,
    /// What the last authorization actually granted, which is not necessarily
    /// what was asked for.
    pub scopes: Vec<String>,
    /// Whether `publish` came back among them. A freshly registered app may not
    /// get it, and finding that out at connect time is far better than finding
    /// out on the first upload.
    pub can_publish: bool,
}

/// What became of one picture.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviantArtResult {
    pub media_id: i64,
    pub title: String,
    /// The Sta.sh item, once staged. Publishing needs it.
    pub item_id: Option<i64>,
    /// The public deviation, once published.
    pub url: Option<String>,
    pub deviation_id: Option<String>,
    pub published: bool,
    pub error: Option<String>,
}

/// What a batch did. Per-item failures are rows here, never an early return.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviantArtSummary {
    pub staged: i64,
    pub published: i64,
    pub failed: i64,
    pub results: Vec<DeviantArtResult>,
}

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

/// Which library this window is showing, and how to get back to the last one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub connected: bool,
    /// `192.168.1.42:7870`, or empty when this is the machine's own library.
    pub address: String,
    /// The peer's hostname, so the badge can name a machine rather than a
    /// number. Empty when it did not report one.
    pub host: String,
    /// What the peer holds, for the line under the address.
    pub folders: i64,
    pub items: i64,
    /// Prefilled next time, so reconnecting is one click rather than a memory
    /// test. Remembered after disconnecting, which is when it is needed.
    pub last_address: String,
    /// Whether a passphrase is remembered for that address. Never the
    /// passphrase itself — it lives in the OS credential store.
    pub has_passphrase: bool,
}

/// Whether this machine answers for others, and on what address.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub sharing: bool,
    pub port: u16,
    /// What to type on the other machine. Usually one entry; empty when the
    /// routing table could not be asked, in which case the panel says so
    /// instead of showing a wrong number.
    pub addresses: Vec<String>,
    /// A passphrase is set, so sharing can be switched on without typing one
    /// again. Never the passphrase itself.
    pub has_passphrase: bool,
}
