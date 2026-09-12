# Trained LoRAs

Every LoRA trained for the vault's characters, what it carries, and how to
render with it. The Celestial Oracle, Mira Solen, Kira Voss, Ember Kael and 7C are the
owner's original characters; only Lara Croft is not. All are SDXL LoRAs trained with kohya `sd-scripts` on
Illustrious XL 1.1 (`D:\AI\lora-train\train-oracle.ps1`, dim 16 / alpha 8
unless noted), from OpenAI character sheets cut into view crops and body bands.
Files live in Forge's `models/Lora/`; datasets, captions and prep scripts in
`D:\AI\lora-train\datasets\<name>\`.

Two kinds exist:

- **Full character** — face and outfit train together. The face pass carries
  the LoRA itself (`<lora:name:0.8>, trigger` in the ADetailer prompt) on the
  composing checkpoint.
- **Body-only** — the face is masked out of the loss (`-MaskedLoss`, masks from
  `make-face-masks.py`), so the face comes from a face LoRA or the checkpoint.
  Never put a body LoRA in the face pass.

Two things no sheet LoRA carries, measured repeatedly: the **build** (hips,
breasts, glutes come from the prompt's body block, not the trigger — see
"The glute question" below) and **tight framing** (a `close-up` request lands
at cowboy distance; ask for `portrait, face focus` for a face).

## Catalogue

Every new LoRA gets a row here when its dataset is cut, and the row is
updated at each version verdict. A LoRA that is not in this table does not
exist as far as the pipeline is concerned.

| LoRA | Trigger | Kind | Character / outfit | Status |
|---|---|---|---|---|
| `celoracle_v3` (+ `celoback_v1`) | `celoracle` / `celoback` | full | Celestial Oracle: lavender thigh-length hair, veil, naked tabard, loincloth on a hip band | working; stack `celoback_v1` at 0.5 on rear frames for the narrow ribbon flap |
| `lcroft_v2` | `lcroft` | full | Lara Croft classic: teal tank, shorts, holsters, backpack, ponytail | working; `lcroft_v3` folded the face sheets in with no gain |
| `lcface_v7` | `lcface` | face (dim 64) | Lara's face from two face sheets, trained on `realismIllustriousBy_v55FP16` | working; **the face used on every Mira body LoRA** |
| `mirasolen_v2` | `mirasolen` | full | Mira Solen, boots sheet: pink zip crop top, harness with holsters, striped shorts, mid-calf lace-up platforms, twintails, freckles | working |
| `msolen_v2` | `msolen` | full | Mira, sneakers sheets (twintails and cap+ponytail variants as prompt switches) | working |
| `msbody_v4` | `msbody` | body | Mira, sneakers sheets, face masked | working |
| `msface_v1` | `msface` | face | Mira's own face from the sheet panel | usable; the user preferred the Lara face pair |
| `msw_v4` | `msw` | body | Mira, white variant: white ribbed halter crop top with black trim and front zip, harness without cross strap, striped shorts, chunky sneakers | working (`msw_v5` no gain) |
| `msp_v1` | `msp` | body | Mira, boots variant: pink cap and ponytail, pink mock-neck top, brown striped micro shorts, three-buckle platform boots | working |
| `msd_v2` | `msd` | body | Mira, desert A: grey ribbed cutout leotard, hooded cowl scarf, brown O-ring harness, arm and leg wraps, grey micro shorts with pouches, strapped platform boots | working; a horizontal chest band is baked in from keepers |
| `msdb_v2` | `msdb` | body | Mira, desert B: desert A without the shorts, high-leg thong-back leotard with the belt and thigh pouch riding on it | working |
| `msbs_v4` | `msbs` | body (dim 32) | Mira, base sheet: black SOLEN crop tee over a navy high-leg bodysuit, chunky two-tone sneakers, twintails | working; print needs `english text, solen` in the prompt |
| `mswt_v2` | `mswt` | body | Mira, winter: cream ribbed hooded sweater dress, fleece hood and hem, brown raglan yoke with emblem, half-zip, chunky brown sneakers over socks | working |
| `kvoss_v2` | `kvoss` | full | Kira Voss: pink high ponytail, black cropped hoodie with underboob and an IHS back print, black thong, black platform combat boots | working; back print needs `english text, ihs` |
| `embk_v2` | `embk` | full | Ember Kael (Pyra-inspired): copper hair with a blonde streak, teal armoured bodysuit, single pauldron on her left shoulder, neon trim, armoured heeled boots | working; negate `(pauldrons:1.3)` so the plate stays single |
| `sevenc_v1` | `sevenc` | full | 7C (the sheet says Mira Axiom): infiltration android, white short messy hair, orange eyes, black bodysuit with glowing orange seams, white armour with a single pauldron and a mechanical left arm, orb spine, high-heeled armoured boots | v1 proofs on-sheet 2026-09-12; round 1 rendering |

Superseded versions stay installed (`msw_v2`, `msbs_v1`, `kvoss_v1`, …) and are
not worth rendering with.

## Rendering recipes

**Mira body LoRAs** (`msw`, `msp`, `msd`, `msdb`, `msbs`, `mswt`):

```
<lora:<name>:0.9>, <trigger>, <lora:lcface_v7:0.6>, lcface, 1girl, solo, <hair words>, <outfit words>, <body block>
ADetailer: <lora:lcface_v7:0.8>, lcface, 1girl, brown hair, ... closed mouth   on delburry75, denoise 0.5
```

Composition on `deliberate` or `delburry75`. Undressed frames run the body LoRA
at 0.75 and negate `(body paint:1.5), paint, painted skin, colored skin` plus
the outfit's own colour words; the standard censor negatives
(`(censored:1.4), mosaic censoring, bar censor, (heart censor:1.3), censor
sticker, (pasties:1.4), (tape:1.3), sticker, emoji`) stay on every frame.

**Full-character LoRAs** (`kvoss`, `embk`, `sevenc`, `lcroft`, `mirasolen`): same
weights, but the ADetailer prompt carries the LoRA itself at 0.8 with the hair
and eye words, denoise 0.4, same checkpoint as the composition.

Per-outfit prompt words live in the candidate scripts that built each LoRA
(`make-*-candidates.py` in the session scratchpad) and, for the Mira variants,
in the `/shotall` and `/photostory` boards under `.claude/commands/`.

## Lessons that hold across all of them

- **Caption what the tagger misses.** Stripes, trims, zips, a single pauldron:
  if a garment detail is not in the captions it is not in the LoRA. Captions
  for every sheet since the white variant are written by hand from the sheet.
- **A displaced garment loses its colour.** Pulled-down leotards went black,
  lifted hoodies went white. On undressed frames say the colour as a clothes
  word — `(black hoodie:1.4), (black clothes:1.3)` — and negate the rival.
- **Text on clothes binds to the trigger.** A SOLEN tee printed the trigger
  letters until the word `solen` was captioned next to `clothes writing` and
  sent in the prompt; same for Kira's `ihs`.
- **Keepers teach whatever is in their pixels.** Round-1 renders that pass the
  audit train v2 and reinforce the outfit; frames whose only fault is a wrong
  print become lower-body keepers, cropped below the print.
- **Mirrors only of symmetric parts.** One-sided holsters, pauldrons, tattoos
  and back prints are never flipped.
- **Never touch a dataset while kohya trains on it.** The trainer reads the
  cached latents and masks from disk every step.

## The glute question

Asked 2026-09-11: does a sheet LoRA carry the character's build? Measured on
`msbs` v1 through v4 with trigger-only renders (no body words): no. Removing
the body words from the captions, doubling the rank and training on the sheet
alone all left the trigger rendering a slim default figure; at LoRA weight 1.3
the rear rounds out only slightly. Four views of one sheet do not overrule the
checkpoint's body prior. The build in every set comes from the prompt block
(`(large breasts:1.5), (wide hips:1.6), (thick thighs:1.6), (huge ass:1.4)` and
friends), and a sheet's particular glute form is not reproducible this way.
