//! Recognising images that say they were generated, and reading what they say.
//!
//! Every mainstream generator writes its settings into the file: Automatic1111
//! and Forge put the whole parameter block in a PNG `tEXt` chunk keyed
//! `parameters`, ComfyUI embeds its node graph, NovelAI writes a `Comment`
//! JSON. All of it sits ahead of the pixel data.
//!
//! So this is a header read — no decode, no model, and no dependency beyond
//! `serde_json`, which means it keeps working on a machine with no Python.
//!
//! # What it is and is not
//!
//! **Precision is essentially total.** A file containing a ComfyUI node graph
//! or an `A1111` parameter block was generated; nothing else writes those.
//!
//! **Recall is bounded by what survives.** Re-encoding strips metadata, so a
//! screenshot or a re-saved JPEG of a generated image looks exactly like a
//! photograph here. Measured over 1,200 random files from a real library: 25%
//! of PNGs carried a marker against 0.3% of JPEGs. Measured over the untouched
//! output folders of two Stable Diffusion installs, 89% still carried theirs.
//!
//! That JPEG figure was taken while EXIF `UserComment` went unread, and it
//! understates them: re-measured over 400 library JPEGs this parser called
//! ungenerated, 1.5% carried a full parameter block in UTF-16 that nothing was
//! decoding — about 950 files in a 158,000-row library.
//! This finds images that *declare* themselves, which is a different and much
//! smaller set than "images that were generated". A hint, never proof of
//! absence.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// How much of the file to examine.
///
/// Generators write metadata immediately after the signature, but a ComfyUI
/// workflow graph is itself tens of kilobytes and an EXIF block can carry a
/// thumbnail ahead of the comment. 96KB clears both without ever reading a
/// multi-megabyte image body.
const HEAD_BYTES: usize = 96 * 1024;

/// Bumped when this module learns to read something it could not read before.
///
/// A scan deliberately leaves existing rows alone, so a parser that gets better
/// improves nothing already indexed until something re-reads those files. The
/// startup pass compares this against what the index was last built with and
/// re-reads the containers the change could affect — see `reparse_phase`.
///
/// 2: EXIF `UserComment` in UTF-16, which every JPEG Forge writes uses.
pub const PARSER_VERSION: i64 = 2;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// What a file says about how it was made.
///
/// Every field is optional and every field is a string, including the numeric
/// ones. These are *claims copied out of a file*, not values this app computed:
/// `Steps: 28` and `Steps: 28.0` and a truncated `Steps: 2` are all things that
/// appear on disk, and parsing them into integers here would mean choosing
/// between discarding a row and inventing a number for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation {
    /// The tool that wrote the metadata — "Stable Diffusion", "ComfyUI", …
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cfg_scale: Option<String>,
    /// This picture was made *from another picture*, so its parameters alone
    /// cannot reproduce it.
    ///
    /// An img2img or inpaint result is a function of a source image plus a
    /// denoising strength, and no parameter block carries the source image —
    /// not ours, and not the one Forge's own PNG Info tab reads. Handing these
    /// parameters to txt2img gives a *different picture with the same
    /// description*, which is worse than an error because it looks like it
    /// worked.
    ///
    /// Always serialized, unlike the optional fields above. A boolean that is
    /// sometimes absent reads as "unknown" at the far end, and the honest
    /// meaning of absence here is `false`.
    #[serde(default)]
    pub needs_source_image: bool,
    /// Ran through the Extras tab — an upscale of an existing image, not a
    /// generation. The block gives it away: `Postprocess upscale by: 2,
    /// Postprocess upscaler: ...` and nothing else, no steps and no seed —
    /// which is also why these images seem to have a strange "prompt": with
    /// no settings line to anchor on, the postprocess line is all there is.
    #[serde(default)]
    pub postprocessed: bool,
    /// The characters this prompt names, as {@link characters_of} found them.
    ///
    /// Carried rather than re-derived at the far end. The detection is a
    /// dictionary of thousands of names plus a set of rules about emphasis,
    /// weights and escaped parentheses, and a second copy of it in TypeScript
    /// would be a second copy of a *rule* — the thing this codebase pins to
    /// shared vectors precisely because two copies drift. Sending the answer
    /// keeps one.
    ///
    /// Always serialized, so the far end can tell "no characters in this
    /// prompt" from "this came from a build that did not look".
    #[serde(default)]
    pub characters: Vec<String>,
}

/// Was this made from another image?
///
/// Decided from the parameters rather than the folder, because
/// `outputs\img2img-images\` is a configurable convention while the block is
/// the file describing itself.
///
/// `Denoising strength` appears in exactly two situations: an img2img pass, and
/// a txt2img pass with hires fix. The hires case always names its upscaler too,
/// so denoising *without* any `Hires` key means the strength applied to a
/// source image that is not here.
fn needs_source_image(text: &str) -> bool {
    let denoising = text.contains("Denoising strength");
    let hires = text.contains("Hires upscale")
        || text.contains("Hires upscaler")
        || text.contains("Hires steps");
    denoising && !hires
}

/// Markers and the tool that writes them, most specific first.
///
/// Used only when every structured read finds nothing: a last resort that
/// records *that* a file was generated when its parameters cannot be recovered.
///
/// Every needle here is ASCII, and that is a limit rather than an oversight to
/// be fixed in place. EXIF text is routinely UTF-16, where each of these
/// characters is interleaved with a NUL and none of them can ever match —
/// which is why `exif_user_comment` decodes the comment properly first, and
/// this runs on whatever is left.
const MARKERS: &[(&[u8], &str)] = &[
    (b"NovelAI", "NovelAI"),
    (b"invokeai_metadata", "InvokeAI"),
    (b"sd-metadata", "InvokeAI"),
    (b"Negative prompt:", "Stable Diffusion"),
    (b"Steps: ", "Stable Diffusion"),
    (b"class_type", "ComfyUI"),
    (b"ComfyUI", "ComfyUI"),
    (b"Stable Diffusion", "Stable Diffusion"),
    (b"trainedAlgorithmicMedia", "Content credentials"),
    (b"Midjourney", "Midjourney"),
];

/// What this file says about its own generation, or `None` if it says nothing.
///
/// Never an error: a file that cannot be read is simply not known to be
/// generated, which is the same answer as a file that was photographed. This
/// runs over every row in a library, and one unreadable file must not become a
/// scan error.
pub fn read_generation(path: &Path) -> Option<Generation> {
    let head = read_head(path)?;
    parse(&head)
}

