---
description: Migrate a generated image's prompt onto a newer checkpoint and open it in Forge
argument-hint: <image> [model — optional; otherwise you are asked]
---

# Migrating a generation to a newer model

`/recreate <name>` now takes the same input, and the two do different things
with it. **This one migrates the block**: the sampler, hires pass, ADetailer
settings and ControlNet the original carried all come across, and the prompt is
edited in place. `/recreate` throws the block away and writes a fresh
BREAK-structured prompt from the picture, keeping only the words. Reach for
that one when the original prompt is thin or badly structured; reach for this
one when the generation was good and only the model should change.

## 1. Ask who it is, and which model — before looking at anything

One `AskUserQuestion` call, two questions, both single-select. It comes first
because both answers change the work that follows and neither needs the picture.

### The character question

**Read `.claude/character-tags.md`** — it carries the question, the lookup
against the tagger's own vocabulary, and what to do with each kind of answer.
The short version: the user usually knows who this is, and recognising a
character from a picture is the least reliable thing this command does.

It matters more here than the name suggests. This command migrates a prompt
that already exists, and step 2 is largely about what that prompt *fails* to
say — an img2img block routinely names nobody at all while the picture is
plainly someone. A name given here goes into `--add` as the character tag,
which is often the single most valuable thing that flag carries.

If the original prompt already names a character correctly, say so and leave it
where it is: it is in front, where its weight is, and `--add` drops anything
already present rather than repeating it.

Optional, and no answer is a normal answer.

### The model question

| Question | Options |
|---|---|
| Model | `deliberate` (Recommended) · `wai` · `aniverse` · `noob` |

All four are substrings, matched against the checkpoints actually installed,
newest first — so is anything typed under Other, which is how you reach a
checkpoint not on this list. `deliberate` is the script's own default and stays
the recommendation; `wai` (waiNSFWIllustrious) has by far the best record on
this vault's own 4+ ratings, so it is worth offering rather than burying.

`deliberate`, `wai` and `hassaku` are all Illustrious and take identical
settings; `aniverse` and `noob` each need their own tuning, which the script
applies from the checkpoint rather than from what was typed. The answer becomes
the **second positional argument** — `pnpm migrate-prompt 00489 wai` — not a
flag.

**Drop this half of the call when the user already named a model**, as `/sdxl
00489 aniverse` does. Unlike `/recreate`, whose argument slot is the image, this
command still takes a model positionally; a model typed there is an answer
already given, and asking it back is friction. The character question is asked
either way — the call happens, it just carries one question instead of two.

## 2. Look at the picture, not only at its prompt

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

Do not note the aspect. The canvas is `832x1216` on every run, whatever shape
the source was — see step 4.

## 3. Ask again — before running anything

The same questions `/recreate` asks, in the same order, with the same ladders.
**Two more calls**, all single-select — the tool caps a call at four questions,
and the boosts in the last one need the room.

These wait for step 2 where call 1 could not: the body ladders read against what
the picture already shows, and the shot question's "as-is" is whatever framing
its prompt already carries.

### Call 2 — the four body axes

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

### Call 3 — the shot, the boosts and the style

Always happens, because it carries the shot and the style whatever the body
answers were:

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


#### The style question, in that same third call

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

## 4. Migrate, but do not send yet

```bash
pnpm migrate-prompt <image> <model> --dry-run
```

`--dry-run` runs the whole migration and prints the block it would send —
selecting no checkpoint and opening no tab. (It still needs Forge up: the
checkpoint list and the emphasis setting come from its API.) Step 5 is what
that print is for.

The image is `$ARGUMENTS` unchanged; the model is call 1's answer, or the one
the user typed themselves when they did.

The answers ride on flags, and all of them are optional:

| Flag | From |
|---|---|
| `--add "<tags>"` | steps 1 and 2 — the character, and what the picture shows that the prompt never said |
| `--shot "<tag>"` | call 3, unless the answer was as-is |
| `--body "<tags>"` | call 2 and 3 — the rungs with their boosts, or the maximum combo |
| `--style 2d\|2.5d\|3d` | call 3, unless the answer was as seen |

```bash
pnpm migrate-prompt 00301 wai --dry-run \
  --shot "full body" --body "(gigantic ass:1.5), (wide hips:1.4)"
pnpm migrate-prompt 00489 deliberate --dry-run \
  --add "mano aloe, black dress, gold trim, garter straps, black thighhighs, demon tail"
```

`--add` goes at the *end* of the prompt, behind whatever the person originally
wrote, and drops anything already there rather than saying it twice.

**The canvas is `832x1216` on every run, and you never pass it.** The source's
shape is an accident of whatever it came from — an img2img chain that passed
through a square crop, a wallpaper someone saved — not a request for that
shape, and a body-tuned prompt on a landscape canvas crops at the waist and
throws away everything the body questions just asked for. `--size WxH` still
overrides it, snapped to the nearest SDXL bucket, but only reach for it when
the *user* asks for another canvas in words.

The rewrite puts both at the front of the prompt where they carry the most
weight, and clears what they replace: every framing rung the prompt already
carried (two rungs in one prompt fight, and the result is neither), and every
size rung of each body axis the override mentions. `full body` and wider go
in weighted — `(full body:1.3)`, because bare they lose to body tags pulling
the camera in — and the negative gains `close-up, cropped, portrait,
upper body` as the backstop against drifting tight. All reported in the
notes.

