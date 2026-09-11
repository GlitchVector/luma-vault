---
description: Build a progressive photo set of one character — dressed, then undressed, stage by stage
argument-hint: <character name | image name | attached image> [model] [bg]
---

# One character, one shoot, in stages

`/shotall` gives you every *angle* of one moment. This gives you one character
across a *sequence*: dressed and posing, then progressively less, each stage
keeping the same person, the same place and the same light so the set reads as
one shoot rather than a pile of unrelated renders.

**Three ways in, exactly as every other command here — the set is the same
whichever you use:**

- **A bare character name** — `/photoset thick miku hatsune`. No picture at all.
  The identity chunk is built from the character tag plus signature features, and
  the wardrobe is the character's *canonical* outfit — see step 2's "no image"
  path. This is the common case and must always work.
- **A vault image name** — `/photoset 00489`. An old generation already indexed;
  `pnpm migrate-prompt <name> --show` prints its block and path, and you read the
  file it names. `/recreate` step 2's spine-and-adjust flow.
- **An attached / clipboard image** — a picture dropped in with the message. No
  parameter block, so you are the extractor: look at it and write the tags.

Everything about extraction, the body ladders and the vocabulary checks is
`/recreate`'s; this one adds the **stage plan**, the **undress progression** and
the **pose rotation**. A bare token that is not a model and not a vault image
name is treated as a character name, never silently dropped — if a name finds
nothing and no image is attached, say so rather than inventing a subject.

**It does not carry a catalogue of sex acts.** The final stage exists and is
wired up, but the tags that fill it come from the user, verified against
`selected_tags.csv` and substituted mechanically — see step 6. Do not invent
them, do not expand a one-word request into a described scene, and do not add
acts that were not asked for.

## 1. Ask, before looking at anything

The same first call as `/recreate` — character and model, one
`AskUserQuestion`, both single-select. Read `.claude/character-tags.md` for the
character half; the model half is the same four options (the recommended one is the `noob → delburry75` refiner pair, three flags) and the same substring
matching.

Then **always ask about the shape** — it is never assumed, even when the user
typed a word like "thick" in the argument. One `AskUserQuestion` call, four
single-select questions:

| Question | Options (recommended first) |
|---|---|
| Thickness | **none** · `curvy, (wide hips:1.2), (thick thighs:1.2)` · `(curvy:1.3), (wide hips:1.6), (thick thighs:1.6)` · **maximum:** `(wide hips:1.8), (thick thighs:1.8)` + `<lora:thicc_slider_ixl_v12:1.0>` |
| Breasts | `large breasts` · `(large breasts:1.5)` · `(huge breasts:1.3)` · `(gigantic breasts:1.3)` — the rung that actually reads as huge; `(huge breasts:1.8)` still reads large |
| Hips / thighs | `wide hips` · `(wide hips:1.2)` · `(wide hips:1.4), (thick thighs:1.5)` · `(wide hips:2), (thick thighs:2), (curvy:1.5)` — the sheet-faithful rung for a curvy reference |
| Rear ass | `(huge ass:1.4)` · `(huge ass:1.6)` · `(huge ass:2)` |

**The recommended rung is the character's own build.** Three sets in a row came
out thick by default — the slider at 0.7 under `(huge breasts:1.3), (wide
hips:1.4), (thick thighs:1.5), (huge ass:2)` — because the heavy option led
every ladder and the slider was assumed. That is the wrong default: a
photostory is *of a character*, and the game's Eve or Lara is athletic, not
heavy. So the first option on every axis is now the one closest to the
character as drawn, the slider is off unless asked for, and the heavy rungs
are still one answer away for anyone who wants them. Front frames get the ass
tag at `1.2` regardless (§5), and the act stage halves whatever slider was
chosen, as before.

**The rear geometry's hips rise with its ass.** The hips answer is the *front*
rung. Rear-camera frames carry the heavier ass tag, and if the hips stay at the
front rung the ass balloons over hips that did not grow with it — the Ivy set's
"hips not the same size as her ass". So derive a rear shape: `(huge ass:1.6)`
pairs with `(wide hips:1.5), (thick thighs:1.4)`, `(huge ass:1.8)` with `(wide
hips:1.7), (thick thighs:1.5)`, and `(huge ass:2)` with `(wide hips:1.8),
(thick thighs:1.6)` — roughly the ass weight minus one tenth on the hips, minus
two on the thighs. `BODY_R` is built from that rear shape, `BODY_F` from the
answered one; the test back shot is where the pairing is checked.

**And the front hips never sit below the rear ass.** The user's standing rule
(2026-09-06): "front needs bigger hips, always, to match the always bigger ass
in back shots." A front frame whose hips are at the answered rung while the
rear frames carry `(huge ass:1.6)` shows a different woman from the front than
from behind. So the front hips are pinned to the rear ass weight or above —
`(huge ass:1.6)` behind means `(wide hips:1.7)` in `BODY_F` *and* `BODY_T`,
and the rear hips match at 1.7. The rear-shape derivation above then only
adds the thigh step. Ivy at 1.7 everywhere is the reference render.

**The slider is reserved for the top rung only.** Thickness climbs by *tags*
first — `curvy`, then the weighted hips and thighs — and
`thicc_slider_ixl_v12` enters only at the maximum, once
the tags are already at 1.8 and have nothing left to give. Below that rung it
is never loaded: it is a blunt global reshape, and on the three sets that
carried it at 0.7 under the standard tags the figure read heavy at every angle
whether the frame asked for it or not. Above 1.8, though, it is the only
instrument that still moves anything — a LoRA, not a tag.** A tag
names a *part* and only works when that part is in frame — which is why a
tag-only body reads thick from behind and thin from the front, the failure this
set spent an afternoon on. `thicc_slider_ixl_v12` is a weight-driven slider (no
trigger word) that reshapes the *body*, so it holds at every camera angle and
survives armour that would hide tag-driven mass. See §6's "The body is a LoRA".

Three things the ladders above deliberately no longer offer:

- **`gigantic ass` and `hyper hips` are not tags.** Neither exists in
  `selected_tags.csv`, so both were doing nothing wherever they appeared —
  including `/recreate`'s and `/sdxl`'s "maximum combo", now corrected.
  `.claude/shot-tags.md` still *reads* `hyper hips` when detecting a rung from
  an old block, which is right: old prompts contain it even though it is inert.
- **The waist is asked in the style call, not here.** `narrow waist` is on
  every frame regardless (the belly rule below); the *weight* is the question,
  and it lives in call 3 because this call is full. Under the slider the tag is
  redundant, so the maximum thickness rung keeps it unweighted whatever was
  answered.
- **The ass tag is asked once, for the rear.** It is not a front-frame size
  control — above roughly 1.4 it *overrides framing*, turning a `facing viewer`
  frame rear-on. Front frames get it at 1.2–1.3 and let the slider carry the
  shape; §5 freezes the two variants.

### The belly stays slim, whatever the rung

Thickness lives in the hips, thighs, breasts and rear — **never in the
stomach.** So every frame, on every rung, carries `narrow waist` in the
positive (at the weight the style call chose, `1` by default) and `plump, fat,
belly, big belly` in the negative. The negative half is a standing rule, not a
question; only the waist's weight is asked.

Two measured facts behind it. **`chubby` is not a tag** — it is absent from
`selected_tags.csv`, so putting it in the negative (the habit that led here)
was doing nothing on any run. And **`plump` (25,460) is the body-fat tag**:
until the Aerith set it sat in the *positive* of the second and third thickness
rungs, which is exactly where the soft, rounded stomach on those frames came
from. Thickness now climbs on `curvy` and the weighted hips/thighs alone, and
`plump` moves to the negative alongside the real fat tags — `fat` 9,309,
`belly` 12,513, `big belly` 3,709 — so the model is told which mass to remove
without touching the mass that was asked for.

What *not* to reach for: `abs` and `toned` flatten the stomach but harden the
whole torso (already negated for that reason), `skinny` thins the thighs with
it, and `flat stomach`, `slim`, `slim waist` and `toned stomach` are all absent.
`navel` (974k) and `midriff` (259k) draw a defined stomach well, but `midriff`
also *exposes* it — fine from stage 2 on, wrong on a dressed frame — so they
are not part of the standing rule.

Anything typed under Other on any axis is passed through verbatim. The answers
become the frozen `BODY_F` / `BODY_R` / `BODY_T` tags reused across every stage
(§5), plus the `SLIDER` / `SLIDER_ACT` pair — and the belly rule rides along in
every one of them.

**`BODY_T` carries the hips too.** The torso chunk is for the close-up, portrait
and upper-body frames, and it is tempting to leave the hips out because the
crop "does not show them". The model does not respect the crop: an outfit that
names the pelvis (`navel`, `thong`, `highleg`, `midriff`) pulls those frames
down to the hips, and a chunk with no hip tag and the waist at 1.5 renders them
narrow next to the full-body frames — the Ivy run-2 close-ups. So `BODY_T` is
the front hips and thighs with the waist one step *lower* than `BODY_F`, minus
only the ass tag. And when a character tag anchors the identity, its canon
build pulls against the answered rung: Ivy needed the front hips at 1.5 where
the archetype build had held at 1.3.

