---
description: Turn an image — attached, or already in the vault — into a danbooru prompt, tune the body shape, and open it prefilled in Forge
argument-hint: [image name — or attach one] [bg — render in the background]
---

# Recreating a picture as a prompt

Someone wants a prompt that would generate something like a picture they
already have, on a modern booru-trained checkpoint. **Two ways in, and they
meet in the same place:**

- **An attached image** — found on the web, in another gallery. There is no
  parameter block anywhere, so **you are the extractor**: look at it, write the
  tags, ask the questions, hand the result to the script.
- **An image name as the argument** — `/recreate 00489`, a picture already in
  this vault. `/sdxl`'s input running `/recreate`'s flow. It *has* a parameter
  block, and reading it is most of the extraction already done — so here the
  original prompt is the spine and the answers below **adjust** it, rather than
  a prompt being written from nothing.

If neither is given, ask which — nothing else here works without a picture.

**The argument is an image name, not a model.** The model used to live in that
slot; it is now part of the first question you ask (step 1), because it is a
choice worth putting in front of someone rather than defaulting silently. If the
name finds nothing in the index, say so — do not quietly reinterpret it as a
checkpoint.

## 1. Ask who it is, and which model — before looking at anything

One `AskUserQuestion` call, two questions, both single-select. It comes first
because both answers change the work that follows and neither needs the picture.

### The character question

**Read `.claude/character-tags.md`** — it carries the question, the lookup
against the tagger's own vocabulary, and what to do with each kind of answer.
The short version: the user usually knows who this is, recognising a character
from a picture is the least reliable thing this command does, and one word from
them removes the guess. Asked *before* step 2 because the answer is what the
extraction is anchored on; asked afterwards it would only confirm a guess
already baked into the tags.

Optional, and no answer is a normal answer.

### The model question

| Question | Options |
|---|---|
| Model | `noob → delburry75` (Recommended) · `delburry75` · `wai` · `delnoob` |

**The first option is two checkpoints, not one.** `noob → delburry75` means
`--model vpred --refiner delburry75 --refiner-switch 0.5`: NoobAI-XL composes the
first half of the steps and decides what is in the frame, delburry75 paints the
second half. The user picked it over every single checkpoint on 2026-09-06
("pretty nice approach, keep that as selection for all commands") after four
Oracle sets side by side — it is the only build that hangs a loose garment
without inventing a belt and still has delburry's finish. The other three are
plain substrings matched against the checkpoints actually installed, newest
first — so is anything typed under Other, which is how you reach `deliberate`,
`hassaku`, NoobAI alone (`vpred`) or a checkpoint not on this list. `delnoob` is
the 50:50 merge of delburry75 and NoobAI epsilon, belting about half the time. `wai` (waiNSFWIllustrious)
has by far the best record on this vault's own 4+ ratings and stays offered.
**Write the composing model as `vpred`, not `noob`.** Substrings resolve newest
file first, and since the `delnoob` merge (2026-09-06) `noob` finds *that*; `vpred`
is the only substring that still lands on `noobaiXLNAIXL_vPred10Version`, the build
every measurement above was made on. Four options is the tool's cap, which is why `deliberate` and `hassaku` moved
to Other.

`deliberate` and `wai` are both Illustrious and take identical
settings; `hassaku` and `noob` each need their own tuning, which the script
applies from the checkpoint rather than from what was typed. Pass the answer
through as `--model <answer>` — or, for the first option, as the three flags above.

## 2. Read the image into danbooru tags

### When a name was given, look it up first

```bash
pnpm migrate-prompt <name> --show
```

Prints the file's **path**, its parameter block, and — for an img2img — what it
was made from and that one's prompt. It opens nothing and never contacts Forge,
so it works with Forge closed. The name is a substring: `00489` finds it.

**Then open the file it names and look at it.** The block is evidence, not a
description. An img2img keeps its subject in the *init image*, which no PNG
carries, so a twelve-word prompt about hair and eyes routinely belongs to a
picture of a named character in a full outfit — and the ancestor's prompt that
`--show` prints can just as confidently name someone who was replaced two
passes ago. Read both against what you can actually see; take what the picture
confirms, drop what it does not.

Now derive the tags below **from the picture, with the original prompt as the
spine**: what it already says stays, in its own words and in front where its
weight is, and what the picture shows that the prompt never said goes behind
it. The output is that prompt adjusted by the answers in step 3 — not a
replacement written over the top of it.

### Either way, the vocabulary