Both positional arguments are substrings — `00301` finds the image,
`illustrious` finds the newest installed checkpoint whose filename contains it.
The model stays optional *to the script*, which defaults to `deliberate` on its
own; that default is now the backstop rather than the normal path, because call
1 asks.

## 5. Show it, and offer the last look

**Nothing has been sent yet, and this is the only moment the prompt is still
free to change.** Once the tab is open the text is in Forge's box, and fixing it
there means retyping it by hand.

So show the dry run's prompt, then make a **fourth AskUserQuestion call** — one
question, because this prompt has no BREAK chunks to split along:

| Question | Options |
|---|---|
| The prompt below the first line | Send as migrated · Drop the tags `--add` appended · Restore the original wording |

Put the editable text in the option `preview` so the user is judging the real
thing rather than a description of it, and phrase the question so the escape is
obvious — "…or choose Other and type what you want instead."

**The first line is not editable, and that is what the split is for.** The
migration puts the framing rung and the body tags on their own leading line,
ahead of everything the person originally wrote — see the rewrite notes. Those
are not description; they are call 2 and call 3's answers, weighted and
deduplicated against the rungs already in the prompt. Hand-editing them is how a
prompt ends up carrying two framing rungs that cancel. A framing or body change
is those questions asked again, which means re-running step 4.

### Sending it

```bash
pnpm migrate-prompt <image> <model> <the same flags> --prompt "<the whole prompt>"
```

Three things about that flag, each of which silently ruins the result if missed:

- **`--prompt` replaces the entire positive prompt, first line included.** So
  re-attach that leading line verbatim in front of the user's text. Dropping it
  throws away the framing and body answers with nothing saying so.
- **Newlines are written `\n`.** pnpm on Windows cannot carry a real newline
  through an argument. The script expands the escape.
- **Repeat every flag from step 4.** The run migrates from scratch; the block is
  rebuilt, not resumed, and a `--shot` left off the second run is a shot that
  never happens.

When the answer was "Send as migrated", re-run without `--prompt` — passing back
text identical to the proposal is harmless (the script notices and says nothing)
but the flag is just noise.

The face pass follows the edit on its own. `ADetailer prompt` is derived from
the approved text rather than the proposed one, so an edit that renames the
character re-derives it — no separate flag, and nothing to remember.

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
7. Stops there under `--dry-run`, printing the block it would have sent.
8. Applies `--prompt` over the rewritten prompt, if one came back from step 5.
9. Selects the checkpoint in Forge **before** opening the tab.
10. Opens the tab; the prefill extension fills every field.

## The rewrite, when crossing SD1.5 → SDXL

| Change | Why |
|---|---|
| LoRA tags removed | SD1.5 LoRAs have the wrong text-encoder dimensions; they are parsed, matched against nothing, dropped |
| SD1.5 embeddings removed | `EasyNegative` on SDXL is not an embedding, it is the words "easy negative" steering the image |
| Danbooru quality tags added | what booru-trained SDXL models were trained to expect |
| Size → `832x1216` | the portrait bucket, always; SDXL trained at ~1MP, and an SD1.5 canvas gives distorted anatomy rather than a smaller image |
| Hires factor recomputed | keeps the final resolution the original aimed at, since the factor is a multiple of a canvas that just changed |
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

## Illustrious checkpoints — `hassaku`, `deliberate`, `illustrious`

`hassaku`, `perfectdeliberate` and `waiNSFWIllustrious` are **all Illustrious
checkpoints**, so all three get the same treatment — the split that used to put
`deliberate` on the generic XL defaults was an accident of its name, not a fact
about the model. Both commands send what the Illustrious guidance asks for:

| | Illustrious | the plain XL default |
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

**Shortcut: `illu`.** The model argument is a substring match, so `illu` — typed
under call 1's Other, or straight into the command — finds every Illustrious
checkpoint installed and takes the newest by file date. Name one specifically —
`hassaku`, `deliberate`, `wai` — when you want that one rather than the latest.

**Switching between them needs no new command.** Because every Illustrious
checkpoint gets the same quality tags, negative, sampler, CFG and steps, a
block written for one is already correct for all of them: change Forge's
Checkpoint dropdown and generate again. Nothing else in the tab has to move.

That does *not* hold across families. `noob` wants different quality tags,
`aniverse` needs its trigger and a different sampler and CFG — so switching to
either means re-running the command rather than swapping the dropdown. And the
checkpoint is global in Forge, so the dropdown moves it for every tab, not just
the one in front of you.

`perfectdeliberate`'s own card asks for CFG 5-8 where the Illustrious guides say
4.5-5, so `--cfg 6` is worth a try there when a render looks flat.

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


### While a batch is running

Both scripts **refuse to switch the checkpoint** if Forge is mid-generation,
and say so. This is not politeness: the checkpoint is a global setting and
`modules/processing.py` calls `forge_model_reload()` *inside* the batch loop,
so every iteration re-resolves the model from that global. Selecting one while
a batch runs changes the model out from under it and the rest of the batch
comes out in another style — no error, just images quietly not being what was
asked for.

The tab still opens either way. Its block names the model, so the switch
happens when that tab generates, which is after the batch anyway. Say so when
reporting: the dropdown will show the running batch's model until then.

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
