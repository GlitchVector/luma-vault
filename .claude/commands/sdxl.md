---
description: Migrate a generated image's prompt onto a newer checkpoint and open it in Forge
argument-hint: <image> [model — defaults to deliberate]
---

# Migrating a generation to a newer model

## 1. Look at the picture, not only at its prompt

**Open the image before anything else.** `pnpm migrate-prompt <name> --show`
prints the block and the file's path; read the file with it.

The prompt is often not a description of the picture. This library is full of
**img2img** generations — the giveaway is a `Denoising strength` with no hires
pass — and an img2img keeps its subject in the *init image*, which a PNG
parameter block does not carry. One real example ran to twelve words:

```
masterpiece, best quality, ultra-detailed, illustration, pink hair bangs,
(beautiful green eyes:1.2), playful smirk, Pretty Face, Pretty Eyes, open mouth, blush, happy
```

…and the picture is a named character in a black dress with gold trim, garter
straps, thighhighs, headphones round her neck and a demon tail. Migrated
faithfully, that prompt produces a stranger in a green sweater, and the person
who asked is right to say it looks nothing like theirs.

So read the picture the way `/recreate` does — character, outfit garment by
garment, pose, setting — and pass what the prompt does not already say as
`--add`. Skip nothing on the grounds that it is obvious: the model cannot see
the file either. What the prompt *does* say is left alone and stays in front,
where its weight is; anything already there is dropped rather than repeated.

### The second witness: what it was made from

For an img2img, `--show` also prints the picture it was **made from**, and that
one's prompt. Nothing in any file records the init image — but a denoising pass
keeps the composition it started from, so the library can *recognise* it, and
then walk back through the chain to whatever txt2img began it. It works about
two times in three; when it does not, it says so rather than guessing.

This is frequently where the words are. One real chain starts from a prompt
reading `very detailed human left hand` — an inpaint repairing a hand — and six
passes back names the character, her hair, her eyes and her dress.

**Read it against the picture; never paste it through.** The point of an
img2img pass is often to keep a composition and change the subject, so an
ancestor can confidently name someone who is no longer there — the output says
`the trail goes cold here` or `this is where the lineage starts` so you know how
far back you are looking, and the weakest hop in bits so you know how much to
trust it. Anything it names that you can *see* in the picture is worth putting
in `--add`; anything you cannot see is not.

Note the aspect too. A square source with a standing figure in it usually wants
`--size 832x1216`, and the canvas is worth asking about whenever the two
disagree.

## 2. Ask about body shape and the shot — before running anything

The same questions `/recreate` asks, with the same ladders. **First call,
four questions**, single-select:

| Question | Options |
|---|---|
| Ass | as seen · `big ass` · `huge ass` · `gigantic ass` |
| Breasts | as seen · `large breasts` · `huge breasts` · `gigantic breasts` |
| Thighs | as seen · `thick thighs` · `(thick thighs:1.4)` · `(thick thighs:2)` |
| Hips | as seen · `wide hips` · `(wide hips:1.4)` · maximum |

Here "as seen" means: keep whatever the picture and its prompt already have for
that axis — pass nothing for it. Hips **maximum** is not a weight but this exact
combo:

```
(wide hips:2), (thick thighs:2), (curvy:2), (narrow waist:2), (hyper hips:2), hip focus
```

When maximum is picked, drop whatever the thighs question answered — the
combo already argues the thighs at 2.

Then a **second call**, which always happens because it carries the shot:

| Question | Options |
|---|---|
| Shot | as-is · `cowboy shot` · `full body` · `wide shot` |
| Ass boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |
| Breast boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |

Boosts apply as `(huge ass:1.3)`; `:2` is the tested ceiling. "As-is" keeps
whatever framing the original prompt carries. The ladder has more rungs than
the four buttons — `close-up`, `portrait`, `upper body`, `lower body`,
`very wide shot` — and any of them typed under Other is equally valid; pass
it through as given.


### The third question in that second call: the style

Ask it every time, alongside the shot. It is the axis with the largest visible
effect on the result and the least obvious controls:

| Question | Options |
|---|---|
| Style | as seen · `2D` · `2.5D` · `3D` |

Pass the answer as `--style 2d`, `--style 2.5d` or `--style 3d`; "as seen"
passes nothing.

- **2D** — flat anime. `anime coloring, flat color`, arguing against
  `realistic, photorealistic, shiny skin`.
- **2.5D** — soft semi-real anime, the glossy look. `realistic, shiny skin`,
  arguing against `flat color, anime coloring, photorealistic`.
- **3D** — rendered. `photorealistic, realistic, shiny skin`, arguing against
  `anime coloring, flat color, lineart, sketch`.

2.5D and 3D both assert `realistic`; the only difference between them is
whether `photorealistic` is asked for or argued against. That single tag is
what separates a soft anime-shaded figure from a rendered one.

