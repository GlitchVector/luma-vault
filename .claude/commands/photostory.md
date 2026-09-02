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
character half; the model half is the same four options and the same substring
matching.

Then **always ask about the shape** — it is never assumed, even when the user
typed a word like "thick" in the argument. One `AskUserQuestion` call, four
single-select questions, each ladder carrying its boosted rungs so a single pick
captures size *and* boost in one answer:

| Question | Options (recommended first) |
|---|---|
| Breasts | `huge breasts` · `large breasts` · `gigantic breasts` · `(huge breasts:1.3)` |
| Ass | `(huge ass:1.5)` · `big ass` · `huge ass` · `gigantic ass` |
| Hips / thighs | `(wide hips:1.7), (thick thighs:1.6), curvy` · `wide hips, thick thighs` · `(wide hips:1.4), (thick thighs:1.4)` · maximum |
| Narrow waist | `narrow waist` · `no narrow waist` |

The recommended rung on each is the "thick" figure these runs settled on; the
hips **maximum** answer is `/recreate`'s exact combo — `(wide hips:2), (thick
thighs:2), (curvy:2), (narrow waist:2), (hyper hips:2)` — and when it is picked
the narrow-waist question is moot (the combo already carries it). Anything typed
under Other on any axis is passed through verbatim. The answers become the frozen
`BODY_F` / `BODY_R` / `BODY_T` tags reused across every stage (§5).

The **style** question is asked too, exactly as `/recreate` step 3 does. The
**shot** question is not asked: this command decides framing per stage.

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
Everything downstream — the outfit classification in §4, the stages, the acts —
is identical whichever path filled `ID`/`WH`/`WT`/`WF`.

## 3. The stages

Four, and the third is where most sets end.

| Stage | Wardrobe | Shots |
|---|---|---|
| 1 — dressed | full | 10 |
| 1→2 — taking the top off | mid-undress, top only | 2 |
| 2 — topless | `WT` minus the top | 6 |
| 2→3 — taking the bottom off | mid-undress, bottom only | 2 |
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

### Some frames smile — she is not expressionless the whole way

The frozen `ID` carries `expressionless`, which keeps the identity steady, but a
whole set of blank faces reads cold. So **let a handful of frames smile** — a few
of the dressed poses, the undressing bridges especially, the presenting beats.
Swap the expression in **both** places or it does not take: `expressionless` →
`smile` (or `seductive smile`, `grin`, `light smile`) in the `ID` chunk **and**
in `--adetailer-prompt`, because the face pass repaints the head from its own
prompt and a calm face there paints over a smile asked for only in the main
prompt (the same rule as `tears`/`ahegao` in §6). Keep it to *some* frames — the
contrast is the point; a set that smiles in every frame is as monotonous as one
that never does. The act stage stays with its own expressions (neutral, `tears`,
`ahegao`), not smiles, unless the user asks.

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
`1girl, 1boy, hetero, solo focus, faceless male`, drops `solo`, and inherits the
act-stage wardrobe (§4 — bare body, accessories only), identity, setting, body
rungs and checkpoint.

| # | Act | Frames | Canvas | Shape |
|---|---|---|---|---|
Counts below are the **doubled** counts, standing since the Aqua run. Every act
except 4b renders twice what it first did — a single position needs the volume
to give a usable spread, and 4b (presenting) is the one beat that read fine at
three. Do not halve them back without being asked.

| 1a | Irrumatio over a table | 2 beats ×4 seeds = 8 | landscape | opens the story's act stage. positioned → `(irrumatio:1.4)` + `(tears:1.4)`. **No cum here** — the finish belongs to act 7 |
| 1b | Fellatio, kneeling | 8 | portrait | 4 base; 4 adding `(deepthroat:1.3), (tears:1.4)` |
| 2 | He grips her bare breasts | 6 | portrait | `(close-up:1.6), (breast focus:1.6)`, `grabbing another's breast, groping, nipples` |
| 3 | Missionary, legs held | 8 + 4 + 4 + 6 | portrait, then landscape | exposed → entering → `(deep penetration:1.3)` → `:1.5` + `testicles` (8 portrait across the ladder); 4 landscape repeats of the deep pair; 4 landscape `anal`; then **6 landscape with her legs wrapped around him** — `(leg lock:1.4), hug` (`legs around waist` is not a tag; `leg lock` is 3,432 and needs both the weight and the prop) |
| 4a | Doggystyle | 6 + 10 + 6 | landscape | 6 vaginal, some with `arms behind back, (arm grab:1.4)`; then **10 anal** — plain, arm-pulled, and `(deep penetration:2), testicles` frames at the vocabulary's ceiling for depth; then **6 restrained** — `choker, collar, (chain:1.2), (chain leash:1.4), leash, (holding leash:1.3), (leash pull:1.3)` (mostly vaginal, some anal): a chained collar he holds and pulls her by. **Use a collar, not a bit gag**, and do **not** stack `head back` + `looking up` — that pair renders a head twisted past 90°. `bit gag` (2,810), `harness`, `pony play`, `head harness`, `bridle` and `reins` are all dead or near-dead; `choker` (320,504) and `collar` (157,883) hold reliably. Negate `bit gag, gag, harness` so the earlier gear does not creep in |
| 4b | Presenting, gaped | 3 | portrait | **not doubled** — the one act that read fine at three. **after** the doggystyle, not before. 2 solo standing `bent over, presenting, (gaping:1.4)`; 1 solo `all fours, top-down bottom-up` with the ass **one rung up** |
| 5 | Spooning / side fuck | 4 | landscape | `on side, sex from behind, leg lift`; negate `missionary`. Weakest act in the set — see below |
| 5b | Standing, taken from behind | 6 | portrait | `standing, standing sex, sex from behind, bent over`, both upright, `arms behind back, (arm grab:1.4), (holding another's arm:1.3)`; negate `rope, bondage, all fours, lying` |
| 6 | Suspended congress | 4 + 4 | portrait | forward-facing; `straddling, carrying, standing sex`; then 4 with both glutes gripped — `ass grab, (grabbing another's ass:1.3)` |
| 6b | Reverse suspended congress | 6 | portrait | **camera in front, she faces viewer**; 2 vaginal, 4 anal, two of them with `(ahegao:1.5)` |
| 7 | Reverse cowgirl | 6 + 4 + 4 | portrait | `leaning forward, bent over`, camera behind; negate `cowgirl position`. 6 plain, then 4 with the glute grip as in act 6, then **the last four carry the finish** — `cum, cum in mouth, (cum overflow:1.4), ejaculation` |
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