/// Fill in what the prompt implies, for every parser at once.
///
/// Applied once, where `parse` returns — not inside `parse_a1111`,
/// `parse_comfy` and `parse_novelai`, which is three chances to forget and a
/// fourth waiting for whatever format arrives next. It was written that way
/// first and the PNG `parameters` branch was already missing it, which is the
/// whole argument in one bug.
fn derived(mut generation: Generation) -> Generation {
    if let Some(prompt) = generation.prompt.as_deref() {
        generation.characters = characters_of(prompt);
    }
    generation
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let mut head = vec![0_u8; HEAD_BYTES];
    let mut file = File::open(path).ok()?;
    let mut filled = 0;
    // `read` is permitted to return short; loop until the buffer is full or the
    // file ends, or a large PNG over SMB can report far less than it holds.
    loop {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                if filled == head.len() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    head.truncate(filled);
    Some(head)
}

fn parse(head: &[u8]) -> Option<Generation> {
    parse_raw(head).map(derived)
}

fn parse_raw(head: &[u8]) -> Option<Generation> {
    for (keyword, text) in png_text_chunks(head) {
        match keyword.as_str() {
            // A1111 / Forge: the entire UI's parameter block, verbatim.
            "parameters" => return Some(parse_a1111(&text)),
            // ComfyUI: the executed node graph.
            "prompt" | "workflow" => {
                if let Some(found) = parse_comfy(&text) {
                    return Some(found);
                }
            }
            "Comment" => {
                if let Some(found) = parse_novelai(&text) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }

    // No usable chunk. A JPEG has none to walk and carries the block in EXIF
    // `UserComment` instead — structured, with a declared length and a declared
    // encoding, so it is read before the plain-text sweep below rather than
    // after it.
    let comment = exif_user_comment(head);
    if let Some(text) = comment.as_deref() {
        if text.contains("Negative prompt:") || text.contains("Steps: ") {
            return Some(parse_a1111(text));
        }
    }

    // A block sitting in the head as plain text: an EXIF payload some other
    // tool wrote as ASCII, or a sidecar's contents embedded verbatim.
    if let Some(start) = find(head, b"Negative prompt:").or_else(|| find(head, b"Steps: ")) {
        let from = head[..start].iter().rposition(|b| *b == 0).map_or(0, |i| i + 1);
        if let Ok(text) = std::str::from_utf8(&head[from..]) {
            return Some(parse_a1111(text));
        }
    }

    // The comment first: a marker inside it is the file describing itself,
    // where one loose in the head could be any byte sequence that happens to
    // match. Same needles either way, so this only changes which is believed.
    comment
        .as_deref()
        .and_then(|text| find_marker(text.as_bytes()))
        .or_else(|| find_marker(head))
        .map(|tool| Generation { tool: tool.to_string(), ..Default::default() })
}

/// Walk a PNG's `tEXt`/`iTXt` chunks.
///
/// A real chunk walk rather than a substring hunt for `parameters\0`: the
/// chunk header carries the length, which is the only thing that says where
/// the value *ends*. Searching for the next NUL instead would truncate every
/// prompt at its first non-ASCII byte.
///
/// Compressed `zTXt`/`iTXt` are skipped rather than inflated — no generator in
/// the wild writes its parameters compressed, and carrying a zlib dependency
/// for a case that does not occur is not worth it.
fn png_text_chunks(head: &[u8]) -> Vec<(String, String)> {
    let mut found = Vec::new();
    if !head.starts_with(PNG_SIGNATURE) {
        return found;
    }

    let mut at = PNG_SIGNATURE.len();
    while at + 8 <= head.len() {
        let length = u32::from_be_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]])
            as usize;
        let kind = &head[at + 4..at + 8];
        let data_at = at + 8;
        // A truncated head is the normal case for a big workflow chunk, not an
        // error: take what is there and stop.
        let end = data_at.saturating_add(length).min(head.len());
        if kind == b"IDAT" || kind == b"IEND" {
            break; // pixel data has started; no text chunk follows that matters
        }

        if kind == b"tEXt" || kind == b"iTXt" {
            let data = &head[data_at..end];
            if let Some(split) = data.iter().position(|b| *b == 0) {
                let keyword = String::from_utf8_lossy(&data[..split]).into_owned();
                let mut value = &data[split + 1..];
                if kind == b"iTXt" {
                    // compression flag, compression method, language, translated
                    // keyword — then the text. Skip the two flag bytes and the
                    // two NUL-terminated fields.
                    if value.len() >= 2 {
                        let compressed = value[0] != 0;
                        value = &value[2..];
                        for _ in 0..2 {
                            match value.iter().position(|b| *b == 0) {
                                Some(i) => value = &value[i + 1..],
                                None => {
                                    value = &[];
                                    break;
                                }
                            }
                        }
                        if compressed {
                            value = &[];
                        }
                    }
                }
                if !value.is_empty() {
                    found.push((keyword, String::from_utf8_lossy(value).into_owned()));
                }
            }
        }

        // length + type + data + CRC
        match at.checked_add(12).and_then(|base| base.checked_add(length)) {
            Some(next) if next > at => at = next,
            _ => break,
        }
    }
    found
}

/// The Exif sub-IFD pointer, and `UserComment` inside it. Spec tag numbers.
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_USER_COMMENT: u16 = 0x9286;

/// Read a file's EXIF `UserComment`, decoded from whatever it says it is.
///
/// This is where a JPEG keeps what a PNG keeps in `parameters`, so it is the
/// same job as `png_text_chunks` in a different container — and a real IFD walk
/// for the same reason: the entry carries the value's length, and that length
/// is the only thing that says where the comment ends. `Exif\0\0` locates the
/// block exactly as the PNG signature locates the chunk stream; every offset
/// after it is read rather than guessed.
///
/// **The encoding is the whole point.** A `UserComment` opens with eight bytes
/// naming its character set, and Forge writes `UNICODE` — UTF-16, in the byte
/// order the TIFF header declares. Hunting those bytes for `Negative prompt:`
/// as ASCII cannot ever match, because every character carries a NUL beside it.
/// That is not a hypothetical: it is why a JPEG holding a complete parameter
/// block used to index as not generated at all, and why 4-megapixel renders
/// (Forge saves a JPEG copy of anything over its threshold) arrived with no
/// prompt while their PNG twins were read perfectly.
fn exif_user_comment(head: &[u8]) -> Option<String> {
    let at = find(head, b"Exif\x00\x00")?;
    let tiff = head.get(at.checked_add(6)?..)?;
    // The TIFF header opens by naming its own byte order, and everything below
    // — including the comment's text — is read in it.
    let big = match tiff.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };

    let ifd0 = u32_at(tiff, 4, big)? as usize;
    let (_, pointer_at) = ifd_entry(tiff, ifd0, TAG_EXIF_IFD, big)?;
    let exif_ifd = u32_at(tiff, pointer_at, big)? as usize;
    let (count, value_at) = ifd_entry(tiff, exif_ifd, TAG_USER_COMMENT, big)?;

    let count = count as usize;
    // Four bytes or fewer sit in the entry itself; anything longer — which
    // every parameter block is — is an offset from the TIFF header. A head that
    // stops mid-comment is the normal case for a long prompt rather than an
    // error, so take what is there, exactly as the chunk walk does.
    let body = if count <= 4 {
        tiff.get(value_at..value_at.checked_add(count)?)?
    } else {
        let from = u32_at(tiff, value_at, big)? as usize;
        let to = from.saturating_add(count).min(tiff.len());
        tiff.get(from..to)?
    };

    let (code, text) = body.split_at(body.len().min(8));
    match code {
        b"UNICODE\0" => {
            let units: Vec<u16> = text
                .chunks_exact(2)
                .map(|pair| {
                    let pair = [pair[0], pair[1]];
                    if big { u16::from_be_bytes(pair) } else { u16::from_le_bytes(pair) }
                })
                // A comment padded out to its declared length ends at the first
                // NUL; without this the prompt picks up a tail of them.
                .take_while(|unit| *unit != 0)
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        // The plain-text sweep would find this one anyway. Reading it here
        // bounds it by the declared length instead of running to the end of the
        // head and failing UTF-8 on the pixel data behind it.
        b"ASCII\0\0\0" => Some(String::from_utf8_lossy(text).trim_end_matches('\0').to_string()),
        _ => None,
    }
}