**Do not hand-write these tags.** The obvious words for this axis are mostly
not danbooru tags at all — `3d`, `cel shading`, `soft shading`, `glossy skin`
and `detailed skin` are all absent from the 10,861 names in
`models/anime-tagger/selected_tags.csv`, so a prompt asking for them is asking
in a language the model never learned. `shiny skin` is the one that carries the
gloss. The flag applies the checked set and clears whatever competing rendering
tag the prompt already had.

## 3. Run the script

It does the whole thing; pass the arguments through untouched:

```bash
pnpm migrate-prompt $ARGUMENTS
```

Four flags carry the answers, and all of them are optional:

| Flag | From |
|---|---|
| `--add "<tags>"` | step 1 — what the picture shows and the prompt never said |
| `--size WxH` | step 1 — the canvas, when the source shape is wrong for it |
| `--shot "<tag>"` | step 2, unless the answer was as-is |
| `--body "<tags>"` | step 2 — the rungs with their boosts, or the maximum combo |

```bash
pnpm migrate-prompt 00301 --shot "full body" --body "(gigantic ass:1.5), (wide hips:1.4)"
pnpm migrate-prompt 00489 --size 832x1216 \
  --add "mano aloe, black dress, gold trim, garter straps, black thighhighs, demon tail"
```

`--add` goes at the *end* of the prompt, behind whatever the person originally
wrote, and drops anything already there rather than saying it twice. `--size`
wins over the bucket rule and is snapped to the nearest SDXL bucket, so the
shape is what was asked for and the pixel count is what the model was trained
at.

The rewrite puts both at the front of the prompt where they carry the most
weight, and clears what they replace: every framing rung the prompt already
carried (two rungs in one prompt fight, and the result is neither), and every
size rung of each body axis the override mentions. `full body` and wider go
in weighted — `(full body:1.3)`, because bare they lose to body tags pulling
the camera in — and the negative gains `close-up, cropped, portrait,
upper body` as the backstop against drifting tight. All reported in the
notes.

Both positional arguments are substrings — `00301` finds the image,
`illustrious` finds the newest installed checkpoint whose filename contains
it. **The model is optional**; the script defaults to `deliberate` on its
own, so do not supply one when the user did not.

Then report the change notes it prints. They are the point of the command: each
line says what was altered and why, and every one of them is a silent failure
otherwise — Forge raises nothing and the picture simply comes out different.

## What it does

1. Finds the image in the Luma Vault index (read-only; safe while the app runs).
2. Reads the parameter block **from the file**, not the index. The index keeps
   six display fields; a real block carries schedule type, clip skip, ControlNet
   and every ADetailer setting.
3. For an img2img, finds what it was made from by perceptual hash and walks the
   chain back — `origin.ts` in `@luma/core`, sharing its rule with the app
   through `contracts/origin-vectors.json`. Reported, never merged.
4. Picks the newest installed checkpoint matching the target, by file date.
5. Detects its architecture from the safetensors header — `sd`, `xl`, `flux`.
6. Rewrites the block via `migrateGeneration` in `@luma/core` (tested there).
7. Selects the checkpoint in Forge **before** opening the tab.
8. Opens the tab; the prefill extension fills every field.

## The rewrite, when crossing SD1.5 → SDXL

| Change | Why |
|---|---|
| LoRA tags removed | SD1.5 LoRAs have the wrong text-encoder dimensions; they are parsed, matched against nothing, dropped |
| SD1.5 embeddings removed | `EasyNegative` on SDXL is not an embedding, it is the words "easy negative" steering the image |
| Danbooru quality tags added | what booru-trained SDXL models were trained to expect |
| Size → nearest SDXL bucket | SDXL trained at ~1MP; an SD1.5 canvas gives distorted anatomy, not a smaller image |
| Hires factor recomputed | keeps the final resolution the original aimed at |
| CFG 5, 28 steps, clip skip 2 | what these models are tuned for |
| Seed → random | a seed is a coordinate in one model's noise space and means nothing in another's |

Sampler, upscaler and denoising the block already names are left alone — they
are architecture-agnostic, and changing them would alter the picture for no
reason. What the block *lacks* is topped up on every XL move: a Hires pass
(1.5x, 30 steps, 4xUltrasharp, denoise 0.4) and an ADetailer face pass whose
prompt is built from the face words already in the prompt — identity and
expression, never body or setting. A block that carries its own hires or
ADetailer settings keeps them untouched.

Staying on the same architecture changes only the model and the seed.

## Hassaku, and Illustrious checkpoints generally

Pass `hassaku`. Both commands then send what the Illustrious guidance asks for:

| | Hassaku / Illustrious | the plain XL default |
|---|---|---|
| Quality | `masterpiece, best quality, amazing quality, very aesthetic, **newest**, absurdres` | same without `newest` |
| Negative | adds **`bad quality`** beside `worst quality` | `worst quality` only |
| Sampler | **Euler a**, schedule Automatic | DPM++ 2M SDE Karras |
| Steps | 28 | 28 |
| CFG | 5 | 5 |

