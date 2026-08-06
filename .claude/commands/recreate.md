---
description: Turn an attached image into a danbooru prompt, tune the body shape, and open it prefilled in Forge
argument-hint: [model — defaults to deliberate]
---

# Recreating an attached image as a prompt

The user attaches an image found somewhere — the web, another gallery — and
wants a prompt that would generate something like it on a modern booru-trained
checkpoint. There is no parameter block to migrate; **you are the extractor**.
Look at the image, write the tags, ask about body proportions, then hand the
result to the script.

If no image is attached, ask for one — nothing else here works without it.

## 1. Read the image into danbooru tags

Booru models learned *exact tag strings*, so near-misses carry nothing —
"large ass" produces less than `huge ass` because only one of them is a tag.
Derive, in this order:

- **Subject**: `1girl`, `solo`, `2girls`, … Count what is actually there.
- **Character**: if you recognise them, the exact danbooru form —
  `aqua (konosuba)`, `misato katsuragi` — plus their signature features
  (hair colour/length/style, eye colour) so the model is anchored even where
  the character tag is weak. If unrecognised, describe instead; never guess a
  name you are not confident of, a wrong character tag drags the whole image.
- **Framing**: the ladder is `close-up → upper body → cowboy shot → full body
  → wide shot`. Also `from behind`, `from side`, `from above`, `from below`,
  `looking at viewer`, `looking back`. Body-part *focus* tags (`ass focus`)
  are camera instructions — use them only when the image really is framed on
  that part.
- **Pose**: `standing`, `sitting`, `lying`, `kneeling`, `bent over`,
  `top-down bottom-up`, `arms up`, `hand on hip`, …
- **Outfit**: garment by garment, with state — `skirt lift`, `clothes pull`,
  `bikini under clothes`, `detached sleeves`, `bare shoulders`.
- **Setting and light**: `outdoors`/`indoors`, the place, `day`/`night`,
  `sunlight`, `backlighting`, `scenery` when the environment matters.
- **Style**: `realistic` for semi-real rendering, `anime coloring` the other
  way; photographic sources usually want `realistic, photorealistic`.

## 2. Ask about body shape and the shot — always, and before composing

Use the AskUserQuestion tool. This is the point of the skill: the user tunes
proportions and framing away from the source image, and "as seen" is a real
answer on every axis. **First call, four questions**, single-select:

| Question | Options |
|---|---|
| Ass | as seen · `big ass` · `huge ass` · `gigantic ass` |
| Breasts | as seen · `large breasts` · `huge breasts` · `gigantic breasts` |
| Thighs | as seen · `thick thighs` · `(thick thighs:1.4)` · `(thick thighs:2)` |
| Hips | as seen · `wide hips` · `(wide hips:1.4)` · maximum |

Thighs have one real tag, so their boost is baked into the ladder. Hips too —
but their top rung, **maximum**, is not a weight. It is this exact combo,
pasted verbatim into the body slot:

```
(wide hips:2), (thick thighs:2), (curvy:2), (narrow waist:2), (hyper hips:2), hip focus
```

The combo already argues the thighs at 2, so when maximum is picked, drop
whatever the thighs question answered rather than doubling the tag — one
term per concept, never a tug of war.

Ass and breasts have real rungs, so boosting is a **second call**, which
always happens because it also carries the shot:

| Question | Options |
|---|---|
| Shot | as-is · `cowboy shot` · `full body` · `wide shot` |
| Ass boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |
| Breast boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |

Boosts apply as `(huge ass:1.3)`; `:2` is the tested ceiling — past it the
weight warps anatomy without adding size. Axes answered "as seen" get no
boost question. "As-is" keeps the framing you read off the image in step 1. The
ladder has more rungs than the four buttons — `close-up`, `portrait`,
`upper body`, `lower body`, `very wide shot` — and any of them typed under
Other is a valid answer too. A shot pick *replaces* the rung you extracted —
never keep two rungs, they fight.

A wide pick (`full body` or wider) needs more than the bare tag to win,
because every body tag pulls the camera in — the easiest way to draw
gigantic hips is to fill the frame with them. Four moves, all of them:

- Write the rung weighted — `(full body:1.3)`, `:1.5` when the body tags run
  heavy.
- Take the wide backstop in the negative (step 3).
- Name footwear in the outfit chunk — `high heels`, `boots`, `feet` when
  bare. The model zooms out to draw what it must include.
- Leave `hip focus` off the end of the maximum combo. It is a camera
  instruction, and it drags the crop back to the hips — it is for as-is and
  tight shots only.

"As seen" means: tag what the image shows, at whatever rung it actually shows
it, unweighted.

## 3. Compose

Structure the prompt with `BREAK` between concept groups. CLIP encodes 75
tokens per chunk, and these prompts run past that — without BREAK the second
chunk starts at an arbitrary comma, splitting a concept mid-thought. BREAK
chooses the boundary and gives each group a fresh chunk with full attention,
which is also what stops hair colour bleeding into the outfit. Write it as
`
` in the `--prompt` argument (the script expands it — real newlines do not
survive pnpm on Windows):

```
<quality, style, framing>
BREAK
<subject, character, body>
BREAK
<outfit, pose>
BREAK
<setting, light>
```

Order matters — earlier tags carry more weight, within each chunk:

1. Quality block, verbatim:
   `masterpiece, best quality, amazing quality, very aesthetic, absurdres`
2. Style tags (`realistic`, …)
3. Framing
4. Subject and character
5. Body tags from the answers
6. Outfit, pose
7. Setting and light

Negative, verbatim baseline (matches `XL_NEGATIVE` in
`packages/core/src/migrate.ts` — keep them agreeing):

