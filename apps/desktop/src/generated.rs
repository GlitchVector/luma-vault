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
/// Used only when the structured parse finds nothing — a JPEG carrying an
/// A1111 block in EXIF has no PNG chunk to walk, and knowing *that* it was
/// generated is worth recording even when the parameters cannot be recovered.
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

    // No usable chunk. A JPEG carrying an A1111 block in EXIF still reads as
    // generated, and the block itself is plain text inside the EXIF payload.
    if let Some(start) = find(head, b"Negative prompt:").or_else(|| find(head, b"Steps: ")) {
        let from = head[..start].iter().rposition(|b| *b == 0).map_or(0, |i| i + 1);
        if let Ok(text) = std::str::from_utf8(&head[from..]) {
            return Some(parse_a1111(text));
        }
    }

    find_marker(head).map(|tool| Generation {
        tool: tool.to_string(),
        ..Default::default()
    })
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
        negative_prompt: prompts.get(1).cloned(),
        prompt: prompts.first().cloned(),
        model,
        seed,
        sampler,
        steps,
        cfg_scale: cfg,
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
        prompt: get("prompt"),
        // NovelAI calls the negative prompt "uc", for undesired content.
        negative_prompt: get("uc"),
        model: None,
        seed: get("seed"),
        sampler: get("sampler"),
        steps: get("steps"),
        cfg_scale: get("scale"),
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

#[cfg(test)]
mod tests {
    use super::*;

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