/// The value length and the offset of the value field for `tag` in one IFD.
///
/// An IFD is a 2-byte entry count followed by 12-byte entries: tag, type,
/// count, then four bytes that are either the value or an offset to it.
fn ifd_entry(tiff: &[u8], ifd: usize, tag: u16, big: bool) -> Option<(u32, usize)> {
    let entries = u16_at(tiff, ifd, big)? as usize;
    for index in 0..entries {
        let entry = ifd.checked_add(2)?.checked_add(index.checked_mul(12)?)?;
        if u16_at(tiff, entry, big)? == tag {
            return Some((u32_at(tiff, entry.checked_add(4)?, big)?, entry.checked_add(8)?));
        }
    }
    None
}

fn u16_at(bytes: &[u8], at: usize, big: bool) -> Option<u16> {
    let pair: [u8; 2] = bytes.get(at..at.checked_add(2)?)?.try_into().ok()?;
    Some(if big { u16::from_be_bytes(pair) } else { u16::from_le_bytes(pair) })
}

fn u32_at(bytes: &[u8], at: usize, big: bool) -> Option<u32> {
    let quad: [u8; 4] = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
    Some(if big { u32::from_be_bytes(quad) } else { u32::from_le_bytes(quad) })
}

/// Parse the Automatic1111 / Forge parameter block.
///
/// ```text
/// a girl on a beach, masterpiece
/// Negative prompt: bad hands, blurry
/// Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Model: someMix
/// ```
///
/// The prompt is everything before `Negative prompt:`, which is itself
/// everything before the settings line. The settings line is comma-separated
/// `Key: value` — but a value may itself contain commas (`Sampler: DPM++ 2M,
/// Karras`), so splitting on commas and trusting every field is wrong. Only
/// fields that look like `Key: value` start a new field; anything else is
/// glued back onto the previous one.
fn parse_a1111(text: &str) -> Generation {
    let mut generation = Generation {
        tool: "Stable Diffusion".to_string(),
        needs_source_image: needs_source_image(text),
        postprocessed: text.contains("Postprocess upscale") || text.contains("Postprocess upscaler"),
        ..Default::default()
    };

    let (prompt_part, rest) = match text.find("Negative prompt:") {
        Some(at) => (&text[..at], &text[at + "Negative prompt:".len()..]),
        None => (text, ""),
    };

    // The settings line is the last line that parses as settings.
    let (negative, settings) = match rest.rfind('\n') {
        Some(at) => (&rest[..at], &rest[at + 1..]),
        None if prompt_part.is_empty() => ("", rest),
        None => (rest, ""),
    };

    let settings = if settings.contains(": ") { settings } else { "" };
    // When there was no negative prompt the settings line is the tail of the
    // prompt block, so the prompt must not swallow it.
    let prompt = if settings.is_empty() || !prompt_part.is_empty() {
        prompt_part
    } else {
        ""
    };

    let prompt = prompt.trim();
    let mut positive = if prompt.is_empty() { None } else { Some(prompt.to_string()) };
    if positive.is_none() && negative.is_empty() && !text.is_empty() {
        // A file with only a settings line still names its model and seed.
        positive = None;
    }
    generation.prompt = positive;
    let negative = negative.trim();
    if !negative.is_empty() {
        generation.negative_prompt = Some(negative.to_string());
    }

    for (key, value) in settings_fields(settings) {
        match key.as_str() {
            "Model" => generation.model = Some(value),
            "Seed" => generation.seed = Some(value),
            "Sampler" => generation.sampler = Some(value),
            "Steps" => generation.steps = Some(value),
            "CFG scale" => generation.cfg_scale = Some(value),
            _ => {}
        }
    }
    generation
}

/// Split `Key: value, Key: value`, respecting quoted values.
///
/// **The quotes are the whole difficulty.** A real block contains
///
/// ```text
/// Model: waiNSFWIllustrious_v110, ControlNet 0: "Module: None, Model: None, …"
/// ```
///
/// and a naive split on `", "` walks straight into that quoted value, finds
/// `Model: None` and overwrites the real model with ControlNet's. That is not a
/// hypothetical: it is what this did, and every ControlNet-using image in the
/// library reported its model as `None`.
///
/// So quoted regions are skipped whole. Outside them, a field still only starts
/// on something that looks like a key — a short plain label — so a stray `": "`
/// in prose is glued back onto the value it came from.
/// The checkpoint a parameter block names, if it names one.
///
/// Shares the quote-aware splitter with the parser proper rather than matching
/// `Model:` with a regex. A settings line contains `Model hash` before `Model`
/// and `ADetailer model` after it, and ControlNet writes quoted values holding
/// commas — all of which a looser reader gets wrong on real files.
pub fn checkpoint_of(block: &str) -> Option<String> {
    let settings = block.trim_end().lines().next_back()?;
    settings_fields(settings)
        .into_iter()
        .find(|(key, _)| key == "Model")
        .map(|(_, value)| value)
        .filter(|value| !value.is_empty())
}

fn settings_fields(line: &str) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut pieces: Vec<&str> = Vec::new();

    let bytes = line.as_bytes();
    let (mut start, mut quoted) = (0, false);
    for at in 0..bytes.len() {
        if bytes[at] == b'"' {
            quoted = !quoted;
        } else if !quoted && bytes[at] == b',' && bytes.get(at + 1) == Some(&b' ') {
            pieces.push(&line[start..at]);
            start = at + 2;
        }
    }
    if start < line.len() {
        pieces.push(&line[start..]);
    }

    for piece in pieces {
        match piece.split_once(": ") {
            Some((key, value))
                if !key.is_empty()
                    && key.len() <= 24
                    && key.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') =>
            {
                // First wins. `Model` appears once as the checkpoint and again
                // inside each ControlNet unit; the checkpoint comes first.
                let key = key.trim().to_string();
                if !fields.iter().any(|(existing, _)| *existing == key) {
                    fields.push((key, value.trim().trim_matches('"').to_string()));
                }
            }
            _ => {
                if let Some(last) = fields.last_mut() {
                    last.1.push_str(", ");
                    last.1.push_str(piece.trim());
                }
            }
        }
    }
    fields
}