The **style** question is asked too, exactly as `/recreate` step 3 does. The
**shot** question is not asked: this command decides framing per stage.

### And ask about the waist — in the same call as the style

| Question | Options (recommended first) |
|---|---|
| Waist | `narrow waist` · `(narrow waist:1.5)` · `(narrow waist:2)` |

The unweighted tag is the belly rule's default and keeps the character's own
proportions. `(narrow waist:2)` is the **classic exaggerated build** — the one
the vault's older Aerith renders carry, paired with `(large breasts:1.5)`,
`(wide hips:2)` and `(thick thighs:2)` — and the two questions together are
how that look is asked for again: `(large breasts:1.5)` on the breasts ladder,
`(narrow waist:2)` here, and the heavy tag rung for thickness. It is a pinch,
deliberately: at `2` the waist goes to almost nothing between the ribs and the
hips, which is the point of that build and wrong for a character drawn
athletic. It is never combined with the slider — under the maximum thickness
rung the answer is ignored and the tag stays at `1`.

### And ask about the legs — in the same call as the style

| Question | Options (recommended first) |
|---|---|
| Leg length | `(long legs:1.2)` — the block's default · `(long legs:1.5)` · `(long legs:1.8)` · **max:** `(long legs:2)` — see *Leg length* in `.claude/shot-tags.md` for what a boost does to the framing |

The default keeps the character's own proportions. A boost lengthens the
legs *and* pulls the camera out: at `1.8` and `2` every cowboy and close-up
rung needs its framing word weighted to `1.4` and `full body, wide shot`
negated, or the frame drifts to a full-body shot on its own. The tag joins the
body chunk of every frame that shows hips and never changes for the set.

### And ask who *he* is — in the same call as the style

Every act frame carries a second person, and left undescribed he is re-rolled
every frame: white in one, purple and horned in the next when the character runs
a race LoRA. One question, single-select, folded into the style call:

| Question | Options |
|---|---|
| The partner | `muscular male` · `muscular male, dark-skinned male` · `mature male, muscular male` · `bara, muscular male` |

The answer joins the frozen `ID2` alongside `1girl, 1boy, hetero, solo focus,
faceless male`, and never changes for the rest of the set.

**And he is well endowed, on every act frame — moderately.** `large penis,
erection` joins `ID2` alongside the build: one size step above the model's
default, unweighted. The first version of this rule was `(large penis:1.3),
(huge penis:1.2), veiny penis, erection` and it was too much — `huge penis`
with the weighted `large` on top of it overshoots, and `veiny penis` adds a
girth that reads as grotesque at this size. Those stay available as an
explicit request, not as the default. The vocabulary has no `thick penis`,
`long penis` or `big penis` (all absent); `large penis` is 20,320 and
`erection` 78,218. These are act-frame tags only; the solo stages never carry
them.

**Only gender-suffixed tags bind an attribute to him.** This is the whole trick,
and getting it wrong inverts the scene. A plain adjective attaches to whoever
the model prefers — on the draenei run, `(human male:1.3), (tan skin:1.2)`
**swapped the two**: she came out human and tanned, he came out the draenei. The
tags that bind are the ones naming the gender inside the tag: `muscular male`
(75,109), `mature male` (29,491), `dark-skinned male` (70,557), `toned male`
(10,278), `bara` (57,756), `old man` (8,150). Use those and nothing else for him.

**There is no `pale-skinned male`.** `dark-skinned male` and `dark-skinned
female` are the *only* skin tags in the vocabulary that name a gender, so a pale
partner cannot be asked for — he is what you get by saying nothing about skin.
That is why the default option states build alone.

**Keeping her race off him is a LoRA weight, not a tag.** A negative is global
and cannot say "not on him". The fix is the one §7 already applies: run the
character LoRA weaker on two-person frames (0.65–0.7). Describing him harder
makes it worse, per the inversion above.

## 2. Extract once, reuse everywhere

Whichever way the character arrived, what comes out is one identity chunk and one
wardrobe, and **both are frozen for the whole set** — that is what makes it a
shoot. Write them down as:

| Piece | Contents |
|---|---|
| `ID` | subject, character tag if any, hair, eyes, face marks, headwear |
| `WH` | wardrobe a head-and-shoulders crop contains — collar, choker, earrings |
| `WT` | down to the waist — top, sleeves, shoulders, jewellery |
| `WF` | all of it — plus skirt, legwear, footwear, pose furniture |

Three depths, not one list. A `close-up` that names boots comes back a cowboy
shot, because the model zooms out to draw what it was told to include.

**When lingerie is worn under the outfit, the dressed frames name what shows
through.** A set whose stage 2 reveals stockings and a garter belt has her
wearing them in stage 1 as well, and a long dress with a slit shows a leg — so
that leg must already carry the stockings and straps, or stage 1 and stage 2
are two different women. Put the legwear and the straps into `WF` with their
colours, plus the opening that exposes them: `(side slit:1.3)` (34,242;
`front slit` is 755 and useless), `(black thighhighs:1.3), garter straps,
lace-trimmed legwear`. Measured on the Aerith set 2 (2026-09-05): the first
stage 1 rendered bare legs through the slit while stage 2 wore black
stockings, and the user asked for the layer to be visible from the start.

### With a picture — vault name or attached

Read it into tags following `/recreate` step 2. A vault name gets its block and
path from `pnpm migrate-prompt <name> --show`; open the file it names and read
the picture, not just the block (an img2img keeps its subject in an init image no
PNG carries). An attached image has no block — look at it and write the tags.
Either way the picture *is* the wardrobe: extract it garment by garment.

### With no picture — a bare character name

There is nothing to look at, so **build the identity and the canonical outfit
from the character tag.** Resolve the name to its exact danbooru form and confirm
it against the tagger's own vocabulary — the count is the confidence:

```bash
awk -F, -v q="<the tag, underscored>" '$3==4 && $2==q {print $2, $4}' \
  models/anime-tagger/selected_tags.csv
```

- **`ID`** = `1girl, solo, <character tag>` plus the character's signature hair
  (colour, length, style), eye colour and any face mark or headwear — the same
  anchoring `/recreate` writes so a weak tag still lands. `expressionless` unless
  the user said otherwise.
- **The wardrobe is the character's *canonical* outfit**, written at the three
  depths above — the silhouette the character is known for (Miku's grey collared
  top, tie, detached sleeves, pleated skirt, thighhighs; Aqua's blue dress and
  detached sleeves). Name the real garments, not a generic dress. If the
  character has several well-known outfits, pick the default/most iconic and say
  which in the report; the user can name another in words.
- **The setting** is your pick of a place that suits the character, frozen like
  everything else. Say what you chose.

A high-count character tag (tens of thousands of images) carries its own look, so
this path is reliable; a thin or absent tag does not, and there you must lean
harder on the signature features and say in the report that the tag is weak.

**Absent from the CSV is not absent from the checkpoint.** The tagger's list is
a filtered subset of danbooru, and the checkpoint was trained on the whole
thing. Ivy (`isabella valentine`, ~3.5k posts) has no row in the CSV, yet
`isabella valentine, soulcalibur` on deliberate produced her short slicked
hair, one gold gauntlet and cross-laced purple leotard with no LoRA — while a
set built from archetype tags because "the tag does not exist" gave her waist-
length hair and read as somebody else. So when the CSV has no row, render **one
test frame with the danbooru character tag plus its copyright tag** before
deciding the tag is dead; drop to archetype tags only if that frame is not her.
And check Civitai with `tag=` as well as `query=` — the query endpoint was
returning 503 the day "no Illustrious LoRA exists" was concluded, wrongly.
Everything downstream — the outfit classification in §4, the stages, the acts —
is identical whichever path filled `ID`/`WH`/`WT`/`WF`.

## 3. The stages

Four, and the third is where most sets end.

| Stage | Wardrobe | Shots |
|---|---|---|
| 1 — dressed | full | 10, **then the four low-angle frames** |
| 1→2 — taking the top off | mid-undress, top only | 2 |
| 2 — topless | `WT` minus the top | 6 |
| 2→3 — taking the bottom off | mid-undress, bottom only | 2 |
| 3 — bottomless | nothing below the waist either | 6 |
| 4 — acts | user-supplied, see step 6 | 2 per act |

### Stage 1 closes on four low-angle frames

Stage 1 ends on four **bent-over, shot-from-below** frames, fully dressed — after
the close-up and the portrait, not before them. It is the strongest composition
in the whole sequence, and it belongs where a climax goes: at the end of the
dressed stage, once the set has shown who she is. Opening on them was tried and
read backwards — a progression that starts on her rear before her face is not a
progression.

