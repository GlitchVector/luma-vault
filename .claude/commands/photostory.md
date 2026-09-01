---
description: Build a progressive photo set of one character — dressed, then undressed, stage by stage
argument-hint: <image> [model — optional] [bg]
---

# One character, one shoot, in stages

`/shotall` gives you every *angle* of one moment. This gives you one character
across a *sequence*: dressed and posing, then progressively less, each stage
keeping the same person, the same place and the same light so the set reads as
one shoot rather than a pile of unrelated renders.

The input is the same as `/recreate` — an image name from the vault, or an
attached picture. Everything about extraction, the body ladders and the
vocabulary checks is that command's; this one adds the **stage plan**, the
**undress progression** and the **pose rotation**.

**It does not carry a catalogue of sex acts.** The final stage exists and is
wired up, but the tags that fill it come from the user, verified against
`selected_tags.csv` and substituted mechanically — see step 6. Do not invent
them, do not expand a one-word request into a described scene, and do not add
acts that were not asked for.

## 1. Ask, before looking at anything

The same first call as `/recreate` — character and model, one
`AskUserQuestion`, both single-select. Read `.claude/character-tags.md` for the
character half; the model half is the same four options and the same substring
matching.

Then the body axes and the style, exactly as `/recreate` step 3 asks them. The
**shot** question is not asked: this command decides framing per stage.

## 2. Extract once, reuse everywhere

Read the picture into tags following `/recreate` step 2. What comes out is one
identity chunk and one wardrobe, and **both are frozen for the whole set** —
that is what makes it a shoot. Write them down as:

| Piece | Contents |
|---|---|
| `ID` | subject, character tag if any, hair, eyes, face marks, headwear |
| `WH` | wardrobe a head-and-shoulders crop contains — collar, choker, earrings |
| `WT` | down to the waist — top, sleeves, shoulders, jewellery |
| `WF` | all of it — plus skirt, legwear, footwear, pose furniture |

Three depths, not one list. A `close-up` that names boots comes back a cowboy
shot, because the model zooms out to draw what it was told to include.

## 3. The stages

Four, and the third is where most sets end.

| Stage | Wardrobe | Shots |
|---|---|---|
| 1 — dressed | full | 10 |
| 2 — topless | `WT` minus the top | 6 |
| 3 — bottomless | nothing below the waist either | 6 |
| 4 — acts | user-supplied, see step 6 | 2 per act |

Stage 1's ten, with the pose each one carries:

```
1  close-up, face focus          looking at viewer
2  portrait, face focus          looking at viewer
3  upper body (front)            arms behind back
4  upper body (from behind)      looking back
5  cowboy shot (front)           contrapposto
6  cowboy shot (from behind)     looking back, arched back
7  full body (front)             standing, arms up
8  full body (from behind)       leaning forward
9  side profile                  contrapposto
10 from below                    hands up
```

Stage 2 keeps 3, 5, 6, 7 and adds a breast close-up and a `clothes lift` frame.
Stage 3 keeps 5, 6, 7, 8, adds an ass close-up (**landscape, `--width 1216
--height 832`**) and a hip focus.

**22 renders before the act stage**, about 25–30 minutes warm. Say that before
starting.

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

## 5. What stays identical across every stage

- The identity chunk, word for word.
- The setting chunk, word for word.
- The body tags, at whatever rungs the call-2 answers set.
- The checkpoint, the style flag, the quality block, the sampler.
- The ADetailer prompt, which is built from the identity tags and therefore
  never changes either.

Only the wardrobe, the pose and the framing move. If anything else drifts, the
set stops being a shoot.

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

Then build each act's frames as a **guarded substitution** into the stage-3
block — the same mechanism used for every body and wardrobe edit here:

- one tag in, the previous act's tag out and into the negative;
- abort rather than queue if the substitution does not match.

**Frame counts and canvas are per act, not a default.** The sequence below is
the one specified on the first run and is what to reuse unless told otherwise —
each act's count, orientation and escalation was chosen deliberately, and a
uniform "N frames per act" throws that away.

### The established sequence

Tags in brackets are the resolutions already checked against
`selected_tags.csv`; counts are in the findings below. Every frame carries
`1girl, 1boy, hetero, solo focus, faceless male`, drops `solo`, and inherits
stage 3's wardrobe, identity, setting, body rungs and checkpoint.