`newest` is a recency tag Illustrious learned and the plain SDXL merges never
saw. `bad quality` is a separate learned tag from `worst quality` rather than a
synonym — these models are described as reading the negative about as strongly
as the prompt, so it is worth stating fully.

**CFG is the one thing the sources disagree on.** A Hassaku-specific page says
7; the Illustrious user guides call 4.5-5 the sweet spot inside a usable 3-7.
Neither is the creator — Civitai moved the model behind a host that cannot be
read — so the commands send 5, which is inside both. Try `--cfg 7` for the
other reading.

`perfectdeliberate` is an Illustrious checkpoint too, and its own card asks for
CFG 5-8, so `--cfg 6` is worth a try there when a render looks flat.

## AniVerse

Pass `aniverse` and both commands switch to **AniVerse XL's own recommended
settings**, from its model card:

| | AniVerse XL v4.0 | the booru-XL default |
|---|---|---|
| CFG | **5.5** | 5 |
| Steps | **30** | 28 |
| Sampler | **DPM++ 2M** Karras | DPM++ 2M SDE Karras |
| Trigger | **`4n1v3rs3`** | none |

The trigger matters more than any of the numbers. Without it the trained style
is never engaged and the same prompt comes back looking like base SDXL each
time — which reads as the model being wildly inconsistent rather than as a
missing token. It goes at the **end** of the prompt, where the card puts it,
and is not added twice if the prompt already carries it.

`DPM++ 2M` rather than the SDE variant is deliberate: the creator names it as
the one giving colour, detail and a **2.5D** result, against `Euler Max` which
is flatter and closer to 2D.

`--cfg` overrides the tuning when you want to explore.

## NoobAI, and v-prediction checkpoints generally

Pass `noob` as the model — `pnpm migrate-prompt 00489 noob` — and the usual
substring rule finds it. Two things then happen on their own, both decided from
the checkpoint rather than from what you typed:

- **The quality tags change.** NoobAI learned a different booru vocabulary:
  `masterpiece, best quality, newest, absurdres, highres` on the positive side,
  and `old, early, normal quality` added to the negative. `newest` and the
  recency terms are tags the other XL checkpoints never saw, and `very
  aesthetic` is one NoobAI does not have. (`very awa` is its aesthetic push —
  deliberately not automatic, since it is a style choice rather than a floor.)
- **The sampler changes.** A v-prediction checkpoint predicts *v* rather than
  noise, and the SDE and DPM++ samplers can diverge on it — the failure is a
  burnt or washed-out image, not an error. So the block lands on `Euler a`
  unless it already names a Euler variant. The notes say which happened.

**The mode itself is the webui's job, and not every build does it.** The file
carries `v_pred` as a non-weight tensor in its header — `inspectCheckpoint`
reads it from the same parse that identifies the architecture, so it costs no
extra I/O — and the script warns when it finds one.

Take that warning seriously. Forge builds before mid-2025 read `v_pred` through their vendored
`huggingface_guess` and then called nothing with the answer, taking the
predictor from the diffusers scheduler config of
`stable-diffusion-xl-base-1.0` — `epsilon` — so every SDXL was sampled as
epsilon. Current builds map it in `backend/loader.py`.

The symptom, if the build is old: saturated red-and-blue noise, no error, every
setting correct-looking. The way out is updating Forge or using an
Epsilon-pred release of the same model.

CFG stays at 5, which is inside NoobAI's recommended 4-6.

## Close with these, but only when the migration crossed into SDXL

The notes will say whether it did. On a same-architecture move they are noise.

- **Clip skip is enforced by the extension.** Forge's `on_preset_change` is
  wired to `root_block.load` and stamps clip skip back to 1, sometimes seconds
  after the paste — the extension now watches for ~12s and puts the block's
  value back, logging `clip skip re-asserted` when it had to. Only mention it
  if the user reports a wrong clip skip anyway (an outdated extension: run
  `pnpm setup:forge` and reload the tab).
- **"Apply settings" reverts the checkpoint** to whatever the Settings page was
  built with. Re-run this, or re-select the model, after using it.

## Requirements

- Forge running with the `luma-vault-prefill` extension (`pnpm setup:forge`).
  The script needs `/luma/v1/checkpoints` and `/luma/v1/checkpoint`, which
  Forge's own API cannot substitute for — see the extension README.
- `LUMA_FORGE_URL` overrides the default `http://127.0.0.1:7860`.

If the script fails because Forge is unreachable, say so plainly rather than
retrying.

## Editing the rules

The transformation lives in `packages/core/src/migrate.ts` with tests beside it.
Change it there, not in the script — the script is I/O only. `pnpm -r test`
covers it.