/// The parameter block exactly as the file records it, if it has one.
///
/// Read on demand rather than stored: a block with ControlNet and two ADetailer
/// passes runs to 2,656 bytes, and keeping that for 65,000 images would add
/// ~170MB to an index that is meant to be a cache. The file is right there.
///
/// This is what "Open in Forge" sends. Handing over the *parsed* fields loses
/// everything the parser does not model — schedule type, clip skip, denoising
/// strength, ControlNet units, every ADetailer setting — and the regenerated
/// image comes out different. Forge's own parser understands all of it; the
/// only thing it needs is the original text.
pub fn read_parameter_block(path: &Path) -> Option<String> {
    let head = read_head(path)?;
    for (keyword, text) in png_text_chunks(&head) {
        if keyword == "parameters" {
            return Some(text);
        }
    }
    // A JPEG carries the same text inside EXIF rather than a PNG chunk.
    let start = find(&head, b"Negative prompt:").or_else(|| find(&head, b"Steps: "))?;
    let from = head[..start].iter().rposition(|b| *b == 0).map_or(0, |i| i + 1);
    let text = std::str::from_utf8(&head[from..]).ok()?;
    Some(text.trim_end_matches('\0').to_string())
}

/// Pull what is human-readable out of a ComfyUI node graph.
///
/// The graph is the truth of how the image was made, but it is a wiring
/// diagram, not a description. The positive prompt is whatever text feeds a
/// `CLIPTextEncode`; with two of them the longer one is the positive, because
/// negative prompts in practice are short boilerplate.
fn parse_comfy(text: &str) -> Option<Generation> {
    let graph: serde_json::Value = serde_json::from_str(text).ok()?;
    let nodes = graph.as_object()?;

    let mut prompts: Vec<String> = Vec::new();
    let mut model = None;
    let mut seed = None;
    let mut steps = None;
    let mut cfg = None;
    let mut sampler = None;

    for node in nodes.values() {
        let class = node.get("class_type").and_then(|v| v.as_str()).unwrap_or("");
        let inputs = node.get("inputs");
        let string_input = |name: &str| {
            inputs
                .and_then(|i| i.get(name))
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
        };

        match class {
            "CLIPTextEncode" => {
                if let Some(text) = string_input("text") {
                    if !text.trim().is_empty() {
                        prompts.push(text);
                    }
                }
            }
            "CheckpointLoaderSimple" | "CheckpointLoader" => {
                model = model.or_else(|| string_input("ckpt_name"));
            }
            "KSampler" | "KSamplerAdvanced" => {
                seed = seed.or_else(|| string_input("seed").or_else(|| string_input("noise_seed")));
                steps = steps.or_else(|| string_input("steps"));
                cfg = cfg.or_else(|| string_input("cfg"));
                sampler = sampler.or_else(|| string_input("sampler_name"));
            }
            _ => {}
        }
    }

    prompts.sort_by_key(|p| std::cmp::Reverse(p.len()));
    Some(Generation {
        tool: "ComfyUI".to_string(),
        // A ComfyUI graph can load an image, but saying so needs the graph
        // walked rather than a string searched. Claiming "reproducible" would
        // be a guess; this only marks what it can prove.
        needs_source_image: false,
        postprocessed: false,
        negative_prompt: prompts.get(1).cloned(),
        prompt: prompts.first().cloned(),
        model,
        seed,
        sampler,
        steps,
        cfg_scale: cfg,
        characters: Vec::new(),
    })
}

fn parse_novelai(text: &str) -> Option<Generation> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let get = |key: &str| {
        value.get(key).and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
    };
    Some(Generation {
        tool: "NovelAI".to_string(),
        needs_source_image: false,
        postprocessed: false,
        prompt: get("prompt"),
        // NovelAI calls the negative prompt "uc", for undesired content.
        negative_prompt: get("uc"),
        model: None,
        seed: get("seed"),
        sampler: get("sampler"),
        steps: get("steps"),
        cfg_scale: get("scale"),
        characters: Vec::new(),
    })
}

fn find_marker(head: &[u8]) -> Option<&'static str> {
    MARKERS
        .iter()
        .find(|(needle, _)| find(head, needle).is_some())
        .map(|(_, name)| *name)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Build a PNG head carrying one `tEXt` chunk. Test-only.
#[cfg(test)]
fn png_with_text(keyword: &str, value: &str) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(keyword.as_bytes());
    data.push(0);
    data.extend_from_slice(value.as_bytes());

    let mut out = Vec::new();
    out.extend_from_slice(PNG_SIGNATURE);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(b"tEXt");
    out.extend_from_slice(&data);
    out.extend_from_slice(&[0, 0, 0, 0]); // CRC, never checked
    out
}

/// Whether a path runs through an Extras output folder.
///
/// The era this exists for wrote NO postprocess metadata at all — worse, old
/// A1111 copied the ORIGINAL image's whole parameter block into the upscale,
/// so by its own metadata an extras file claims to be its source. Measured on
/// a real library: 1,130 extras files, zero with a `Postprocess` key. The
/// folder is the only signal that survives, exactly as remembered.
pub fn extras_path(path: &str) -> bool {
    path.split(['\\', '/']).any(|part| {
        let part = part.to_ascii_lowercase();
        part == "extras" || part == "extras-images"
    })
}

/// Qualifiers whose parenthesised form is not a character.
///
/// Danbooru's `name (qualifier)` convention is nearly always a character tag
/// in a prompt — `aqua (konosuba)` — but the same shape also spells copyright
/// tags (`fate (series)`), cosplay-of tags and a few style words, and counting
/// those as people would put "fate (series)" on the leaderboard.
const NOT_A_CHARACTER: &[&str] = &[
    "series", "cosplay", "style", "game", "company", "band", "meme", "artist",
    "franchise", "medium",
    // Scene and camera vocabulary that prompts parenthesise the same way a
    // character is — `earth (planet)`, `tokyo (city)`, `seductive smile
    // (looking at viewer)` — and which a real library promptly put on the
    // leaderboard between Misty and Asuna. A series is a *work*; these are
    // what the qualifier says when the fragment describes the picture instead
    // of naming somebody in it.
    "planet", "sky", "city", "space", "moon", "sun", "location", "place",
    "background", "scenery", "landscape", "weather", "pose", "gesture",
    "expression", "emotion", "viewer", "looking", "behind", "close-up",
    "object", "animal", "food", "weapon", "color", "colour",
    // Anatomy and clothing: `cross-laced (footwear)` and `cinema shot
    // (lactating breasts)` wear the character shape too. Checked word by
    // word, so any qualifier containing one of these is out -- a series
    // name does not contain "breasts".
    "footwear", "clothing", "clothes", "breasts", "breast", "ass", "butt",
    "hips", "thighs", "hair", "skin", "body", "chest", "legs", "feet",
    "large", "small", "huge",
];