Four things stacked make it, and dropping any one of them loses it:

```
camera   (from behind:1.3), (from below:1.2), (ass focus:1.4), cowboy shot
scale    (foreshortening:1.3)
pose     standing, (bent over:1.4), leaning forward, arched back
look     looking back
```

**`foreshortening` (44,673) is the one that does the work** — it is what
balloons the near mass while keeping her head small at the top of the frame.
Without it the low angle just produces a normal bent-over shot. **`from below`
is the other half**: it is what puts the camera under her rather than level.

The four vary by what the head does, not by the body: looking back; head down,
away from the viewer; a smiling one (swap `expressionless` → `smile` in *both*
`ID` and `--adetailer-prompt`); and a wider one at `(full body:1.2)`.

**She braces on whatever the setting already contains** — a ruined wall, a rock,
a railing, a tree. **Never introduce a table** unless the set is genuinely
indoors: the prop has to belong to the background the other 143 frames share, or
the opener reads as a different shoot. Negate the props you did not choose —
`table, desk, indoors` for an exterior set — along with `top-down bottom-up,
lying, all fours, kneeling`, which are where the model drifts when asked to bend
someone over.

Body tags are the **rear** set (`BODY_R`), and per §1 the thickness slider comes
**off** here: these are ass-focused frames, where the ass tag already carries the
shape and the slider only smooths the glutes.

Stage 1's ten, with the pose each one carries:

```
1  close-up, eye contact         looking at viewer
2  portrait, eye contact         looking at viewer
3  upper body (front)            arms behind back
4  upper body (from behind)      looking back
5  cowboy shot (front)           contrapposto
6  cowboy shot (from behind)     looking back, arched back
7  full body (front)             standing, arms up
8  full body (from behind)       leaning forward
9  side profile                  contrapposto
10 from below                    hands up
11 three-quarter view          contrapposto, hand in own hair
```

**Frame 11 is the three-quarter view, on every set (user, 2026-09-05).** The
pose from the second figure of a character sheet: weight on one leg, turned a
little off the camera, one hand up in her hair, looking at the viewer —
`(full body:1.3), standing, contrapposto, (from side:0.3), looking at viewer,
hand up, hand in own hair, hair over shoulder`, front body tags, dressed. Keep
`from side` weak: at 0.5 NoobAI turned her fully sideways and lost the front of
the garment. `hand in own hair` 27,986 · `hand up` 265,393 · `hair over
shoulder` 42,714; there is no `three-quarter view` tag.

Stage 2 keeps 3, 5, 6, 7 and adds a breast close-up and a `clothes lift` frame.
Stage 3 keeps 5, 6, 7, 8, adds an ass close-up (**landscape, `--width 1216
--height 832`**) and a hip focus.

### The dress stays a surface — on every dressed frame

A rear frame that carries a heavy ass tag under a long dress comes back with
the fabric moulded into the crease, as if painted on. That is not a random
failure: with `(huge ass:1.4)` and `(ass focus:1.4)` in the prompt, the
cheapest way for the model to show the shape *through* a dress is to wrap the
cloth around it. Danbooru has a name for exactly this — **`impossible
clothes`** (24,167), with `impossible dress` (2,417) as the garment-specific
form — and because it is a tag, it is a usable negative.

So every frame where the character is still dressed (stage 1 and the bridge
that pulls the dress down) adds to its negative:

```
impossible clothes, impossible dress, wedgie, taut clothes, taut dress,
skin tight, tight clothes, cameltoe
```

`wedgie` (5,226) is the crease itself, `taut clothes` (15,251) / `taut dress`
(2,105) / `skin tight` (36,226) / `tight clothes` (12,700) are the stretched
fabric, and `cameltoe` (86,493) is the same thing seen from the front. From
stage 2 on there is no fabric over the hips, so the list is dropped — on a
bodysuit character it would fight the wardrobe, and on a topless one it does
nothing. Do **not** reach for `loose clothes` (2,337) or `baggy clothes`
(1,287) as positives: they are thin and change the *cut* of the dress rather
than how it sits.

**Measured on the Aerith re-render (8 frames, 2026-09-05): the crease is gone
in all eight.** The standing rear frames come back with the dress as a plain
surface. On the four bent-over low-angle frames the model resolves the same
tension the other way — it lets the hem ride up and shows skin instead of
wrapping the cloth — which reads fine for a low-angle beat but is a change of
register. If a set wants the dress to stay *down* on those frames too, add
`skirt lift, clothes lift, dress lift` to that frame's negative as well; the
undressing bridges use those tags positively, so never put them in a
set-wide negative.

### The undressing bridges — a striptease between the stages

The set should *show her getting undressed*, not cut from dressed to topless.
So **two transition frames sit before each drop in clothing**, catching the
garment mid-removal — she is in the act, partly exposed, not yet at the next
stage:

- **1→2, taking the top off (2 frames)** — bottom still fully on, top coming
  away: `undressing, (clothes pull:1.3), (shirt lift:1.2), strap slip, one breast
  out` over the stage-1 bottom (skirt, legwear, footwear). Cowboy shot, one frame
  front and one over the shoulder. Do **not** negate the top here — it is still on
  her, just being pulled.
- **2→3, taking the bottom off (2 frames)** — already topless, now the bottom
  coming away: `topless, breasts out, undressing, (skirt lift:1.3), (panty
  pull:1.2), (skirt pull:1.2)` with the legwear and footwear kept. Cowboy or full
  body, front and back.

The action tags are all well trained — `clothes lift` 180,831, `shirt lift`
71,578, `skirt lift` 66,052, `clothes pull` 69,767, `panty pull` 44,831,
`undressing` 52,035, `strap slip` 33,655, `one breast out` 12,587. The obvious
`pulling own clothes`, `lifting own clothes` and `thumbs in waistband` are all
**absent** — do not reach for them. "And so on" scales to a many-garment outfit:
a bridge for each layer that comes off, two frames apiece, always mid-action.

### Most frames smile — she is not expressionless the whole way

The frozen `ID` used to carry `expressionless` on every frame, with a handful
of smiles swapped in by hand. That read cold, and the user asked for more
smiling on 2026-09-05 — and then, shown a `light smile` frame, answered "you
call this smiling?". So the default smile is a **real** one. The solo stages
**deal the expression from a four-step cycle — `smile, open mouth, teeth` ·
`:d, happy, smile` · `grin` · `smile, open mouth, teeth, happy`** — indexed by
frame order, so every default frame smiles visibly and a re-run deals the same
faces. `light smile` and `expressionless` are out of the cycle: at this
checkpoint family `light smile` reads as no expression at all. Frames that name
their own expression keep it; the bridges take `seductive smile, open mouth,
teeth`. In the act stage the smile share is `smile, open mouth, teeth, happy,
blush`, for the same reason. All thick tags: `open mouth` 1,950,469 · `teeth`
370,407 · `:d` 464,842 · `grin` 184,832.
Swap the expression in **both** places or it does not take: `expressionless` →
`smile` (or `seductive smile`, `grin`, `light smile`) in the `ID` chunk **and**
in `--adetailer-prompt`, because the face pass repaints the head from its own
prompt and a calm face there paints over a smile asked for only in the main
prompt (the same rule as `tears`/`ahegao` in §6). Keep it to *some* frames — the
contrast is the point; a set that smiles in every frame is as monotonous as one
that never does. The act stage stays with its own expressions (neutral, `tears`,
`ahegao`), not smiles, unless the user asks.

**Mostly closed-mouth since 2026-09-10.** After the desert-B set the user said
"she should smile but not laugh - she laughs too often with open mouth", then
"she can laugh with open mouth but only in a few". So the solo cycle is now
three closed-mouth smiles and one laugh — `(light smile:1.2), closed mouth` ·
`smile, closed mouth, happy` · `(light smile:1.2), closed mouth, looking at
viewer` · `smile, open mouth, teeth, happy` — the bridges take `(seductive
smile:1.2), closed mouth`, the act-stage smile share is `(light smile:1.2),
smile, closed mouth, happy, blush`, and the face pass adds `(closed mouth:1.1)`
on every frame whose expression is not an open-mouth one. The closed-mouth solo
frames also negate `(laughing:1.4), (laugh:1.3), (open mouth:1.3), teeth, :d,
grin, upper teeth only`; the laugh frame and every act frame negate only
`laughing`, so the moan keeps its open mouth. On delburry75 with the Lara face
pass `light smile` at 1.2 does read as a smile — the 2026-09-05 "you call this
smiling?" was on a different checkpoint and an unweighted tag.

**26 renders before the act stage** (10 dressed + 2+2 bridges + 6 + 6), about
30 minutes warm. Say that before starting.

### The poses are checked, and the obvious one is not a tag

`hand on hip` and `hands on hips` are **both absent** from the tagger's 10,861
names. The stance they describe is `contrapposto` (26,730). `hair flip` is
nearly dead at 1,142 and is not worth spending a tag on. What is well learned:

```
standing 733k · sitting 782k · lying 380k · on back 214k · arms up 158k
hands up 139k · kneeling 102k · leaning forward 97k · on side 76k
arms behind back 73k · squatting 70k · crossed legs 62k · on stomach 55k
bent over 54k · all fours 51k · undressing 52k · strap slip 34k
legs apart 29k · contrapposto 27k · covering breasts 19k · arched back 17k
```

Rotate through those rather than repeating `standing` ten times — a pose
repeated across a stage is what makes a set look like one prompt run twice.

## 4. Undressing is subtraction *and* negation

The rule that costs the most when missed, measured twice this session: taking a
garment out of the prompt is not enough when the rest of the costume implies it.
An outfit full of frills, capes and gold trim is dress-coded, so removing
`white dress` and adding `midriff` gets a dress back; removing the skirt gets a
skirt back.

So each stage does both:

| Stage | Remove from the wardrobe | Add to the negative |
|---|---|---|
| 2 — topless | the top garments | `dress, shirt, bra, bikini top` and the top's own name |
| 3 — bottomless | skirt, shorts, legwear | `skirt, dress, panties, shorts` |

And add the state positively — `topless, breasts out` for stage 2, `bottomless,
no panties` for stage 3. State the absence, do not merely stop mentioning the
presence.

**Never strip the jewellery, the headwear or the footwear.** They are what makes
stage 3 recognisably the same woman as stage 1, and the heels are also what
keeps a `full body` from cropping at the thigh.

### First, classify the outfit — this decides the whole undress

Do this in step 2, once, before any stage renders, and let it drive stages 2–3
and every act automatically. The user should never have to ask for it.

**A separable outfit** — distinct top and bottom (shirt + skirt, bra + shorts,
bikini) — undresses by *subtraction and negation*, as the table above says:
remove the top for stage 2, the bottom for stage 3, negate each by name.

**A one-piece** — a leotard, swimsuit, bodysuit, dress, a catsuit — does **not**
come apart into a top and a bottom, and pretending it does is what breaks the
set. Removing it and going to bare skin also throws the character away, because
for a well-known character the one-piece *is* the silhouette (Alice's pink
leotard, a swimsuit idol, a bodysuit huntress). So a one-piece is **displaced,
not deleted** — it stays named in every stage and is pulled out of the way:

| Stage | Keep the garment, add | Negate |
|---|---|---|
| 2 — top exposed | `<the garment>, (clothes pull:1.3), (leotard pull:1.3), strap slip, breasts out` | `completely nude, bottomless` |
| 3 — fully exposed | `<the garment>, (leotard aside:1.4), (clothes pull:1.2), breasts out, no panties, ass, pussy` | `completely nude` |

`leotard aside` (4,331) and `leotard pull` (2,380) are the leotard-specific
tags; `clothes aside` (37,048) and `clothes pull` (69,767) are the strong
generic fallbacks for any other one-piece. The garment is never negated — the
whole point is that it is still on her, just moved.

**The displaced garment loses its colour — say the colour twice and negate the
rival.** Measured on the desert-B set (2026-09-10): every dressed frame rendered
the grey ribbed leotard, and every stage 2 and 3 frame rendered its lower half
as black leather, because once the bodice is pulled down the belt, harness and
`leather` words in the same chunk recolour what is left. The user: "her bodysuit
is sometimes just black". Weighting the garment (`(grey leotard:1.4)`) and
negating `black leotard, leather leotard` did nothing, and neither did the LoRA
weight (0.75 and 0.9 both black). What fixed it, tested on both stages: add the
**colour as a clothes tag** — `(grey clothes:1.3)` — and negate the rival colour
the same way — `(black clothes:1.4), (black:1.2), (leather:1.2)` — alongside the
garment words. `<colour> clothes` is what the model reads as "what she wears is
this colour"; `<colour> leotard` alone is outvoted by the accessories. Do this on
every stage 2 and 3 chunk of a one-piece set from the start.

### The act-stage wardrobe is fixed: bare body, accessories only

The undress classification above governs **stages 2 and 3** — the tease, where a
one-piece is displaced to keep the silhouette and a separable outfit comes off in
two steps. **At the act stage that stops.** However she got there, by the sex
acts her **upper *and* lower body are fully naked** — `completely nude, breasts
out, nipples, ass, pussy` — and the *only* thing still on her is the character's
own **accessories on head, arms and feet**:

| Slot | Kept through the acts | Examples |
|---|---|---|
| Head | headwear, hair ornaments, ears/horns, choker/collar, earrings | `headphones`, `black collar`, `hair ribbon`, `animal ears` |
| Arms | bracelets, gauntlets, arm bands, detached sleeves *if they are the character's mark* | `bracelet`, `gauntlets`, `armlet` |
| Feet | footwear and legwear — always, they also stop a full body cropping at the thigh | `thighhighs`, `boots`, `high heels` |

Everything torso and hips comes **off**, including a one-piece that was merely
*displaced* in stage 3 — by the acts the leotard/bodysuit/swimsuit is removed
outright, not pulled aside, and negated by name so it does not creep back onto the
skin (`leotard, bodysuit, swimsuit` in the negative). This is the one point where
the displacement path and the subtraction path converge on the same result, and
it holds **depending on the character**: keep whichever of head/arms/feet
accessories that character actually wears, drop the slots she does not.

Write this once as the frozen act wardrobe (`WF3` in the render scripts —
`completely nude, breasts out, nipples, ass, pussy` + the kept accessories), and
every act inherits it. Decided in step 2, never asked about again.

## 5. What stays identical across every stage

- The identity chunk, word for word.
- The setting chunk, word for word.
- The body tags, at whatever rungs the call-2 answers set.
- The checkpoint, the style flag, the quality block, the sampler.
- The ADetailer prompt, which is built from the identity tags and therefore
  never changes either.

Only the wardrobe, the pose and the framing move. If anything else drifts, the
set stops being a shoot.

