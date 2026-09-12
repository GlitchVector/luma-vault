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
| `sevenc_v2` | `sevenc` | full | 7C (the sheet says Mira Axiom): infiltration android, white short messy hair, orange eyes, black bodysuit with glowing orange seams, white armour with a single pauldron and a mechanical left arm, orb spine, high-heeled armoured boots | working; the arm holds its side from behind after the back views were weighted x30 in v2 |
| `sevencb_v1` | `sevencb` | full | 7C, leotard outfit: black high-leg turtleneck leotard with side cutouts and straps, thigh strap and pouch, the same white mechanical left arm and pauldron, orb spine, heeled armoured ankle boots | round 1 done 2026-09-12 (32/42, rears mirror the arm); `sevencb_v2` **working** 2026-09-12: 6/6 proofs on-sheet from the front, the rear still puts the white arm on her right (the sheet's own back view plates both arms, so the rear is only fixed by the prompt) |
| `sevencc_v1` | `sevencc` | body | 7C, third outfit (from the sheet named Kaia, trained as her outfit): open cropped leather jacket with emblem, black leotard with a cream chest panel and O-ring, harness, thigh pouch, long gloves with a mechanical left forearm, hip drapes, buckled heeled ankle boots. Worn under `sevenc_v2` for the face | `sevencc_v1` proofs 2026-09-12 12:50: outfit holds on 6/6 (jacket, leotard, harness, drapes, pouch, gloves, heels on 5/6), misses: the cream chest panel renders black, the mechanical forearm flips to her right on the front, flat boots on one front; round 1 done 13:05 (40/42, two flat-boot drops); `sevencc_v2` **working** 2026-09-12 14:33: 6/6 on-sheet, forearm on her left from behind now. Open: the cream chest panel renders black (say it in the prompt, e.g. `(white bra:1.1)` under `two-tone leotard`), and a straight-on front tends to flat boots - add `(high heels:1.3), stiletto heels` on full-body fronts |
| `sthorne_v1` | `sthorne` | full | Sable Thorne, the owner's original dark-elf knight: long black hair with a green underlayer, green eyes, black lips, pointed ears, black spiked plate with green runes, armoured high-leg leotard with an underboob crop breastplate (the front trains from the second image, not the sheet's closed plate), lace thighhighs under armoured thigh boots, greatsword | `sthorne_v1` proofs 2026-09-12 16:00: 6/6 on-sheet (underboob plate on the front, closed plate elsewhere, lace thighhighs under thigh boots, greatsword); misses: a duplicate planted sword and flat boots on the straight-on front, a keyhole cutout on the three-quarter; round 1 done 16:30 (41/42, one two-sword drop); the first `sthorne_v2` run was killed at 80% when the owner fixed the sheet (garter straps now run the full way to the stockings); then again for the thin-strap sheet; `sthorne_v2` **working** 2026-09-12 19:05: 6/6 on-sheet, one sword, heels on the front; the thin full-length garter straps render only when the prompt says `(garter straps:1.3)` - a captioned feature binds to its word, so keep it in every leg/hip line. Face tone: the sheet's face panels are near-white, so never prompt `pale skin` for her and give the face pass `(pale skin:1.3), (white skin:1.3), pale face` as its negative at denoise 0.35, or the repainted face comes out whiter than the body (owner 2026-09-12 19:20) |
| `msar_v1` | `msar` | body | Mira Solen, plate-armour outfit (sheet 2026-09-12): ornate silver plate with gold trim and glowing blue cross emblems, twin pauldrons, armoured bra over a black high-leg suit with plated hips, black sleeves with vambraces and gauntlets, strap holsters on bare thighs, plated knees and shins over chunky armoured boots, loose wavy brown hair. Face from the Lara pair at render time (never the body LoRA in the face pass) | `msar_v1` proofs 2026-09-12 20:35: 6/6 on-sheet (plate, gold trim, armoured bra over the black suit, pauldrons, gauntlets, thigh holsters, plated shins, chunky boots, her face from the Lara pair); miss: the glowing blue cross emblems on pauldrons/chest never appear on the proofs (a small blue cross does show on the collar in the round-1 close-ups); round 1 done 21:05 (41/42, one two-figure drop); `msar_v2` **working** 2026-09-12 22:25: 6/6 on-sheet on a clean grey background, the blue cross now on the pauldron in the tight shots; the round-1 candidates were rendered in the winter script's snow settings by mistake (captioned as snow, no bleed on the proofs), the script now uses neutral settings |
| `lvane_v1` | `lvane` | full | Lyra Vane, the owner's original android: silver high ponytail with bangs over one eye, blue eyes, silver choker and teardrop earrings, white glossy high-leg leotard with a deep cleavage cutout and halter neck, blue-lit joints, white elbow gloves, white thigh-high stiletto boots, open back with a hexagonal blue core. Render words: `(android:1.2), (white leotard:1.3), (highleg leotard:1.2), (halterneck:1.2), (shiny clothes:1.2), latex, (white gloves:1.2), elbow gloves, joints, (glowing:1.1), (blue trim:1.2)`; legs `(white footwear:1.2), (thigh boots:1.3), stiletto heels`; rears `thong leotard, (backless leotard:1.2), hexagon` | `lvane_v1` proofs 2026-09-12 23:33 (trained from 22:27): 6/6 on-sheet in the sheet's anime style - leotard, cutout, halter, blue gems, elbow gloves, stiletto thigh boots, ponytail, choker, hex core on the back; round 1 done 2026-09-13 00:00 (42/42, no drops), `lvane_v2` training 00:05 |

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

**Full-character LoRAs** (`kvoss`, `embk`, `sevenc`, `sevencb`, `lcroft`, `mirasolen`): same
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