/// A qualifier is rejected when *any* of its words is blocked -- full-phrase
/// matching turned into whack-a-mole the moment real prompts arrived.
/// Danbooru's character tags with 300+ posts, normalised like detection is —
/// lowercase, underscores as spaces. ~6,700 names, 125KB, built from the tag
/// list the A1111 tag-autocomplete project publishes (category 4 = character).
///
/// This is what makes *bare* names detectable at all: `murasaki shion` has no
/// `(series)` qualifier on danbooru — VTuber names mostly do not — and without
/// a dictionary it is shape-identical to `silver hair`. Exact membership is
/// the whole test; there is no fuzzy matching to be wrong with.
static CHARACTER_NAMES: std::sync::OnceLock<std::collections::HashSet<&'static str>> =
    std::sync::OnceLock::new();

fn known_character(name: &str) -> bool {
    CHARACTER_NAMES
        .get_or_init(|| {
            include_str!("../assets/characters.txt")
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect()
        })
        .contains(name)
}

/// Lowercase, underscores to spaces, runs of whitespace collapsed — the one
/// spelling both detection paths and the dictionary agree on.
fn normalise(value: &str) -> String {
    value.replace('_', " ").to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A name is words, not syntax: LoRA leftovers and weights carry characters
/// no name does.
fn wordy(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '\'' | '.' | '-' | '_' | '!'))
}

fn blocked_qualifier(qualifier: &str) -> bool {
    qualifier.split_whitespace().any(|word| NOT_A_CHARACTER.contains(&word))
        || NOT_A_CHARACTER.contains(&qualifier)
}