**And within the wardrobe, every garment's colour is frozen too.** Write each
garment as its colour-fused tag (`black thighhighs`, not `thighhighs` with a
colour word somewhere near it), weight the colour that sits next to a stronger
neighbour, and negate the neighbour colours on that garment (`purple
thighhighs, white thighhighs` when the stockings are black beside a lavender
belt). The Aerith set 2 lost this on its stockings — dark in most frames,
lavender in some — because `black thighhighs` stood unweighted next to
`(light purple garter belt:1.3)` and a thin `lace-trimmed thighhighs` (936)
that only supplied the word "lace" for the belt's colour to fill. The rule and
its counts live in `.claude/shot-tags.md` ("Every garment carries its own
colour…").

**Keep the character tag in the crop shots.** The hip focus and the ass close-up
use the positive crop recipe — `(hip focus:1.6), (lower body:1.5), (head out of
frame:1.4), cropped torso` — and the character tag stays. Dropping it costs the
outfit; see the measured three-way in `.claude/shot-tags.md`.

## 6. The act stage — supplied, not authored

**Do not ask which acts.** The sequence below is the standing instruction and
runs in full on every execution, straight after stage 3, with no question call
and no confirmation. Asking was the original design and it was wrong: the acts
were specified once, deliberately, and re-asking every run is friction rather
than care.

Acts are only discussed when the user raises them — to add one, drop one, or
change a count. A named addition is resolved to a tag first:

```bash
awk -F, -v q="<the tag, underscored>" '$2==q {print $4}' \
  models/anime-tagger/selected_tags.csv
```

Report the count and say plainly when one is absent, exactly as with any other
tag — the obvious phrasing is absent more often than not, and a name from a
Kama Sutra list is more likely to be missing than present. Anything that
survives that check gets added to the table below so the next run has it.

Then build each act's frames as a **guarded substitution** into the act-stage
block — the fully-nude-plus-accessories wardrobe fixed in §4 — the same mechanism
used for every body and wardrobe edit here:

- one tag in, the previous act's tag out and into the negative;
- abort rather than queue if the substitution does not match.

**Frame counts and canvas are per act, not a default.** The sequence below is
the one specified on the first run and is what to reuse unless told otherwise —
each act's count, orientation and escalation was chosen deliberately, and a
uniform "N frames per act" throws that away.

### The established sequence

Tags in brackets are the resolutions already checked against
`selected_tags.csv`; counts are in the findings below. Every frame carries
`1girl, 1boy, hetero, solo focus, faceless male` **plus §1's partner answer**,
drops `solo`, and inherits the act-stage wardrobe (§4 — bare body, accessories
only), identity, setting, body rungs and checkpoint. The partner tags are frozen
exactly like hers: he is described once, in gender-suffixed tags only, and never
re-rolled per frame.

**Every frame says `uncensored`, and the negative names the censoring.** Measured
on the Oracle set (2026-09-05): the moment a penis is in frame the model reaches
for what its training data did to one — an orange dot over a nipple, a blue
badge with garbled text, glowing rectangles beside the breasts on a dressed
full-body frame. Nothing in the prompt asked for them and nothing forbade them.
So `uncensored` (110,091) goes into the identity line of *every* frame, solo and
act alike, and the baseline negative carries `(censored:1.3), mosaic censoring,
bar censor, heart censor, sticker, emoji, glowing, speech bubble` — `censored`
388,593 · `mosaic censoring` 168,821 · `bar censor` 120,647 · `heart censor`
15,789 · `glowing` 86,347; `sticker` (2,928) and `emoji` (2,305) are thin but
name the exact artefact. `pasties` belongs in the same list on a topless stage
— the star pasties one early Oracle test drew were the same reflex.

**The duo negative is heavier than the solo one.** Measured on the desert-B set
(2026-09-10, 118 act frames): the two-person frames, which run the character
LoRA weaker and skip the face pass, produced what the solo frames never did —
a corner panel or a second copy of her on nine of the first twenty-one act
frames, blue censor patches on four more, and comic speed-line scribbles. The
baseline `inset, (multiple views:1.3)` was not enough there. So every act frame
adds `(inset:1.5), (multiple views:1.5), split screen, extra body, clone,
(2girls:1.4), (censored:1.6), (blue:1.2), blue pasties, motion lines, speed
lines` on top of the baseline. Measured on the second desert-B set (154 frames,
2026-09-11): the same act stage went from 20 misses to 8, breast-grab from 0/6
to 5/6, and no censor patch at all.

**The camera-in-front reverse suspended frames do not penetrate.** On both
desert-B sets the two plain vaginal 6b frames with the camera in front rendered
him holding her up with the penis standing in front of her, not inside — four
of four, and adding `(penetration:1.3), (vaginal:1.2), (insertion:1.2)` on the
second set changed nothing. The POV variants (k = 2 and 7) and the anal frames
of the same act penetrate every time. So 6b's front-camera vaginal frames are
now POV too: the act's `geometry` stays `front` for the body block, but every
6b frame takes `POV.front` rather than the rotating camera.

**The third presenting frame collapses.** `all fours, top-down bottom-up` with
the ass one rung up and a close crop produced an anatomy collapse (a bald,
distorted head in a fold of skin) on both desert-B sets. That frame is now the
same standing `bent over, presenting` as the first two with `from behind, (from
below:1.2)` instead of the top-down pose; the escalation stays in her hands.

| # | Act | Frames | Canvas | Shape |
|---|---|---|---|---|
Counts below are the **doubled** counts, standing since the Aqua run. Every act
except 4b renders twice what it first did — a single position needs the volume
to give a usable spread, and 4b (presenting) is the one beat that read fine at
three. Do not halve them back without being asked.

| 1a | Irrumatio over the table's edge | 2 beats ×4 seeds = 8 | landscape | opens the story's act stage. She lies on her back on the table, head hanging over the edge, he stands at her head — **and the geometry is kept, not swapped for a kneeling one** (the user rejected that as "a cheap way out"). **Rebuilt 2026-09-05** because the old block broke anatomy in most frames: the culprit was bare `upside-down` (22,255), which flips the whole figure. The recipe that works, `IRR` = `lying, on back, on table, table, (head back:1.3), (upside-down:0.8), arched back, breasts apart, (hand on another's head:1.2), penis, testicles`; positioned → `IRR, open mouth, tongue out, (imminent fellatio:1.2)`; deep → `IRR, fellatio, (irrumatio:1.4), (deepthroat:1.3)`; both with `(tears:1.4)`, side geometry. Measured on 12 frames: without `upside-down` 8/8 coherent but only ~5 hit the head-over-the-edge pose (the rest drift to sitting at the table); at `0.8` all coherent and 3 of 4 hit it. Below `1.0` the tag says "head hangs back", at `1.0` it says "invert her". **No cum here** — the finish belongs to act 7 |
| 1b | Fellatio, kneeling | 8 | portrait | 4 base; 4 adding `(deepthroat:1.3), (tears:1.4)` |
| 2 | He grips her bare breasts | 6 | portrait | `(upper body:1.3), (close-up:1.1), (breast focus:1.3)`, `(grabbing another's breast:1.3), groping, nipples, male hands`. **Not `(close-up:1.6)`** — measured on the desert-B set (2026-09-10): at 1.6 with the torso body block all six frames drew the hips the crop could not hold as a second panel, an inset or a second woman; at the looser crop the frame is clean |
| 3 | Missionary, legs held | 8 + 4 + 4 + 6 | portrait, then landscape | exposed → entering → `(deep penetration:1.3)` → `:1.5` + `testicles` (8 portrait across the ladder); 4 landscape repeats of the deep pair; 4 landscape `anal`; then **6 landscape with her legs wrapped around him** — `(leg lock:1.4), hug` (`legs around waist` is not a tag; `leg lock` is 3,432 and needs both the weight and the prop) |
| 4a | Doggystyle | 6 + 10 + 6 + 4 | landscape | 6 vaginal, some with `arms behind back, (arm grab:1.4)`; then **10 anal** — plain, arm-pulled, and `(deep penetration:2), testicles` frames at the vocabulary's ceiling for depth; then **6 restrained** — `choker, collar, (chain:1.2), (chain leash:1.4), leash, (holding leash:1.3), (leash pull:1.3)` (mostly vaginal, some anal): a chained collar he holds and pulls her by. **Use a collar, not a bit gag**, and do **not** stack `head back` + `looking up` — that pair renders a head twisted past 90°. `bit gag` (2,810), `harness`, `pony play`, `head harness`, `bridle` and `reins` are all dead or near-dead; `choker` (320,504) and `collar` (157,883) hold reliably. Negate `bit gag, gag, harness` so the earlier gear does not creep in; then **4 to close the act — she grabs her own glutes and spreads herself open**: `ass grab, (grabbing own ass:1.5), (spread ass:1.4), (spread anus:1.3), anus, ass focus, own hands together` (2 vaginal, 2 anal). The specific names are thin — `grabbing own ass` 5,574, `spread ass` 4,863 — so assemble from the thick ones (`ass grab` 25,306, `anus` 98,073, `ass focus` 21,648) and weight the specific ones as hints. **Negate `grabbing another's ass`** or the hands become his: that is the exact tag acts 6 and 7 use for him, and without the negation the beat inverts silently |
| 4b | Presenting, gaped | 3 | portrait | **not doubled** — the one act that read fine at three. **after** the doggystyle, not before. 2 solo standing `bent over, presenting, (gaping:1.4)`; 1 solo `all fours, top-down bottom-up` with the ass **one rung up**. The **last two of the three** add her own hands: `ass grab, (grabbing own ass:1.5), (spread ass:1.4), (spread anus:1.4), own hands together` — she is alone here, so nothing to negate, but the first frame stays clean so the beat still escalates |
| 5 | Spooning / side fuck | 8 | landscape | `on side, sex from behind, leg lift`; negate `missionary`. **Doubled to 8** — it is the weakest act in the set (see below), so it needs the extra volume to yield a usable spread, not less |
| 5b | Standing, taken from behind | 6 | portrait | `standing, standing sex, sex from behind, bent over`, both upright, `arms behind back, (arm grab:1.4), (holding another's arm:1.3)`; negate `rope, bondage, all fours, lying` |
| 6 | Suspended congress | 4 + 4 | portrait | forward-facing; `straddling, carrying, standing sex`; then 4 with both glutes gripped — `ass grab, (grabbing another's ass:1.3)` |
| 6b | Reverse suspended congress | 6 | portrait | **camera in front, she faces viewer**; 2 vaginal, 4 anal, two of them with `(ahegao:1.5)` |
| 7 | Spitroast | 4 + 4 | landscape | **added 2026-09-05 in the piledriver's slot; moved ahead of the reverse cowgirl on 2026-09-06 so the finish stays the last thing in the set.** She is on all fours between two men, one from behind, one in her mouth: `(spitroast:1.3), all fours, sex from behind, fellatio, (deepthroat:1.2), (hand on another's head:1.2), penis, testicles` + `vaginal` ×4, then `anal` ×4, every other frame with `(tears:1.4)`. The cast line changes for this act only — `2boys, multiple boys, hetero, solo focus, faceless male, <partner>, large penis, erection, (mmf threesome:1.2), group sex, threesome` replaces the `1boy` line — and `2boys, multiple boys` come **out** of its negative (they are in every other act's) while `3boys, 4boys, 1boy` go in. Thick carriers: `multiple boys` 367,969 · `2boys` 232,894 · `group sex` 49,139 · `threesome` 25,283 · `mmf threesome` 11,460; `spitroast` (3,736) is the hint. Side geometry, so the line-up reads |
| 8 | Reverse cowgirl | 6 + 4 + 4 | portrait | `leaning forward, bent over`, camera behind; negate `cowgirl position`. 6 plain, then 4 with the glute grip as in act 6, then **the last four carry the finish — the closing frames of the whole set, which is why the spitroast comes before it** — `cum, cum in mouth, (cum overflow:1.4), ejaculation` |
| — | Piledriver | — | — | **dropped — not renderable, see below** |

Two rules visible in that table and worth stating plainly: **a beat that has a
before and an after gets both frames** (act 3's exposed-then-entering, act 1a's
positioned-then-penetrated), and **an escalation is a separate frame rather
than a heavier tag** — the deepthroat pair, the anal frames, the ahegao frame.

### The camera rotates within an act

An act with eight frames must not be eight copies of one composition. Every act
belongs to one of three camera *geometries*, and its frames cycle through a
four-step rotation for that geometry — frame `n` takes step `((n-1) mod 4)+1`:

| geometry | acts | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| **front** | 1b, 2, 3, 6, 6b | `cowboy shot, looking at viewer, facing viewer` | + `(from above:1.2), looking up` | + `(from below:1.2), (foreshortening:1.2), looking down` | `(pov:1.2), close-up, eye contact, (blurry foreground:1.1), depth of field` |
| **side** | 1a, 5, 7 | `cowboy shot, from side, looking at viewer` | + `(from above:1.2)` | `close-up, from side, (blurry foreground:1.2), depth of field` | `wide shot, full body, from side, dutch angle` |
| **rear** | 4a, 4b, 5b, 8 | `cowboy shot, from behind, looking back` | + `(from below:1.2), ass focus, (foreshortening:1.2)` | + `(from above:1.2)` | `close-up, from behind, dutch angle, ass focus, looking back` |

Every word in it is checked: `from side` 170,900 · `dutch angle` 104,788 ·
`pov` 98,619 · `depth of field` 91,237 · `from above` 81,395 · `from below`
68,637 · `foreshortening` 44,673 · `close-up` 36,871 · `eye contact` 35,104 ·
`blurry foreground` 24,511. The obvious words are **not** tags: `high angle`,
`low angle`, `three-quarter view`, `side view`, `male pov` and **`face focus`**
are all absent — the last of those has been sitting inert in the stage-1
close-up and portrait, so those now carry `eye contact` instead.

**Every act carries one or two frames from his eyes (user, 2026-09-05).** The
2nd and the 7th frame of each act, counted across the act, replace their
rotation step with a POV framing for the act's geometry:

| geometry | POV framing |
|---|---|
| front | `(pov:1.3), (from above:1.2), looking at viewer, eye contact, pov hands` |
| side | `(pov:1.3), (from above:1.2), looking at viewer, pov hands` |
| rear | `(pov:1.3), from behind, (from above:1.2), ass focus, pov hands` |

`male pov` is not a tag; `pov` (98,619) with `from above` and `pov hands`
(17,344) is what puts the camera in his head, and `faceless male` is what makes
it coherent. Acts shorter than seven frames get one POV frame.

Three constraints the rotation respects, and any edit to it must keep:

- **Rear steps all contain `from behind` or `ass focus`**, and front steps
  contain neither — that is what the slider rule (§6, "matched on the camera")
  keys on, so the rotation and the slider stay in agreement per frame.
- **Front steps carry `facing viewer`** so the front-framing assertion is
  already present and the helper does not need to inject it.
- **The rotation never changes the act's geometry.** `pov` on a front act puts
  the camera at the partner's eyes, which `faceless male` makes coherent; `pov`
  on a rear act would put it *behind* her back, which is a different picture.
  Geometry is decided by the act table, the rotation only moves within it.

Implement it as one `cam <geometry> <n>` function in the story file and call it
as the framing argument — `go "4-5-spoon-0$i" "$(cam side $i)" …` — rather than
writing the four strings into every loop.

**The finish lands once, at the end.** `cum, cum in mouth, (cum overflow:1.4),
ejaculation` appears only in the last frames of act 8 — the reverse cowgirl, now the final act — and nowhere else. The spitroast (act 7) sits before it for exactly that reason: the finish has to be the last thing in the set (user, 2026-09-06). It
used to sit in the irrumatio act as well; having it twice made the sequence read
as two stories rather than one, so the oral act now stops before it.

**One act is known-weak and kept anyway.** Act 5 (spooning) renders
inconsistently because `spooning` is 1,424 images and the pose has to be
assembled entirely from parts. It is not broken enough to drop, but expect a
lower keeper rate and do not read a bad frame there as a prompt error. Act 1a
used to be the other weak one — the head-over-an-edge geometry had only
`upside-down` and `table` to stand on and twisted bodies in most frames — until
it was rebuilt as a kneeling irrumatio on 2026-09-05 (see the table). Act 8 is
the case that *was* bad enough to drop.

### The body is a LoRA, not a tag stack — measured across three more runs

**A tag names a part; a LoRA reshapes a body.** That is the whole finding. A
part tag only pays out when that part is in frame, so a tag-built figure reads
thick from behind and thin from the front no matter how the weights are pushed —
and the vocabulary runs out long before the shape arrives: **there is no hip tag
above `wide hips` (32,326)**. `huge hips`, `thunder thighs`, `pear-shaped` and
`hyper hips` are all absent. `(wide hips:2)` is the ceiling, and past about 1.8
it stops reading as width and starts reading as a hard shelf at the pelvis.

`thicc_slider_ixl_v12` (Civitai 217340) is the instrument instead. It is a
**slider**: no trigger word, weight *is* the dial, and it keeps scaling where
ordinary body LoRAs saturate — `bottomheavy_ixl_v02` collapses at 1.9 (character
lost, render goes soft) and its real ceiling is ~1.3. Useful range: **1.0
natural, 1.2 heavier, 1.5 hyper**; 2.5 overshoots and starts re-clothing the
subject. It survives armour, which tag-driven mass does not — plate over the
thighs hides exactly the mass a thigh tag puts there.

**Run it at half weight in the act stage.** It is a blunt global transform, not
an anatomy-aware one. On posed and standing frames it reshapes cleanly; in the
act frames, where the pose already strains the anatomy, it deforms instead —
that is where non-aesthetic shapes come from. Keep a `SLIDER` / `SLIDER_ACT`
pair and switch on `ACTMODE`, exactly as the character LoRA already does.

**And take it off on rear-camera frames only — matched on the camera, never the
pose.** Where the ass tag at 2 already carries the shape, the slider only
smooths the glutes into a shinier, less natural mass. But "rear" must be decided
from the *framing* chunk and the frame name, because the pose chunk is full of
words that look like camera instructions and are not: `on back` and `head back`
(she is lying face-up), `spread legs`, and `sex from behind` — a position that
is routinely shot from the front. Matching those turned the slider off across
almost the whole act stage, and the acts that suffered were exactly the ones
facing the camera, where the ass tag contributes nothing. Nor is `rev-` a
filename marker: act 6b is shot from the **front**, and act 7 is already caught
by its own `from behind` framing. What works:

```sh
case "$l1" in *"from behind"*|*"ass focus"*|*"looking back"*) slide="" ;; esac
case "$f"  in *doggy*|*present*|*allfours*|*bend*|*-spread-*) slide="" ;; esac
```

**Canvas changes apparent thickness as much as any tag.** Act 1a renders
landscape on a reclining body shot from the side — the same body tags fill far
more of the frame and read heavier, while act 5's landscape `on side` profile
compresses the body and reads lighter. When a set looks inconsistent act to act,
check the canvas and the pose before touching the body rungs.

**Two tags that look right and are not.** `abs` (77,016) and `toned` (29,061)
genuinely narrow the torso — a real lever, since the model reads hip width
*relative* to the torso above it — but they also *harden* it, which is wrong for
a soft figure. Negate them. And `skinny` narrows the whole body rather than just
the torso, taking the thighs with it.

**A negative cannot turn a body, only argue against one.** `looking at viewer`
turns the *head*; a front frame stays rear-on until the positive asserts
`(facing viewer:1.3), straight-on` **and** the negative carries
`(from behind:1.5)` — weighted, because `from behind` is 194,007 images against
`facing viewer`'s 46,277 and loses unweighted. Some characters never need this;
one in cheeky shorts needed both halves on every front frame. Wire it into the
frame helper rather than per frame.

### Five things measured on the first real run

**Position names are the thin end of the vocabulary; their components are the
thick end.** `spooning` is 1,424 images. `suspended congress` is 1,671.
`piledriver` and `mating press` do not exist at all. Meanwhile `on side` is
75,537, `straddling` 57,688, `sex from behind` 54,218, `squatting` 69,991 and
`upside-down` 22,255. Weighting the name will not rescue a position; naming its
parts will. Assemble, then add the name weighted as a hint.

**But some positions have neither, and assembling does not save them.** A
piledriver has no tag (`piledriver`, `pile driver` and `mating press` are all
absent or near-absent) *and* no thick components specific to its shape —
`upside-down` and `squatting` are well trained but describe a hundred other
things. Built from those it came back as something else entirely and the act was
dropped. When a position has no name and no distinctive parts, the prompt is the
wrong instrument: that is inpaint or img2img territory. Say so rather than
burning renders proving it.

**A position tag loses to its better-trained sibling.** `cowgirl position`
(33,035) is four times `reverse cowgirl position` (7,919), and `missionary`
(24,255) swamps `spooning`. Negate the sibling explicitly or it takes the frame.

**Check the framing before blaming the tag.** A reverse position asked for with
`from behind, ass focus, looking back` came back forward-facing three times —
not because the tag was thin, but because those framing tags put the camera
where the *forward* version lives, and framing outranks a 4,336-image position
tag. In a reverse-facing position she faces the *camera*; the camera is not
behind her. Fix the camera first, then the weight.

**`looking back` is not the default for a from-behind frame — use it only when
there is a reason.** It reads naturally when she is engaging the camera or her
head is being pulled/held, and unnaturally everywhere else; stapling it onto
every rear shot makes a whole set of over-shoulder faces that all look posed the
same way. Worse, `looking back` stacked with a second head instruction —
`(head back:1.4)`, `looking up` — asks for two incompatible neck rotations at
once, and the model renders their *sum*: a head twisted past 90°, sometimes a
full 180°. So on a from-behind frame, default to her facing forward (`facing
away`, no `looking back`), and add `looking back` only where the shot earns it —
and never alongside another head-direction tag. If a leash or a grip needs to
imply a pull, let the leash tag do it; do not also command the neck.

**An expression must go in `--adetailer-prompt` as well.** The face pass
repaints the head crop from its own prompt, so `tears`, `ahegao` or anything
else stated only in the main prompt is painted over by a calm face. This is
invisible at first glance and is the usual reason an expression "did not work".

**Every two-person frame turns ADetailer OFF — pass `--no-adetailer`.** The pass
repaints *every* face it detects with the same prompt, so on any frame where the
man's head is in shot it paints her identity onto him: her hair, her eyes, and —
with a character LoRA loaded — her skin and horns too. `faceless male` suppresses
his face only when it holds, and it does not always hold. So skip the pass
entirely whenever a second figure is in frame; her face then comes from the base
render plus the hires pass, which is good enough at this canvas. Solo frames
(stages 1–3, and act 4b) keep the pass and its identity prompt.

**The face pass runs on its own checkpoint (user, 2026-09-05).** After a short
spell with the pass off entirely, the user brought it back — on **Mango Pie**
rather than the base render's checkpoint. `open-in-forge` takes
`--adetailer-checkpoint <substring>` (resolved like `--model`), writes
`ADetailer checkpoint: <name>` into the block, and `@luma/core`'s
`adetailerUnit` turns that into `ad_use_checkpoint` + `ad_checkpoint`. Two rules
ride along:

- **A LoRA face keeps its LoRA in the face prompt.** With the pass on a
  different checkpoint the repaint has no other way to know who she is:
  `--adetailer-prompt "<lora:eve_stellarblade_ixl_v10:0.8>, sbevealt, …"`. The
  softening this used to cause is what the checkpoint swap is for.
- **Two-person frames still run without the pass.** It repaints every face it
  detects with her prompt, and `faceless male` does not always hold.

**When the base checkpoint cannot draw the garment, let another one compose it
— `--refiner`.** Measured on the Celestial Oracle (2026-09-05): delburry75 and
wai put a gold belt under the bust of a long panel over bare hips on nearly
every full-body front, and no negative removed it — eight rounds, `(belt:2)`,
the gem removed, the garment word swapped four times. NoobAI-XL never drew it,
but the user prefers delburry's finish. The split is Forge's refiner:
`--model vpred --refiner delburry75 --refiner-switch 0.5` writes `Refiner:` /
`Refiner switch at:` into the block and `@luma/core` turns them into
`refiner_checkpoint` / `refiner_switch_at`. The base model runs the first half
of the steps and decides *what* is in the frame — garment, seams, silhouette —
and the refiner runs the second half and decides *how it is painted*. Belt-free
in every frame from the first try; 0.35 and 0.6 both worked too, so the switch
point is not delicate. Two things ride along: NoobAI reads body weights about a
rung harder (hips 1.7 there is the round silhouette the user wanted), and it
hazes a `depth of field` setting into fog — take that tag out. **Do not merge
the two checkpoints instead**: the installed NoobAI is v-prediction and
delburry is epsilon, and averaging weights that predict different things gives
a model that is wrong at every step.

Check the PNG for `ADetailer use separate checkpoint: True` after the first
render — Forge silently drops a unit it cannot parse.

**A face that comes from a LoRA needs the face pass off — on solo frames too.**
ADetailer repaints the head crop at 0.4 denoise from *its own* prompt, and that
prompt carries the trigger word but not the `<lora:…>` tag, so the repaint runs
without the character LoRA and paints the checkpoint's default face over
whatever the LoRA drew. Measured on Lara: three different Lara LoRAs, five
portraits, one identical doll — and the same LoRA with `--no-adetailer` was
unmistakably her. Putting the LoRA tag inside `--adetailer-prompt` applies it
but still softens the likeness; off is cleanly better. This is invisible on a
character whose identity is *tags* (Evie's hair and heterochromia went into the
face-pass prompt and survived), which is why it went unnoticed for nine runs.
So: identity from tags → face pass on, with those tags in its prompt; identity
from a LoRA → `--no-adetailer` on every frame, and let the base render plus the
hires pass carry the face.

**Every two-person frame needs `faceless male, solo focus`.** ADetailer runs on
*every* face it detects and applies the same prompt to each — so an expression
in the face pass lands on him too. `faceless male` (26,473) and `solo focus`
(304,477) mean his face is never drawn, which leaves the pass one target. Add
them to every frame with a second figure, not only the ones with an expression.

### She moans through the act stage — the default expression there

Where the progression stages default to `expressionless` (with some smiling,
§3), **the act frames default to moaning.** It is what makes a sex frame read as
sex rather than a pose, and it is not an add-on the user should have to ask for.

`moaning` is a real tag but a **thin** one at 7,759 — the same shape as the
position names in the finding above, so **assemble it from its thick components
and let the name ride along as a hint**:

```
moaning, open mouth, blush, (heavy breathing:1.2), half-closed eyes, nose blush
```

`open mouth` is 1,950,469, `blush` 2,496,356, `nose blush` 90,911,
`half-closed eyes` 75,884, `heavy breathing` 32,131 — all far thicker than the
name. `clenched teeth` (52,665), `trembling` (64,935), `saliva` (99,380) and
`torogao` (7,723, thin like `moaning`) are the variations worth rotating so a
hundred act frames do not wear one face.

**Act frames deal five faces — 45% moan, 15% smile, 15% flirty, 15% submissive,
10% surprised.** A hundred moaning faces read as one face, and a set of them
reads as endured rather than enjoyed; but the 20/55/25 smile-heavy mix that
replaced it on 2026-09-05 got "she seems to laugh now all the time — more
variation please, bring back moaning, maybe also flirty, submissive" the same
night. So the moaning default above is the plurality again, and three other
faces break it up:

- **smile** — `smile, open mouth, teeth, happy, blush` (a real smile; `light
  smile` reads as nothing).
- **flirty** — `seductive smile, half-closed eyes, naughty face, licking lips,
  looking at viewer, blush` (`naughty face` 25,981 · `licking lips` 18,442 ·
  `seductive smile` 8,836).
- **submissive** — `embarrassed, (wavy mouth:1.1), averting eyes, blush,
  trembling, nose blush, tearing up` (`embarrassed` 81,248 · `wavy mouth` 68,694
  · `trembling` 64,935 · `tearing up` 34,501; `submissive` itself is not a tag).
- **surprised** — `surprised, :o, open mouth, wide-eyed, blush, happy, :d`.

(History: 70/15/15 → 30/40/30 → 20/55/25 → this, all on user request; the lesson
is that any one face above about half the frames reads as a mask.) Deal them
deterministically rather than at random — a 20-frame cycle of 9 moaning,
3 smiling, 3 flirty, 3 submissive, 2 surprised, indexed by the frame's position
across the whole act stage, not per act — so a re-run reproduces the same faces
and no single act ends up one-note. The frames that
carry a *stronger* expression already (`tears` in 1a/1b, `ahegao` in 6b) are
outside this mix, as above: they keep theirs and are not counted.

Two rules it inherits rather than restates: it goes in **`--adetailer-prompt` as
well as the main prompt** (or the face pass paints a calm face over it), and it
needs **`faceless male, solo focus`** or he moans too. Where a frame already
carries a stronger expression — the `tears` beats in acts 1a/1b, `ahegao` in 6b —
**that one wins**; do not stack moaning under it, since `ahegao` already implies
the open mouth and rolled eyes and two expression stacks fight the same way two
framing rungs do.

### Anchoring a character — measured across nine runs

**A thin character tag is not the problem people assume.** What predicts whether
a character survives 135 frames is not how many images carry her *name* but
whether she **decomposes into well-trained tags**. Measured:

| Character | Tag | Outcome |
|---|---|---|
| `pharah \(overwatch\)` | 1,107 | held easily — dark-skinned female 146k + black hair 1.2M + braid 525k + facial mark 77k is a combination almost unique to her |
| `widowmaker \(overwatch\)` | 1,582 | held — colored skin 98k + purple hair 524k + very long hair 783k + yellow eyes 565k |
| `mercy \(overwatch\)` | 3,119 | **needed a crutch** — blonde/ponytail/blue eyes are generic, so `halo` (171,236) did the identity work |
| `ninomae ina'nis` | 6,999 | held easily |
| `nekomata okayu` | 6,097 | held easily |
| `houshou marine` | 11,739 | carried herself unaided |
| `hatsune_miku` | 89,677 | carried herself unaided |