Booru models learned *exact tag strings*, so near-misses carry nothing —
"large ass" produces less than `huge ass` because only one of them is a tag.
Derive, in this order:

- **Subject**: `1girl`, `solo`, `2girls`, … Count what is actually there.
- **Character**: step 1's answer, resolved to the exact danbooru form and
  written escaped — `aqua \(konosuba\)`, `katsuragi misato` (family name
  first, which is how danbooru writes them and not how anyone says them) —
  plus their signature features (hair colour/length/style, eye colour) so the
  model is anchored even where the character tag is weak. When step 1 left it
  to you: recognise them if you confidently can, describe them if you cannot.
  Never guess a name you are not confident of — a wrong character tag drags the
  whole image, which is why the question is asked in the first place.
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

## 3. Ask again — always, and before composing

Use the AskUserQuestion tool. This is the point of the command: the user tunes
the proportions and the framing away from the source image, and "as seen" is a
real answer on every body axis. **Two more calls**, all single-select — the tool
caps a call at four questions, and the boosts in the last one need the room.

These wait for step 2 where call 1 could not: the body ladders read against what
the picture already shows, and the shot question's "as-is" is whatever framing
you just extracted.

### Call 2 — the four body axes

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
(wide hips:2), (thick thighs:2), (curvy:2), (narrow waist:2), hip focus
```

The combo already argues the thighs at 2, so when maximum is picked, drop
whatever the thighs question answered rather than doubling the tag — one
term per concept, never a tug of war.

### Call 3 — the shot, the boosts and the style

Ass and breasts have real rungs, so boosting waits for this call, which always
happens because it also carries the shot and the style:

| Question | Options |
|---|---|
| Shot | as-is · `cowboy shot` · `full body` · `wide shot` |
| Ass boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |
| Breast boost — only if a plain rung was picked | no boost · `:1.3` · `:1.5` · `:2` |

Boosts apply as `(huge ass:1.3)`; `:2` is the tested ceiling — past it the
weight warps anatomy without adding size. Axes answered "as seen" get no
boost question. "As-is" keeps the framing you read off the picture — and, when
a name was given, whatever framing rung its own prompt already carried. The
ladder has more rungs than the four buttons — `close-up`, `portrait`,
`upper body`, `lower body`, `very wide shot` — and any of them typed under
Other is a valid answer too. A shot pick *replaces* the rung you extracted —
never keep two rungs, they fight.

A wide pick (`full body` or wider) needs more than the bare tag to win,
because every body tag pulls the camera in — the easiest way to draw
gigantic hips is to fill the frame with them. Four moves, all of them:

- Write the rung weighted — `(full body:1.3)`, `:1.5` when the body tags run
  heavy.
- Take the wide backstop in the negative (step 4).
- Name footwear in the outfit chunk — `high heels`, `boots`, `feet` when
  bare. The model zooms out to draw what it must include.
- Leave `hip focus` off the end of the maximum combo. It is a camera
  instruction, and it drags the crop back to the hips — it is for as-is and
  tight shots only.

"As seen" means: tag what the image shows, at whatever rung it actually shows
it, unweighted.


#### The style question, in that same third call

Ask it every time, alongside the shot. It is the axis with the largest visible
effect on the result and the least obvious controls:

| Question | Options |
|---|---|
| Style | as seen · `2D` · `2.5D` · `3D` |

Pass the answer as `--style 2d`, `--style 2.5d` or `--style 3d`; "as seen"
passes nothing.

- **2D** — flat anime. `anime coloring, flat color`.
- **2.5D** — soft semi-real anime. `realistic`, arguing against `flat color,
  anime coloring, photorealistic`.
- **3D** — rendered. `photorealistic, realistic`, arguing against `anime
  coloring, flat color, lineart, sketch`.

2.5D and 3D both assert `realistic`; the only difference between them is
whether `photorealistic` is asked for or argued against. That single tag is
what separates a soft anime-shaded figure from a rendered one.

**No style asserts `shiny skin` any more, and every style negates it** along
with `oiled body, wet, sweat, glossy, specular highlights, reflection, light
particles, sparkle, bloom, lens flare, sunbeam`. That tag is what draws
ring-shaped specular blobs across large smooth skin — half a dozen per frame on
a body-tuned render — and having it in the positive *silently defeats negating
it*, so a prompt that lists it in both places argues with itself and the blobs
stay. Removing it costs nothing: the skin still reads soft and lit, and it now
holds its own gradients instead of being covered by a plastic highlight layer.
Ask for light in the **setting** instead — `(overcast:1.3), cloudy, soft
lighting, diffused lighting` — which is what produced the best-lit set so far.

**Do not hand-write these tags.** The obvious words for this axis are mostly
not danbooru tags at all — `3d`, `cel shading`, `soft shading`, `glossy skin`
and `detailed skin` are all absent from the 10,861 names in
`models/anime-tagger/selected_tags.csv`, so a prompt asking for them is asking
in a language the model never learned. The flag applies the checked set and
clears whatever competing rendering tag the prompt already had.

## 4. Compose

"The original prompt is the spine" means its *content words* — the character,
the outfit, the setting it names. Its structure is not preserved: the quality
block below is written verbatim whatever the original opened with, the chunks
are rebuilt, and each tag moves to the group it belongs in. Its own quality
words (`ultra-detailed`, `Pretty Face`, `illustration`) are dropped rather than
stacked on top — they are SD1.5 vocabulary, and two quality blocks argue.

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

**And when she is dressed over the hips and any ass or hip tag is above `1`**,
add `impossible clothes, impossible dress, wedgie, taut clothes, taut dress,
skin tight, tight clothes, cameltoe`. Otherwise a rear or low frame comes back
with the skirt shrink-wrapped into the crease — the `impossible clothes` effect,
which is a real tag and therefore a real negative. The rule and its counts live
in `.claude/shot-tags.md` ("A dressed rear shot moulds the fabric…"); skip it
when the hips are bare or the outfit is a skin-tight one-piece by design.

**When a name was given, the original's negative is not pasted through.** Start
from the baseline above and carry over only terms that state something it does
not — `censored`, a specific unwanted object. Two kinds never come across:

- **Terms that fight the answers.** SD1.5 negatives routinely carry `fat,
  chubby, curvy` against that model's doughiness. Left in beside a body answer
  asking for `gigantic ass` the negative usually wins, and the render comes
  back slim with nothing saying why.
- **SD1.5 embeddings** — `EasyNegative`, `bad-hands-5`, `badhandv4`. On an XL
  model they are not embeddings, they are the literal words, which is the
  opposite of what they were doing.

## 5. Show it, and offer the last look

**Nothing has been sent yet, and this is the only moment it is still free to
change.** Once the tab is open the prompt is in Forge's box, and fixing it there
means retyping it by hand — the extension fills the field once and the command
would have to be re-run to fill it again.

So print the composed prompt first, chunk by chunk and labelled, then make a
**fourth AskUserQuestion call**. Three questions, single-select, each carrying
that chunk's composed text in the option `preview` so the user is judging the
real thing rather than a description of it:

| Question | Options |
|---|---|
| Character & body — chunk 2 | Keep as composed · Soften the body tags one rung |
| Outfit & pose — chunk 3 | Keep as composed · Simplify to the main garment |
| Setting & light — chunk 4 | Keep as composed · `simple background` instead |

Phrase each question so the escape is obvious — "…or choose Other and type the
chunk you want." **Free text replaces that chunk verbatim.** Do not tidy it, do
not re-order it into the house style, do not re-add a tag you think they
dropped: someone editing this chunk is overruling the extraction, which is
exactly the disagreement this step exists to settle. The one thing worth saying
back is if what they typed is not a danbooru tag — say it once, in the report
afterwards, and send it anyway.

**Chunk 1 is not offered, and that is deliberate.** Quality, style and framing
are not descriptions to taste — they are decided by the checkpoint family, the
style answer and the shot answer, and the rewrite rules that keep them from
fighting. Hand-editing them is how a prompt ends up carrying two framing rungs
that cancel, or a quality tag from a vocabulary this model never learned. A
framing change is the shot question in call 3, asked again.

Two things follow an accepted edit rather than being asked about separately:

- **Rebuild `--adetailer-prompt`** if the edit changed identity tags — the
  character, hair, eyes or expression. It is derived from those words, and left
  stale it repaints the head from a description that no longer matches.
- **Re-check the negative** against the edited body chunk. An edit that softens
  the body can leave `close-up, cropped, portrait, upper body` in the negative
  arguing for a width nothing now asks for.

Skip the whole call only when the user has already said to just send it.

## 6. Open Forge

```bash
pnpm open-in-forge --prompt "..." --negative "..."   --adetailer-prompt "..."
```

Always pass `--adetailer-prompt`: a short face pass in ADetailer's own jargon —
`masterpiece, best quality, detailed face, beautiful detailed eyes,` followed by
the *identity* tags you derived (character, hair, eyes, expression, headwear).
Never body, pose or setting tags: the pass repaints a head crop, and a body tag
inside it re-argues the body in a space where it cannot win. The script adds
the rest — Hires fix (1.5x, 30 steps, 4xUltrasharp, denoise 0.4) and the
ADetailer model — to every block, and the extension turns both toggles on.

- **The canvas is always `832x1216`, and you do not pass it.** Do not read it
  off the source. The shape of what someone happened to send, or of what an
  img2img chain happened to pass through, is not a request for that shape, and
  a body-tuned prompt on a landscape canvas crops at the waist and throws away
  everything the body questions just asked for. The script's default is
  portrait; leave `--width`/`--height` off entirely unless the *user* asks for
  another canvas in words.
- Pass `--model <the call 1 answer>`. `$ARGUMENTS` is the *image name* here and
  never goes to this flag; the script still defaults to `deliberate` on its own
  if the question somehow went unanswered.
- The script resolves the newest matching checkpoint, warns if it is not XL,
  selects it in Forge *before* the tab opens, and fills everything via the
  prefill extension. Settings are fixed at the booru-XL tuning (CFG 5,
  28 steps, clip skip 2, random seed), with Hires fix and an ADetailer face
  pass always in the block.

The prompt itself was already shown in step 5, so the report afterwards is the
things the prompt does not say: anything you were unsure of — a character you
almost recognised, an outfit detail you had to approximate — and any tag from a
free-text edit that is not in the tagger's vocabulary. Those are what someone
would otherwise only discover from a render that came back wrong.

When a name was given, say what *moved*: which of the original prompt's words
you kept, what the picture made you add, and which rung each answer replaced.
That diff is the whole point of running `/recreate` on a picture that already
had a prompt, and none of it is visible in the tab.

## `bg` — render in the background instead of opening a tab

**A bare `bg` anywhere in the arguments means: generate it and show the
picture, do not open Forge.** `/sdxl 00489 bg`, `/swap 00205 wai bg`,
`/recreate 00316 bg` — the token is never a model, because no installed
checkpoint contains those two letters, so it can sit in the model slot without
ambiguity.

What changes at the send step, and nothing else — every question, every rule
and the last look all happen exactly as written above:

```bash
<the same command> --render "<scratchpad>/<image>-<what-it-is>.png"
```

Then show it with `SendUserFile`, captioned with what was asked for.

Three things worth knowing:

- **It is safe while Forge is busy.** The checkpoint travels in
  `override_settings` per request rather than being selected globally, so the
  render queues behind whatever is running instead of changing the model out
  from under it. No need to check `/sdapi/v1/progress` first.
- **Forge saves its own copy** into its outputs with its own numbering, which
  is what puts the picture in the library. Write the `--render` file into the
  session scratchpad, not a watched folder, or it is indexed twice.
- **It takes two to four minutes** on this machine, and there is nothing on
  screen meanwhile. Say so before starting, or the wait reads as a hang.

`.claude/shot-tags.md` has the measurements behind all of this under "Getting
the shots rendered". `/shot` does not take `bg`: it already decides by count,
opening one or two as tabs and rendering three or more.

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

**Shortcut: `illu`.** `--model` is a substring match, so `illu` finds every
Illustrious checkpoint installed and takes the newest by file date. Name one
specifically — `hassaku`, `deliberate`, `wai` — when you want that one rather
than the latest.

**Switching between them needs no new command.** Because every Illustrious
checkpoint gets the same quality tags, negative, sampler, CFG and steps, a
block written for one is already correct for all of them: change Forge's
Checkpoint dropdown and generate again. Nothing else in the tab has to move.

That does *not* hold across families. `noob` wants different quality tags,
`hassaku` needs its trigger and a different sampler and CFG — so switching to
either means re-running the command rather than swapping the dropdown. And the
checkpoint is global in Forge, so the dropdown moves it for every tab, not just
the one in front of you.

`perfectdeliberate`'s own card asks for CFG 5-8 where the Illustrious guides say
4.5-5, so `--cfg 6` is worth a try there when a render looks flat.

## AniVerse

Pass `hassaku` and both commands switch to **AniVerse XL's own recommended
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

## When the model is NoobAI

When call 1 answered `noob` (`--model noob`), the checkpoint is NoobAI-XL and the
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
- `LUMA_FORGE_URL` overrides the default `http://127.0.0.1:7860`.

If Forge is unreachable, say so plainly rather than retrying. `--dry-run`
prints the block without touching Forge, for checking the composition first.