/// The characters a prompt names, in danbooru's `name (series)` form.
///
/// Deliberately only that form. A bare `tsukishiro yanagi` is indistinguishable
/// from an ordinary tag pair without a dictionary the size of danbooru itself —
/// `silver hair` has the same shape — and a wrong guess here becomes a wrong
/// leaderboard entry that looks like data. The parenthesised convention is the
/// unambiguous one, and prompts written for booru models use it precisely
/// because the models were trained on it.
///
/// Normalised to lowercase with collapsed spaces, so `Aqua (Konosuba)` and
/// `aqua  (konosuba)` count as one character.
pub fn characters_of(prompt: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for raw in prompt.split([',', '\n']) {
        // Strip emphasis wrappers and weights: `(aqua \(konosuba\):1.2)` is
        // the same tag wearing syntax. Escaped parens are the prompt-level
        // spelling of literal ones; park them on sentinel bytes so *only the
        // outer emphasis layers* are peeled — the character form's own parens
        // are interior and must survive, which is exactly what a blanket
        // bracket-strip got wrong the first time.
        let parked = raw.replace("\\(", "\u{1}").replace("\\)", "\u{2}");
        let mut cleaned = parked.trim().to_string();
        loop {
            let trimmed = cleaned.trim();
            // A trailing `:1.2` first, so `(tag:1.2)` peels in two steps —
            // keeping the close-paren the weight was wearing.
            if let Some((head, tail)) = trimmed.rsplit_once(':') {
                let tail = tail.trim();
                if tail.trim_end_matches(')').parse::<f64>().is_ok() {
                    cleaned =
                        if tail.ends_with(')') { format!("{head})") } else { head.to_string() };
                    continue;
                }
            }
            if (trimmed.starts_with('(') && trimmed.ends_with(')'))
                || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                || (trimmed.starts_with('{') && trimmed.ends_with('}'))
            {
                cleaned = trimmed[1..trimmed.len() - 1].to_string();
                continue;
            }
            break;
        }
        let restored = cleaned.replace('\u{1}', "(").replace('\u{2}', ")");
        let cleaned = restored.trim();

        let Some((name, rest)) = cleaned.split_once('(') else {
            // No qualifier. Only the dictionary can tell `murasaki shion`
            // from `silver hair` here — exact membership, no guessing.
            if !cleaned.is_empty() && cleaned.len() <= 50 && wordy(cleaned) {
                let bare = normalise(cleaned);
                if known_character(&bare) && !found.contains(&bare) {
                    found.push(bare);
                }
            }
            continue;
        };
        let Some((qualifier, tail)) = rest.split_once(')') else { continue };
        // Anything after the close-paren means this was not a lone tag.
        if !tail.trim().is_empty() {
            continue;
        }
        let name = name.trim();
        let qualifier = qualifier.trim();
        if name.is_empty() || qualifier.is_empty() || name.len() > 40 || qualifier.len() > 40 {
            continue;
        }
        if !wordy(name) || !wordy(qualifier) {
            continue;
        }
        if blocked_qualifier(&qualifier.to_lowercase().replace('_', " ")) {
            continue;
        }

        // Underscores are danbooru's own spelling of spaces — `d.va_(overwatch)`
        // and `blue_archive` are the underscore forms of the same tags.
        let canonical = format!("{} ({})", normalise(name), normalise(qualifier));
        if !found.contains(&canonical) {
            found.push(canonical);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG head carrying one EXIF `UserComment`, in the byte order asked
    /// for. Hand-built because the offsets are the thing under test: every one
    /// below is relative to the TIFF header, which is what a reader that
    /// guessed instead of walking would get wrong.
    fn exif_jpeg(comment: &str, big: bool) -> Vec<u8> {
        let mut payload = b"UNICODE\0".to_vec();
        for unit in comment.encode_utf16() {
            payload.extend_from_slice(&if big { unit.to_be_bytes() } else { unit.to_le_bytes() });
        }
        exif_jpeg_payload(payload, big)
    }

    /// The same head around an already-built `UserComment` value, so a test can
    /// choose the character code as well as the text.
    fn exif_jpeg_payload(payload: Vec<u8>, big: bool) -> Vec<u8> {
        let u16b = |value: u16| if big { value.to_be_bytes() } else { value.to_le_bytes() };
        let u32b = |value: u32| if big { value.to_be_bytes() } else { value.to_le_bytes() };

        let mut tiff = Vec::new();
        tiff.extend_from_slice(if big { b"MM" } else { b"II" });
        tiff.extend_from_slice(&u16b(42));
        tiff.extend_from_slice(&u32b(8)); // IFD0 starts here

        tiff.extend_from_slice(&u16b(1)); // IFD0: one entry
        tiff.extend_from_slice(&u16b(TAG_EXIF_IFD));
        tiff.extend_from_slice(&u16b(4)); // LONG
        tiff.extend_from_slice(&u32b(1));
        tiff.extend_from_slice(&u32b(26)); // the Exif sub-IFD
        tiff.extend_from_slice(&u32b(0)); // no IFD1

        tiff.extend_from_slice(&u16b(1)); // sub-IFD: one entry
        tiff.extend_from_slice(&u16b(TAG_USER_COMMENT));
        tiff.extend_from_slice(&u16b(7)); // UNDEFINED
        tiff.extend_from_slice(&u32b(payload.len() as u32));
        tiff.extend_from_slice(&u32b(44)); // where the payload sits
        tiff.extend_from_slice(&u32b(0));
        assert_eq!(tiff.len(), 44, "the entry above promises the payload starts here");
        tiff.extend_from_slice(&payload);

        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\x00\x00");
        jpeg.extend_from_slice(&tiff);
        // Pixel data behind the metadata. Deliberately not valid UTF-8: the
        // plain-text fallback runs to the end of the head, and this is what it
        // chokes on when it is asked to carry a JPEG.
        jpeg.extend_from_slice(&[0xff, 0xda, 0x9c, 0x00, 0xfe, 0x80, 0x7f]);
        jpeg
    }

    const BLOCK: &str = concat!(
        "1girl, solo, purple hair, gigantic ass\n",
        "Negative prompt: worst quality, bad hands\n",
        "Steps: 28, Sampler: Euler a, CFG scale: 5, Seed: 12345, Model: waiNSFWIllustrious_v110",
    );

    #[test]
    fn reads_a_forge_parameter_block_out_of_utf16_exif() {
        // The regression this module was fixed for: Forge saves a JPEG copy of
        // any render over its size threshold, and every one of them indexed as
        // not generated at all while its PNG twin read perfectly.
        let found = parse(&exif_jpeg(BLOCK, true)).expect("a JPEG that says this much is generated");
        assert_eq!(found.tool, "Stable Diffusion");
        assert_eq!(found.prompt.as_deref(), Some("1girl, solo, purple hair, gigantic ass"));
        assert_eq!(found.negative_prompt.as_deref(), Some("worst quality, bad hands"));
        assert_eq!(found.steps.as_deref(), Some("28"));
        assert_eq!(found.model.as_deref(), Some("waiNSFWIllustrious_v110"));
    }

    #[test]
    fn honours_the_byte_order_the_tiff_header_declares() {
        // Reading UTF-16 in the wrong order does not fail, it returns CJK
        // mojibake — so a reader that assumed one order would quietly store a
        // prompt of nonsense rather than nothing at all.
        assert_eq!(parse(&exif_jpeg(BLOCK, true)), parse(&exif_jpeg(BLOCK, false)));
        assert_eq!(
            parse(&exif_jpeg(BLOCK, false)).and_then(|g| g.prompt).as_deref(),
            Some("1girl, solo, purple hair, gigantic ass")
        );
    }

    #[test]
    fn stops_where_the_comment_does_rather_than_at_its_declared_length() {
        // A `UserComment` is routinely padded out to a fixed size. Without the
        // NUL guard the padding lands on the end of the settings line, and the
        // field that suffers is whichever is last — here, the checkpoint.
        let found = parse(&exif_jpeg(&format!("{BLOCK}\0\0\0\0"), true)).expect("generated");
        assert_eq!(found.model.as_deref(), Some("waiNSFWIllustrious_v110"));
    }

    #[test]
    fn an_ascii_user_comment_is_read_by_its_declared_length() {
        // The other character code in the wild. It would also be found by the
        // plain-text sweep, but only this path bounds it by the length instead
        // of running into the pixel data behind it.
        let mut payload = b"ASCII\0\0\0".to_vec();
        payload.extend_from_slice(BLOCK.as_bytes());
        let found = parse(&exif_jpeg_payload(payload, true)).expect("generated");
        assert_eq!(found.prompt.as_deref(), Some("1girl, solo, purple hair, gigantic ass"));
        assert_eq!(found.model.as_deref(), Some("waiNSFWIllustrious_v110"));
    }

    #[test]
    fn a_jpeg_with_no_exif_says_nothing() {
        // Precision matters more than recall here: a holiday photograph must
        // not acquire a tool name because its bytes happened to line up.
        let plain = [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x02, 0x00,
            0x9c, 0xfe, 0x80, 0x7f,
        ];
        assert_eq!(parse(&plain), None);
    }

    #[test]
    fn the_checkpoint_is_read_from_model_not_model_hash() {
        // A real settings line puts `Model hash` before `Model` and
        // `ADetailer model` after it. A looser reader picks the hash.
        let block = concat!(
            "a girl
",
            "Negative prompt: lowres
",
            "Steps: 50, Size: 660x990, Model hash: a1ff10e2dc, ",
            "Model: aniversev20-revAnimatedv122-50p-hll3vtubers, ",
            "VAE: vae-ft-mse-840000-ema-pruned.safetensors, ADetailer model: face_yolov8n.pt"
        );
        assert_eq!(
            checkpoint_of(block).as_deref(),
            Some("aniversev20-revAnimatedv122-50p-hll3vtubers")
        );
    }

    #[test]
    fn a_merge_recipe_name_survives_its_commas_and_parentheses() {
        // The webui names an unnamed merge after its own recipe. Splitting the
        // settings line naively truncates this at the first comma.
        let block = "x
Steps: 50, Model: 0.7(aniverse_v20HDPruned) + 0.3(hll3vtubers-last-pruned), Clip skip: 2";
        assert_eq!(
            checkpoint_of(block).as_deref(),
            Some("0.7(aniverse_v20HDPruned) + 0.3(hll3vtubers-last-pruned)")
        );
    }

    #[test]
    fn a_block_naming_no_model_selects_nothing() {
        assert_eq!(checkpoint_of("just a prompt
Steps: 20, Seed: 1"), None);
        assert_eq!(checkpoint_of(""), None);
    }

    #[test]
    fn reads_an_automatic1111_block() {
        let block = "a girl on a beach, masterpiece, best quality\n\
                     Negative prompt: bad hands, blurry\n\
                     Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, \
                     Size: 512x768, Model hash: abc123, Model: someMix_v4";
        let found = parse(&png_with_text("parameters", block)).expect("parsed");

        assert_eq!(found.tool, "Stable Diffusion");
        assert_eq!(found.prompt.as_deref(), Some("a girl on a beach, masterpiece, best quality"));
        assert_eq!(found.negative_prompt.as_deref(), Some("bad hands, blurry"));
        assert_eq!(found.seed.as_deref(), Some("12345"));
        assert_eq!(found.steps.as_deref(), Some("28"));
        assert_eq!(found.cfg_scale.as_deref(), Some("7"));
        assert_eq!(found.model.as_deref(), Some("someMix_v4"));
        // The comma inside the sampler name must not split the field.
        assert_eq!(found.sampler.as_deref(), Some("DPM++ 2M Karras"));
    }

    /// The characters ride along on the parse rather than being asked for
    /// separately, so the far end never has to re-derive them — and so no
    /// future parser can quietly ship without them.
    #[test]
    fn a_parsed_generation_carries_the_characters_its_prompt_names() {
        let block = "masterpiece, aqua (konosuba), 1girl, blue hair
                     Negative prompt: blurry
                     Steps: 28, Sampler: Euler a, Seed: 1, Model: someMix_v4";
        let found = parse(&png_with_text("parameters", block)).expect("parsed");
        assert_eq!(found.characters, vec!["aqua (konosuba)".to_string()]);
    }

    #[test]
    fn a_prompt_naming_nobody_carries_an_empty_list_rather_than_a_guess() {
        let block = "masterpiece, 1girl, silver hair, glasses
                     Steps: 28, Seed: 1, Model: someMix_v4";
        let found = parse(&png_with_text("parameters", block)).expect("parsed");
        assert!(found.characters.is_empty());
    }

    #[test]
    fn controlnets_inner_settings_do_not_overwrite_the_real_ones() {
        // Trimmed from a real file. The trap is `ControlNet 0: "…, Model: None,
        // …"` — a quoted value that itself contains `Key: value` pairs. Splitting
        // on ", " without tracking quotes finds that inner `Model: None` and
        // reports it as the checkpoint, which is what every ControlNet-using
        // image in this library did.
        let block = "a girl by a pool\n\
                     Negative prompt: lowres, bad hands\n\
                     Steps: 30, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 5, \
                     Seed: 3441065909, Size: 896x1192, Model hash: c364bbdae9, \
                     Model: waiNSFWIllustrious_v110, Denoising strength: 0.75, Clip skip: 2, \
                     ControlNet 0: \"Module: None, Model: None, Weight: 1, Control Mode: Balanced\", \
                     ADetailer model: face_yolov8n.pt, ADetailer confidence: 0.3";
        let found = parse(&png_with_text("parameters", block)).expect("parsed");

        assert_eq!(
            found.model.as_deref(),
            Some("waiNSFWIllustrious_v110"),
            "the checkpoint, not ControlNet's",
        );
        assert_eq!(found.seed.as_deref(), Some("3441065909"));
        assert_eq!(found.sampler.as_deref(), Some("DPM++ 2M"));
        assert_eq!(found.cfg_scale.as_deref(), Some("5"));
    }

    #[test]
    fn an_img2img_result_is_marked_as_unreproducible() {
        // Trimmed from a real file in `outputs\img2img-images\`. It carries a
        // denoising strength that was applied to a *source image* which no
        // parameter block contains — so handing this to txt2img produces a
        // different picture with the same description, and the button that
        // offers to do so has to say as much.
        let img2img = "a girl by a pool\n\
                       Negative prompt: lowres\n\
                       Steps: 30, Sampler: DPM++ 2M, CFG scale: 5, Seed: 2582348945, \
                       Size: 896x1192, Denoising strength: 0.74, Clip skip: 2";
        let found = parse(&png_with_text("parameters", img2img)).expect("parsed");
        assert!(found.needs_source_image, "made from another image");

        // The confusable case: txt2img *with hires fix* also writes a denoising
        // strength, and that one is perfectly reproducible. Telling a person
        // their 39,552 txt2img images cannot be regenerated would be worse than
        // saying nothing.
        let hires = "a girl by a pool\n\
                     Negative prompt: lowres\n\
                     Steps: 30, CFG scale: 5, Seed: 1, Denoising strength: 0.7, \
                     Hires upscale: 2, Hires upscaler: Latent";
        let found = parse(&png_with_text("parameters", hires)).expect("parsed");
        assert!(!found.needs_source_image, "hires is not img2img");

        // And plain txt2img names no denoising at all.
        let plain = "a girl\nNegative prompt: lowres\nSteps: 30, Seed: 1";
        let found = parse(&png_with_text("parameters", plain)).expect("parsed");
        assert!(!found.needs_source_image);
    }

    #[test]
    fn the_raw_block_is_recoverable_whole() {
        // What "Open in Forge" actually sends. The parsed fields are for
        // display; anything built out of them loses schedule type, clip skip,
        // ControlNet and every ADetailer setting, and the regenerated image
        // comes out different — which is exactly what happened.
        let block = "a girl by a pool\n\
                     Negative prompt: lowres\n\
                     Steps: 30, Schedule type: Karras, ADetailer model: face_yolov8n.pt, \
                     ADetailer denoising strength: 0.4";
        let png = png_with_text("parameters", block);

        let raw = raw_from(&png).expect("the block is recoverable");
        assert_eq!(raw, block, "byte for byte, not reconstructed");
        assert!(raw.contains("Schedule type: Karras"));
        assert!(raw.contains("ADetailer denoising strength: 0.4"));
    }

    /// `read_parameter_block` without a file on disk.
    fn raw_from(head: &[u8]) -> Option<String> {
        png_text_chunks(head)
            .into_iter()
            .find(|(keyword, _)| keyword == "parameters")
            .map(|(_, text)| text)
    }

    #[test]
    fn a_prompt_is_not_truncated_at_its_first_non_ascii_byte() {
        // Why the chunk length is parsed rather than scanning for the next NUL:
        // prompts routinely carry accented characters and emoji.
        let block = "café ☕ on a terrasse, naïve style\nNegative prompt: flou\nSteps: 20";
        let found = parse(&png_with_text("parameters", block)).expect("parsed");
        assert_eq!(found.prompt.as_deref(), Some("café ☕ on a terrasse, naïve style"));
        assert_eq!(found.negative_prompt.as_deref(), Some("flou"));
    }

    #[test]
    fn reads_a_comfyui_graph_and_picks_the_longer_prompt() {
        let graph = r#"{
            "3": {"class_type": "KSampler",
                  "inputs": {"seed": 987654, "steps": 25, "cfg": 8.0,
                             "sampler_name": "euler"}},
            "4": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sdxl_base.safetensors"}},
            "6": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "a detailed portrait of a woman in a red coat"}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "watermark, text"}}
        }"#;
        let found = parse(&png_with_text("prompt", graph)).expect("parsed");

        assert_eq!(found.tool, "ComfyUI");
        assert_eq!(
            found.prompt.as_deref(),
            Some("a detailed portrait of a woman in a red coat")
        );
        assert_eq!(found.negative_prompt.as_deref(), Some("watermark, text"));
        assert_eq!(found.model.as_deref(), Some("sdxl_base.safetensors"));
        assert_eq!(found.seed.as_deref(), Some("987654"));
        assert_eq!(found.sampler.as_deref(), Some("euler"));
    }

    #[test]
    fn a_jpeg_with_the_block_in_exif_is_still_recognised() {
        // No PNG chunk to walk, so this falls back to the text scan. It is the
        // 0.3% case measured on a real library — rare, but the alternative is
        // calling a generated image a photograph.
        let mut head = b"\xff\xd8\xff\xe1\x00\x16Exif\0\0MM\0*\0".to_vec();
        head.extend_from_slice(
            b"UNICODE\0a castle at dusk\nNegative prompt: blurry\nSteps: 30, Seed: 77",
        );
        let found = parse(&head).expect("parsed");
        assert_eq!(found.tool, "Stable Diffusion");
        assert_eq!(found.prompt.as_deref(), Some("a castle at dusk"));
        assert_eq!(found.seed.as_deref(), Some("77"));
    }

    #[test]
    fn an_ordinary_photograph_declares_nothing() {
        let photo = b"\xff\xd8\xff\xe1\x00\x16Exif\0\0MM\0*\0\0\0\x08Canon EOS 5D Mark IV\0f/2.8";
        assert!(parse(photo).is_none());
        assert!(parse(b"").is_none());
        // A PNG with no text chunks at all.
        let mut plain = PNG_SIGNATURE.to_vec();
        plain.extend_from_slice(&[0, 0, 0, 13]);
        plain.extend_from_slice(b"IHDR");
        plain.extend_from_slice(&[0; 17]);
        assert!(parse(&plain).is_none());
    }

    #[test]
    fn a_missing_file_is_not_generated_rather_than_an_error() {
        // Per-item failures are rows, not exceptions — and here, not even
        // rows: an unreadable file is simply not known to be generated.
        assert_eq!(read_generation(Path::new("/nonexistent/nope.png")), None);
    }

    #[test]
    fn a_truncated_workflow_chunk_still_reports_the_tool() {
        // ComfyUI graphs routinely exceed the 96KB head. Losing the prompt is
        // acceptable; losing the fact that it was generated is not.
        let mut head = PNG_SIGNATURE.to_vec();
        head.extend_from_slice(&(500_000_u32).to_be_bytes());
        head.extend_from_slice(b"tEXt");
        head.extend_from_slice(b"prompt\0{\"3\": {\"class_type\": \"KSampler\", \"inputs\": {");
        let found = parse(&head).expect("still recognised");
        assert_eq!(found.tool, "ComfyUI");
        assert_eq!(found.prompt, None);
    }
}