So when a tag is thin, do not weight the name harder — **ask whether the
character is describable in thick tags, and if she is, spend the words there.**
It is the same move the position vocabulary needs, applied to a person.

**The anchor ladder — prefer the top of it.** Identity markers are not equal:

| Kind | Examples | Behaviour |
|---|---|---|
| **Body feature** | Okayu's cat ears (232k) + tail (130k), Pharah's dark skin, Widowmaker's colored skin | survives undressing *automatically* — cannot be taken off, so it holds through every act frame with no rule needed |
| **Head/arm/foot accessory** | Mercy's halo, Ina's tentacle hair, Marine's pirate hat | survives, but only because §4's accessory rule keeps it |
| **Character tag alone** | Marine, Miku | reliable above ~10k, unreliable below |

Find the body feature first. It is the cheapest and most durable anchor a
character has.

**Anything unusual about skin or face must go in `--adetailer-prompt` too.** The
expression rule above generalises: the face pass repaints the head crop from its
own prompt on *every* frame, so a non-default physical attribute stated only in
the main prompt gets painted over. Widowmaker's purple skin survived 135 frames
because `(colored skin:1.3), (purple skin:1.4)` sat in **both** the ID chunk and
the ADetailer prompt. Dark skin, coloured skin, facial tattoos, heterochromia —
all of it goes in both places.