```
worst quality, low quality, lowres, bad anatomy, bad hands, missing fingers,
extra digits, jpeg artifacts, signature, watermark, username, artist name
```

Add `close-up, cropped, portrait, upper body` to it only when the
composition — after the shot answer — is `full body` or wider; they are the
backstop against the model drifting tight. If results still crop at the
thighs, add `cowboy shot` too.

## 4. Open Forge

```bash
pnpm open-in-forge --prompt "..." --negative "..."   --adetailer-prompt "..." --width W --height H
```

Always pass `--adetailer-prompt`: a short face pass in ADetailer's own jargon —
`masterpiece, best quality, detailed face, beautiful detailed eyes,` followed by
the *identity* tags you derived (character, hair, eyes, expression, headwear).
Never body, pose or setting tags: the pass repaints a head crop, and a body tag
inside it re-argues the body in a space where it cannot win. The script adds
the rest — Hires fix (1.65x, 30 steps, 4xUltrasharp, denoise 0.4) and the
ADetailer model — to every block, and the extension turns both toggles on.

- Canvas from the **attached image's aspect**: portrait → `832 1216`,
  landscape → `1216 832`, square → `1024 1024`.
- Pass `--model $ARGUMENTS` only when the user named one; the script defaults
  to `deliberate` on its own.
- The script resolves the newest matching checkpoint, warns if it is not XL,
  selects it in Forge *before* the tab opens, and fills everything via the
  prefill extension. Settings are fixed at the booru-XL tuning (CFG 5,
  28 steps, clip skip 2, random seed), with Hires fix and an ADetailer face
  pass always in the block.

Then show the user the prompt you composed, with one line on anything you
were unsure of — a character you almost recognised, an outfit detail you had
to approximate. Those are the lines they will want to edit.

## AniVerse

Pass `aniverse` and the commands switch to what **your own library** says this
family wants, rather than the booru-XL defaults. Measured over the 1,806
AniVerse images rated four or better here:

| | AniVerse | everything else |
|---|---|---|
| CFG | **7** (1,795 of 1,806) | 5 |
| Steps | **40** (50 measured, trimmed for XL) | 28 |
| Sampler | **DPM++ SDE Karras** (1,220) | DPM++ 2M SDE Karras |

That gap is the whole reason a prompt through this family came back looking
like several different models: it was being generated at another model's
tuning.

The quality prefix changes too, to the one 379 of those images open with:

```
(best quality, masterpiece, perfect face, beautiful and aesthetic:1.2, colorful, dynamic angle, highest detailed face)
```

It is asking for different things from the booru set — `perfect face` and
`highest detailed face` are about rendering, `dynamic angle` is composition.

The negative comes from the same images, minus two things. `EasyNegative` and
`bad-hands-5` are SD1.5 **embeddings** and become literal words on SDXL.
`(realistic:1.0)` is dropped less obviously: a tag's job depends on what the
checkpoint renders by default, and negating it on a model that is already flat
gives cel shading rather than the soft look it was reaching for. Add it by hand
if the target turns out to render hard.

`--cfg` overrides the tuning when you want to explore.

## When the model is NoobAI

If the user names `noob` (`--model noob`), the checkpoint is NoobAI-XL and the
quality block above is the wrong vocabulary. Swap it:

Positive, still verbatim and still first:

```
masterpiece, best quality, newest, absurdres, highres
```

Negative baseline:

```
worst quality, low quality, normal quality, old, early, lowres, bad anatomy,
bad hands, mutated hands, missing fingers, extra digits, jpeg artifacts,
signature, watermark, username, artist name
```

`newest` and the `old, early` pair are recency tags NoobAI was trained with and
the other XL checkpoints never saw; `very aesthetic` is not one of its tags.
`very awa` is its aesthetic push — add it only if the user asks for a stronger
look, not by default.

Everything else about composing the prompt is unchanged: same danbooru tags,
same BREAK structure, same body questions.

**The v-pred release needs a Forge that supports it — check before promising
anything.** The script reads `v_pred` out of the checkpoint's header, writes
`Euler a` instead of `DPM++ 2M SDE`, and prints a warning. That warning is not
boilerplate: the *sampler* is all a parameter block can carry, and the
prediction *mode* is the webui's to apply.

Forge builds before mid-2025 read `v_pred` through their vendored
`huggingface_guess` and then called nothing with the answer, taking the
predictor from the diffusers scheduler config of
`stable-diffusion-xl-base-1.0` — `epsilon` — so every SDXL was sampled as
epsilon. Current builds map it in `backend/loader.py`.

The symptom on an old build: saturated red-and-blue noise, no error raised, and
every setting in the block looking correct.

So if the user is on such a build, steer them to an **Epsilon-pred** NoobAI
release (1.1 or 1.0) — the prompt vocabulary above is identical — or to
updating Forge. Do not tell them it is handled.

## Close with these, always

The tab always opens on an XL model here, so both caveats always apply:

- **Clip skip is enforced by the extension** — it re-asserts the block's value
  against Forge's preset-on-load stomp for ~12s. Only mention it if the user
  reports it wrong anyway (outdated extension: `pnpm setup:forge`, reload).
- **"Apply settings" reverts the checkpoint** to whatever the Settings page
  was built with. Re-select the model after using it.

## Requirements

- Forge running with the `luma-vault-prefill` extension (`pnpm setup:forge`).
- `LUMA_FORGE_URL` overrides the default `http://127.0.0.1:7860`.

If Forge is unreachable, say so plainly rather than retrying. `--dry-run`
prints the block without touching Forge, for checking the composition first.