#[cfg(test)]
mod character_tests {
    use super::characters_of;

    #[test]
    fn finds_the_danbooru_character_form() {
        assert_eq!(
            characters_of("masterpiece, aqua (konosuba), blue hair, ocean"),
            vec!["aqua (konosuba)".to_string()]
        );
    }

    #[test]
    fn normalises_case_and_spacing_so_variants_count_as_one() {
        assert_eq!(
            characters_of("Aqua  (Konosuba), 1girl"),
            vec!["aqua (konosuba)".to_string()]
        );
    }

    #[test]
    fn sees_through_emphasis_and_weights() {
        // `(aqua \(konosuba\):1.2)` is the same tag wearing syntax.
        assert_eq!(
            characters_of(r"(aqua \(konosuba\):1.2), solo"),
            vec!["aqua (konosuba)".to_string()]
        );
    }

    #[test]
    fn a_copyright_or_cosplay_qualifier_is_not_a_person() {
        // Counting these would put "fate (series)" on the leaderboard.
        assert_eq!(characters_of("fate (series), saber (cosplay)"), Vec::<String>::new());
    }

    #[test]
    fn a_bare_name_is_found_by_the_dictionary_not_by_shape() {
        // `tsukishiro yanagi` has the same shape as `silver hair`. The first
        // version refused to guess and skipped both; the dictionary resolves
        // the ambiguity by membership, so the name is found and the hair
        // colour still is not.
        assert_eq!(
            characters_of("tsukishiro yanagi, glasses"),
            vec!["tsukishiro yanagi".to_string()]
        );
        assert_eq!(characters_of("silver hair, glasses"), Vec::<String>::new());
    }