**Name the garment colour when the tag is thin.** A thin character tag still
contributes specifics you cannot name — Widowmaker's visor rendered correctly
from her 1,582-image tag alone despite `visor` being **absent** from the
vocabulary — but it is not strong enough to fix a colour the prompt never
states. Her suit came out magenta instead of dark purple for exactly that
reason. Above ~10k the tag holds the palette; below it, say the colour.

**A character with no tag at all still works — if the archetype decomposes.**
`alexstrasza`, `sylvanas_windrunner`, `yrel`, `draenei`, `warcraft`,
`night elf`, `blood elf` are **every one absent** — the booru corpus these
models trained on does not cover Warcraft. Alexstrasza still rendered
convincingly from `dragon girl` (26,921), `(dragon horns:1.3)` (32,766),
`dragon tail` (21,870), `crown` (56,908), `red hair` (424,264) and
`bikini armor` (8,507). So an absent character tag is not the blocker; it is
the same question one step further out — *is the archetype describable in thick
tags?*

**What actually fails is an archetype whose anatomy is untrained.** A draenei
needs hooves and digitigrade legs: `hooves` is 2,330, `digitigrade` 1,625, and
`animal legs`, `hoof` and `head tentacles` do not exist at all. No weighting
rescues them — the render comes back with human legs and demon horns, reading as
a blue demoness rather than a draenei. When the *defining anatomy* is missing
from the vocabulary, say so before rendering and offer to cover the part that
cannot be drawn (armoured thigh boots hide the leg question entirely) or to pick
a different character. Contrast `dragon horns` (32,766), which exists and is
exactly why Alexstrasza's horns sweep back correctly where the draenei's curled
forward into `demon horns` (61,440).