| # | Act | Frames | Canvas | Shape |
|---|---|---|---|---|
| 1a | Irrumatio over a table | 2 ×2 seeds | landscape | opens the story's act stage. positioned → `(irrumatio:1.4)` + `(tears:1.4)`. **No cum here** — the finish belongs to act 7 |
| 1b | Fellatio, kneeling | 4 | portrait | 2 base; 2 adding `(deepthroat:1.3), (tears:1.4)` |
| 2 | He grips her bare breasts | 3 | portrait | `(close-up:1.6), (breast focus:1.6)`, `grabbing another's breast, groping, nipples` |
| 3 | Missionary, legs held | 4 + 2 + 2 + 3 | portrait, then landscape | exposed → entering → `(deep penetration:1.3)` → `:1.5` + `testicles`; then the last two again in landscape; then two landscape `anal`; then **3 landscape with her legs wrapped around him** — `(leg lock:1.4), hug` (`legs around waist` is not a tag; `leg lock` is 3,432 and needs both the weight and the prop) |
| 4a | Doggystyle | 3 + 5 + 3 | landscape | 3 vaginal, the last with `arms behind back, (arm grab:1.4)`; then **5 anal** — two plain, two arm-pulled, and a final `(deep penetration:2), testicles` frame, the vocabulary's ceiling for depth; then **3 pony-play** — `(bit gag:1.5), harness, gag, gagged, chain, (chain leash:1.4), (holding leash:1.3), (leash pull:1.3), (head back:1.4), looking up, arched back, drooling` (2 vaginal, 1 anal): he holds chains from both sides of the gag and pulls her head back. `pony play`, `head harness`, `bridle` and `reins` are all dead tags; `chain` (82,759) carries the hardware and `looking up` (58,263) carries the pulled-back head, with the thin leash tags weighted as hints. `all fours` stays but the pose drops the arm-grab — her head is what is being pulled. These frames drop `bondage` from the act's negative — it fights the harness — keeping only `rope` |
| 4b | Presenting, gaped | 3 | portrait | **after** the doggystyle, not before. 2 solo standing `bent over, presenting, (gaping:1.4)`; 1 solo `all fours, top-down bottom-up` with the ass **one rung up** |
| 5 | Spooning / side fuck | 2 | landscape | `on side, sex from behind, leg lift`; negate `missionary`. Weakest act in the set — see below |
| 5b | Standing, taken from behind | 3 | portrait | `standing, standing sex, sex from behind, bent over`, both upright, `arms behind back, (arm grab:1.4), (holding another's arm:1.3)`; negate `rope, bondage, all fours, lying` |
| 6 | Suspended congress | 2 + 2 | portrait | forward-facing; `straddling, carrying, standing sex`; then 2 more with both glutes gripped — `ass grab, (grabbing another's ass:1.3)` |
| 6b | Reverse suspended congress | 3 | portrait | **camera in front, she faces viewer**; 1 vaginal, 2 anal, the last with `(ahegao:1.5)` |
| 7 | Reverse cowgirl | 3 + 2 + 2 | portrait | `leaning forward, bent over`, camera behind; negate `cowgirl position`. 3 plain, then 2 with the glute grip as in act 6, then **the last two carry the finish** — `cum, cum in mouth, (cum overflow:1.4), ejaculation` |
| 8 | Piledriver | — | — | **dropped — not renderable, see below** |

Two rules visible in that table and worth stating plainly: **a beat that has a
before and an after gets both frames** (act 3's exposed-then-entering, act 1a's
positioned-then-penetrated), and **an escalation is a separate frame rather
than a heavier tag** — the deepthroat pair, the anal frames, the ahegao frame.

**The finish lands once, at the end.** `cum, cum in mouth, (cum overflow:1.4),
ejaculation` appears only in the last two frames of act 7 and nowhere else. It
used to sit in the irrumatio act as well; having it twice made the sequence read
as two stories rather than one, so the oral act now stops before it.

**Two acts are known-weak and kept anyway.** Act 5 (spooning) and act 1a
(irrumatio) both render inconsistently — the first because `spooning` is 1,424
images and the pose has to be assembled entirely from parts, the second because
the head-over-an-edge geometry has only `upside-down` and `table` to stand on.
Neither is broken enough to drop, but expect a lower keeper rate and do not read
a bad frame there as a prompt error. Act 8 is the case that *was* bad enough.

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

**An expression must go in `--adetailer-prompt` as well.** The face pass
repaints the head crop from its own prompt, so `tears`, `ahegao` or anything
else stated only in the main prompt is painted over by a calm face. This is
invisible at first glance and is the usual reason an expression "did not work".

**Every two-person frame needs `faceless male, solo focus`.** ADetailer runs on
*every* face it detects and applies the same prompt to each — so an expression
in the face pass lands on him too. `faceless male` (26,473) and `solo focus`
(304,477) mean his face is never drawn, which leaves the pass one target. Add
them to every frame with a second figure, not only the ones with an expression.

### And the canvas

A **horizontal** position — anything lying down, missionary, spooning — should
render landscape, `--width 1216 --height 832`, for the same reason the ass
close-up does in `/shotall`: a portrait canvas spends most of its height on
empty space above and below her. Lifted and kneeling positions stay portrait.

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
  scripts/open-in-forge.mjs --model <m> --style <s> \
  --queue --label "<stage>-<n>-<shot>" --render "<scratchpad>/<same>.png" \
  --prompt "..." --negative "..." --adetailer-prompt "..."
pnpm queue --drain
```

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