    #[test]
    fn several_characters_all_count_once_each() {
        assert_eq!(
            characters_of("2girls, aqua (konosuba), megumin (konosuba), aqua (konosuba)"),
            vec!["aqua (konosuba)".to_string(), "megumin (konosuba)".to_string()]
        );
    }

    #[test]
    fn syntax_fragments_are_not_names() {
        // LoRA leftovers, weighted style tags, empty parens.
        assert_eq!(
            characters_of("<lora:styleXL:0.8>, (masterpiece:1.2), ()"),
            Vec::<String>::new()
        );
    }
}

#[cfg(test)]
mod leaderboard_hygiene_tests {
    use super::characters_of;

    #[test]
    fn scene_vocabulary_in_character_shape_is_not_a_person() {
        // Straight off a real library's leaderboard, sitting between Misty
        // and Asuna: the shape is right and the meaning is not.
        assert_eq!(
            characters_of("earth (planet), star (sky), tokyo (city), seductive smile (looking at viewer)"),
            Vec::<String>::new()
        );
        // The second harvest, one re-run later: anatomy and clothing
        // qualifiers. Word-level, so "lactating breasts" falls to "breasts".
        assert_eq!(
            characters_of(
                "cross-laced (footwear), cinema shot (lactating breasts), extra large (fat ass)"
            ),
            Vec::<String>::new()
        );
    }

    #[test]
    fn underscore_form_normalises_to_the_spaced_form() {
        // `d.va_(overwatch)` is danbooru's own underscore spelling. Without
        // normalising, it and `d.va (overwatch)` count as two characters and
        // the joining underscore dangles off the name.
        assert_eq!(
            characters_of("d.va_(overwatch), 1girl"),
            vec!["d.va (overwatch)".to_string()]
        );
        assert_eq!(
            characters_of("asuna_(blue_archive), asuna (blue archive)"),
            vec!["asuna (blue archive)".to_string()]
        );
    }

    #[test]
    fn the_underscore_spelling_of_a_blocked_qualifier_is_still_blocked() {
        assert_eq!(
            characters_of("seductive_smile_(looking_at_viewer)"),
            Vec::<String>::new()
        );
    }
}


#[cfg(test)]
mod dictionary_tests {
    use super::characters_of;

    #[test]
    fn a_bare_name_the_dictionary_knows_is_detected() {
        // The gap that motivated the dictionary: VTuber tags mostly have no
        // `(series)` qualifier, so shape alone could never find them.
        assert_eq!(
            characters_of("masterpiece, murasaki shion, purple hair, witch hat"),
            vec!["murasaki shion".to_string()]
        );
        assert_eq!(
            characters_of("Murasaki_Shion, 1girl"),
            vec!["murasaki shion".to_string()]
        );
    }

    #[test]
    fn a_bare_fragment_the_dictionary_does_not_know_is_still_skipped() {
        // Shape-identical to a name; only membership separates them.
        assert_eq!(
            characters_of("silver hair, blue eyes, thick thighs, wide shot"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn both_paths_together_find_a_mixed_cast() {
        assert_eq!(
            characters_of("aqua (konosuba), murasaki shion, ocean"),
            vec!["aqua (konosuba)".to_string(), "murasaki shion".to_string()]
        );
    }
}


#[cfg(test)]
mod extras_tests {
    use super::parse_a1111;

    #[test]
    fn an_extras_block_is_postprocessed_not_generated_settings() {
        // The whole block of an Extras-tab upscale: no steps, no seed, just
        // the postprocess keys.
        let generation = parse_a1111("Postprocess upscale by: 2, Postprocess upscaler: 4x-UltraSharp");
        assert!(generation.postprocessed);
        assert_eq!(generation.tool, "Stable Diffusion");
    }

    #[test]
    fn an_ordinary_block_is_not_postprocessed() {
        let generation =
            parse_a1111("a girl\nNegative prompt: lowres\nSteps: 28, Seed: 1, Size: 832x1216");
        assert!(!generation.postprocessed);
    }
}


#[cfg(test)]
mod extras_path_tests {
    use super::extras_path;

    #[test]
    fn an_extras_folder_segment_marks_the_path() {
        assert!(extras_path(r"\\?\UNC\nas\vault\AI images\extras\00000.png"));
        assert!(extras_path("/media/outputs/extras-images/00001.png"));
    }

    #[test]
    fn only_whole_segments_count() {
        // A file or folder merely *containing* the word is not the tab's
        // output folder.
        assert!(!extras_path(r"D:\pics\extrasomething\a.png"));
        assert!(!extras_path(r"D:\pics\my-extras-notes.png"));
    }
}