**An SD1.5 LoRA trigger word in an old prompt is a dead end, not a recipe.**
A vault image whose prompt reads `WOWAlexstrasza` alongside
`<lora:eyeLora_eyesV10:0.5>` looked like the character because a downloaded LoRA
was doing the work. On XL that LoRA has the wrong text-encoder dimensions — it is
parsed, matched against nothing and dropped — leaving the trigger word as
meaningless literal text. Say this plainly when someone asks to reproduce an old
set: the likeness came from a file, not from the prompt, and only an XL LoRA can
bring it back.

**Check the scratchpad prefix is free before queueing.** Every run writes
`<prefix>-*.png`, and two characters sharing a two-letter prefix is not a
cosmetic clash: colliding filenames overwrite the older set, and the survivors
get counted and delivered as the newer character. Alexstrasza on `al-` collided
with an earlier Alice run and nearly shipped her frames under the wrong name.
`ls <scratchpad>/<prefix>-*.png` first; if anything answers, pick another prefix.
When counting progress mid-run, count by prefix and confirm with `find -mmin`
rather than trusting a bare `ls | wc -l`.

**Watch the quote characters in a character tag.** `ninomae ina'nis` carries an
apostrophe, and it is the same class of hazard as the parentheses in
`aqua \(konosuba\)`: build that ID chunk with **double** quotes in the shell,
never single, and verify against the queue file before draining. A mangled
character tag fails silently — the render succeeds and simply is not her.

### And the canvas

A **horizontal** position — anything lying down, missionary, spooning — should
render landscape, `--width 1216 --height 832`, for the same reason the ass
close-up does in `/shotall`: a portrait canvas spends most of its height on
empty space above and below her. Lifted and kneeling positions stay portrait.

**But no act is locked to one canvas (user, 2026-09-05: "we need more
variation").** The table's orientation is the act's *default*; **every third
frame of an act takes the other one**, counted across the whole act rather
than per beat, so a two-frame beat still contributes to the rotation. A
landscape act (irrumatio, the missionary landscape ladder, doggystyle,
spooning) gets portrait frames that stack the bodies vertically; a portrait
act (fellatio, suspended congress, reverse cowgirl) gets landscape frames that
open the scene out. Implemented as a per-act counter in the story file's
`act()` helper — `k % 3 === 0 → flip` — and the presenting beat sends its
all-fours frame landscape. Measured split on a 145-frame set: doggystyle 18
landscape / 8 portrait, reverse cowgirl 10 portrait / 4 landscape, missionary
11 / 11.

Nothing else about the block changes. The identity, wardrobe remnants, setting,
body tags and checkpoint carry through from stage 3 untouched.

**What this command will not do:** write the act tags for you, expand a named
act into a described scene, or add acts beyond those asked for. If no acts are
named, the set ends at stage 3, which is a complete result rather than a
truncated one.

## 7. Render

Always the queue, never tabs — the count is far past two:

```bash
node --env-file-if-exists=.env --experimental-strip-types \
  scripts/open-in-forge.mjs --model <m> [--refiner delburry75 --refiner-switch 0.5] --style <s> \
  --queue --label "<stage>-<n>-<shot>" --render "<scratchpad>/<same>.png" \
  --set "photostory/<character>/<stamp>" --shot-label "<stage> — <shot>" \
  --prompt "..." --negative "..." --adetailer-prompt "..."
pnpm queue --drain
```

**`--set` is what makes the shoot one thing.** A photostory is a progression,
and a progression scattered through a day's output folder is a pile of
unrelated renders again the moment the session closes — which is the problem
this command exists to solve. `<stamp>` is `YYYYMMDDThhmm`, fixed **once** at
the start and repeated verbatim on every queued job across every stage: a fresh
stamp per stage would file each stage as a set of its own and lose the
progression. The flag rides through the queue, so it survives the drain
happening hours later. `--shot-label` says what the stage is, and is what lets
the set be read in the order it was shot rather than by filename.

Then `SendUserFile` per stage as each completes, captioned with the stage and
the shot. Send **stage by stage rather than at the end** — the point of a
progression is seeing it progress, and a stage that came out wrong is worth
catching before the next one renders.

Four things that bite here specifically:

- **Invoke `node` directly, not `pnpm`.** pnpm on Windows doubles backslashes
  in arguments, which silently breaks every escaped character tag —
  `aqua \(konosuba\)` arrives as `aqua \\(konosuba\\)` and stops being the
  character tag at all.
- **`open-in-forge` takes `--width`/`--height`**; `migrate-prompt` takes
  `--size`. Passing the wrong one fails the job silently under a `grep`.
- **A killed drain leaves a live `node` child.** Stopping the background task
  kills the shell only; the child keeps rendering and rewrites the queue file
  underneath you. Check the pid before clearing `render-queue.lock`.
- **`--style` is discarded when `--prompt` is also passed**, because the
  override replaces the whole positive prompt after the rewrite. Bake the style
  tags in by hand, or do not pass `--prompt`.

## Requirements

Forge with the prefill extension, as every command here. `.claude/shot-tags.md`
carries the framing, body-filtering and wardrobe-depth rules this command
leans on rather than restating.
