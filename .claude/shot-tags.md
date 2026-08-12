# The shot catalogue

The checkbox list `/shot` asks. Kept out of that command so the table, the
rules and the measurements sit in one place — `/sdxl`, `/recreate` and `/swap`
each make one picture, and `/shot` is where a set of angles comes from.

## The four questions

`AskUserQuestion` caps a call at four questions of four options each, so the
sixteen shots come as four `multiSelect: true` questions in **one** call. Every
question also carries Other, which is where anything not on the list goes.

### A — Close and upper body

| Option | Rung | Framing tags |
|---|---|---|
| Face close-up | `close-up` | `close-up, face focus, looking at viewer` |
| Headshot | `portrait` | `portrait, face focus, looking at viewer` |
| Upper body (front) | `upper body` | `upper body, looking at viewer` |
| Upper body (from behind) | `upper body` | `upper body, from behind, looking back` |

### B — Cowboy and full body

| Option | Rung | Framing tags |
|---|---|---|
| Cowboy shot (front) | `cowboy shot` | `cowboy shot, looking at viewer` |
| Cowboy shot (from behind) | `cowboy shot` | `cowboy shot, from behind, ass focus, looking back` |
| Full body (front) | `full body` | `full body, standing, looking at viewer` |
| Full body (from behind) | `full body` | `full body, from behind, looking back` |

### C — Focus

| Option | Rung | Framing tags | Canvas |
|---|---|---|---|
| Ass focus, low angle | `cowboy shot` | `cowboy shot, from behind, ass focus, from below, looking back` | portrait |
| Hip focus (front) | `close-up` | `close-up, hip focus` | portrait |
| Breast close-up | `close-up` | `close-up, breast focus` | portrait |
| Ass close-up | `close-up` | `close-up, ass focus, from behind` | **landscape, `--size 1216x832`** |

**The ass close-up renders landscape.** The crop is wider than it is tall —
hips fill the frame sideways — and on the portrait canvas the shot stacks
empty space above and below the one thing it is about. Asked for by name after
a real set and kept since.

### D — Angle and distance

| Option | Rung | Framing tags |
|---|---|---|
| From above | `cowboy shot` | `cowboy shot, from above, looking at viewer` |
| From below | `cowboy shot` | `cowboy shot, from below, looking at viewer` |
| Side profile | `cowboy shot` | `cowboy shot, from side, profile` |
| Wide shot | `wide shot` | `wide shot, scenery` |

The angle entries take `cowboy shot` because an angle is not a distance and the
question still has to answer one. It is also the rung that survives a heavy body
prompt best — `full body` invites the model to shrink the figure until the size
tags stop reading.

### Two more, asked in the sizes call

The table above is exactly sixteen because `AskUserQuestion` caps a call at four
questions of four options. These two do not fit and are asked as yes/no in the
*sizes* call instead, which only uses two of its four slots.

| Option | Rung | Framing tags | Canvas |
|---|---|---|---|
| Legs (hips down) | `lower body` | `(lower body:1.5), (legs:1.3), thighs, standing` | portrait |
| Character sheet | `full body` | `(reference sheet:1.4), (multiple views:1.4), full body, standing, looking at viewer, simple background, white background, front view, back view, side view` | **landscape, `--size 1216x832`** |

`lower body` is weak at 4,426 images, so it needs the weight the same way
`wide shot` does.

**The character sheet cannot be steered per panel, and trying breaks it.** One
prompt drives every view, so a directional tag applies to all of them at once.
Measured across four attempts on one sheet:

- `huge ass` present → every panel turns rear, including the one captioned
  front, which then renders a torso facing forward above hips facing away.
- `navel`, `groin` added to fix that → every panel turns *front*, and the back
  and side views disappear.
- `front view`, `back view`, `side view` → **`front view` is not a tag at all**,
  which is why it never held anything in place. `multiple views` (119,546) and
  `reference sheet` (11,529) are the only real ones.

So describe the body as a silhouette — `curvy`, `voluptuous`, `hourglass
figure` — and then *leave the directions alone*: the three-view spread comes
from `multiple views`' own prior, and every attempt to steer it overrode the
thing that was working. `--negative` does not rescue this either, since
negating `from behind` takes the back panel with it.

If the views have to be right, do not use a sheet. `/shot`'s own `full body
(front)`, `side profile` and `full body (from behind)` are the same three views
as separate images, each with its body tags filtered correctly for the frame it
is actually in. `character sheet` is **not a tag at all** — `reference sheet`
(11,529) and `multiple views` (119,546) are what produce one, and the second is
doing most of the work.

The character sheet overrides the portrait canvas, and it is the case the rule
was written for: the user asked for landscape in words. The ass close-up in
group C is the other landscape shot — see its note there.

## The size ladders

`/shot` does not ask for sizes any more — it **detects** them from the block
and keeps the set on the input's figure. Each axis maps onto a ladder of
rungs, and the rung index is what the variation brackets below step along.

| Rung | Breasts | Ass | Hips | Thighs |
|---|---|---|---|---|
| 0 | *(unnamed)* | *(unnamed)* | *(unnamed)* | *(unnamed)* |
| 1 | `small breasts` | `big ass` | `wide hips` | `thick thighs` |
| 2 | `medium breasts` | `huge ass` | `(wide hips:1.4)` | `(thick thighs:1.4)` |
| 3 | `large breasts` | `gigantic ass` | `(wide hips:1.7)` | `(thick thighs:1.7)` |
| 4 | `huge breasts` | `(gigantic ass:1.5)` | `(wide hips:2)` | `(thick thighs:2)` |
| 5 | `gigantic breasts` | — | — | — |
| 6 | `(gigantic breasts:1.4)` | — | — | — |

Vocabulary honesty, measured against `selected_tags.csv`: every breast rung is
a learned tag (`small` 413k, `medium` 770k, `large` 1.3M, `huge` 173k,
`gigantic` 7.4k). On the ass ladder only `huge ass` (14.5k) is learned —
`big ass` and `gigantic ass` are compositional, and `gigantic ass` is the one
this file already vouches for from real renders. `wide hips` (32k) and
`thick thighs` (83k) are single words, so their rungs are weights.

**Detecting the rung.** Read the block's body tags, weights included. A bare
word sits on its rung; a weight between rungs rounds to the nearest; a weight
on a word that has a *next word* — `(huge ass:1.5)`, `(huge ass:2)` — sits
half a step up: one smaller is the bare word, one bigger is the next word,
bare. `gigantic hips` and `hyper hips` read as hips rung 4. `curvy` and
`narrow waist` are not on ladders — they travel in the shared text untouched.
Say the four detected levels out loud in the announcement, so "the input's
figure" is a statement rather than a shrug.

**Stepping the figure.** A bracket step moves **every in-frame axis one rung
on its own ladder, together** — the whole silhouette scales, which is what
keeps a step reading as the same woman slightly bigger rather than one part
outgrowing her. Per-shot frame filtering still applies first: a breast
close-up steps breasts alone, an ass close-up steps ass, hips and thighs. On
front-facing shots the ass weight has already been swapped onto the hips (the
two-sides rule), so the step moves the hips rung it became. A step below rung
0 drops the tag; a step past the top holds at the top — which is why the
bracket picks its two-step direction by headroom.

## Variation brackets

Seven shots render as a **bracket of five** whenever they are ticked, because
they are the frames size is judged in. Everything else stays a single render.

- Side profile
- Cowboy shot (front)
- Cowboy shot (from behind)
- Cowboy from below
- Full body (from behind)
- Ass close-up
- Breast close-up

The five, in render order, each captioned with what it is:

| # | Suffix | What |
|---|---|---|
| 1 | `base` | the detected sizing — the set's shared figure |
| 2 | `again` | the same prompt, fresh seed — a free re-roll |
| 3 | `smaller` | every in-frame axis one rung down |
| 4 | `bigger` | every in-frame axis one rung up |
| 5 | `bigger2` / `smaller2` | two rungs — **up when every in-frame axis has the headroom, otherwise down**. Bigger is preferred; the ladder end is what forces the other direction |

**The breast close-up gets a sixth: the wardrobe flip.** Read the block's
chest state first. A clothed chest renders once more `topless` with the top
garments dropped; a topless one renders once more wearing a **matching top** —
derived from the outfit that is already there (its colours and style: a lace
set begets a matching lace bra, a white hoodie a white crop top), because an
invented mismatched garment breaks the set the same way a drifting wardrobe
does. Caption it `flip`.

Name bracket files `<n>-<shot>-<suffix>.png` so a set of fifty stays sortable,
and **say the count and the time before starting**: a full board — ten singles
plus seven brackets and the flip — is ~46 renders, around 25 minutes warm.
Unannounced, that is not a quiet quarter of an hour, it is a hang.

## Rules that make the table work
**Filter size tags. Never filter the wardrobe.** Cutting the outfit out of a
tightly framed shot cost two renders in one session: a hip close-up came back in
a black bikini and a legs shot in a black leather corset, both in place of the
white hoodie every other frame was wearing. Whatever sits at the edge of frame,
the model invents the moment the prompt stops naming it — and an outfit that
drifts is the one thing a set cannot survive.

So the wardrobe travels with every shot regardless of the crop. Only `huge ass`,
`wide hips`, `thick thighs` and `large breasts` are ever cut, and only when the
part they describe is genuinely outside the frame. "Not the subject" is not a
reason; "not visible" is.

**But trim it to the frame's depth, or it drags the camera out.** The other half
of the same rule, measured on a 16-shot set whose body tags were already
filtered correctly: `close-up, face focus` and `portrait, face focus` both came
back as cowboy shots anyway. Nothing about the body was at fault — the wardrobe
named `side slit`, `black thighhighs` and `elbow gloves`, and the model zooms out
to draw what it has been told to include. That is the same mechanic the wide-shot
recipe uses on purpose with `boots`, firing in the wrong direction.

Keep three depths of the same outfit and pick by rung, rather than one list:

| Rung | Wardrobe |
|---|---|
| `close-up`, `portrait` | collar, neckline, what a head-and-shoulders crop contains |
| `upper body`, breast close-up | down to the waist; gloves and armlets in, legwear out |
| `cowboy shot` and wider | all of it |

This is *not* the "never filter the wardrobe" failure in disguise. That one was
about garments vanishing from the prompt and being reinvented as something else.
Here every garment in frame is still named — only the ones that cannot be seen
are dropped, and the same three lists are reused across the whole set so nothing
drifts between shots.

**Name a garment's property, not a second garment.** A white dress laced up the
back was prompted with `backless dress` *and* `corset`, and came back as a black
waist-cincher worn over a separate bra and skirt — three garments where the
source had one. `corset` names a thing you put on; the fix was
`cross-laced clothes` (15,633), which names how the thing you already named is
fastened, and the dress came back whole. The same applies to `halterneck`,
`side slit`, `gold trim`, `frilled` and every other cut, trim or fastening:
if the detail is a property of a garment, there is usually a tag that says so,
and reaching for a noun instead adds clothing nobody asked for.

**`--style 2.5d` delivers 3D, and the preset table is why.** Measured across a
session of renders that all came back looking like plastic. The three presets in
`STYLES` (`packages/core/src/migrate.ts`) are:

| | positive | negative |
|---|---|---|
| `2d` | `anime coloring, flat color` | `realistic, photorealistic, shiny skin` |
| `2.5d` | `realistic, shiny skin` | `flat color, anime coloring, photorealistic` |
| `3d` | `photorealistic, realistic, shiny skin` | `anime coloring, flat color, lineart, sketch` |

Two problems, both from the counts:

- **`2.5d` and `3d` differ by one tag, and it has 822 images.** `photorealistic`
  is nearly inert, so the two presets are effectively the same request. Reaching
  for `3d` to get "more real" does almost nothing, and that is not a quirk of
  one checkpoint.
- **Both assert `shiny skin`, at 115,412 by far the strongest tag on the axis.**
  That tag *is* the plastic look. `realistic` is only 19,111, so in `2.5d` the
  gloss outweighs the realism three to one and the result reads as a render
  rather than as semi-real anime.

So on a checkpoint that already leans glossy — perfectdeliberate does — `2.5d`
overshoots into 3D. What actually produces 2.5D is the middle the table has no
entry for:

```
positive:  (anime coloring:1.2)          # 3,057 — too weak unweighted
negative:  (shiny skin:1.3), realistic, photorealistic
```

**Leave `flat color` out of both sides.** Asserting it gives full 2D; negating
it pushes back toward realism. Its absence is what separates 2.5D from 2D — the
shading stays soft instead of going flat.

The general lesson is the one below, applied to a preset table rather than a
prompt: these presets were written by picking sensible-sounding words, and two
of the six are words the model barely knows. Weighting is not a nicety here, it
is what makes a thin tag audible next to a thick one.

**And the checkpoint outweighs all of it.** The same prompt, negative, weights
and seed on `hassakuXLIllustrious_v12Style` came back dramatically flatter than
on `perfectdeliberate_v10` — crisp lines, simplified background, almost no
gradient on the skin. Not a nudge; a different picture on this axis.

**A checkpoint's rendering style is a floor, not a starting point.** Pushed as
far as the weights usefully go — `(anime coloring:1.8), (flat color:1.6)` in the
positive against `(shiny skin:2), (realistic:1.5), photorealistic` in the
negative — `perfectdeliberate_v10` *still* rendered soft gradient shading and
semi-real skin. Two rounds, the second near the ceiling where weights start
warping anatomy instead of changing anything. It never got close to hassaku's
flatness, which hassaku produces with no style tags at all.

So the style tags move a render **within** a checkpoint's band; they do not move
it into another checkpoint's. Want flat? Load hassaku. Want gloss? Load
perfectdeliberate. Reaching for `--style` to cross that gap is the expensive way
to find out it cannot be crossed.

### For actual 2.5D: `--model hassaku --style 2.5d`

Which follows from the floor rule, and is the inverse of what anyone tries
first. **Pick the checkpoint whose floor sits below your target, then push up.**

perfectdeliberate's floor is already at or above 2.5D, so `--style 2.5d` there
can only push further into gloss — that is why a whole session of trying to pull
it *down* failed. hassaku's floor is flat, so the same stock preset lands in the
middle: clean anime linework and face, with volumetric shading and a soft sheen
on the skin.

No weighting, no hand-written style block, no ADetailer split. Confirmed against
the same seed as the failed attempts:

| on hassaku | result |
|---|---|
| no style tags | flat cel — the 2D end of its band |
| `--style 2.5d` | **the target: semi-real shading, anime face** |
| `--style 3d`, even weighted to `(realistic:1.5), (shiny skin:1.5)` | glossier, but *still* an anime face and clean lines |

That last row is the ceiling made visible: hassaku will not become a plastic
render however hard it is pushed, exactly as perfectdeliberate would not become
flat. Two checkpoints, two bands, and the bands barely overlap.

Reaching for the *more realistic* checkpoint when you want semi-real is
backwards. Reach for the flatter one and turn it up.

So reach for the checkpoint before the tags. perfectdeliberate is inherently
glossy and needs `shiny skin` negated to stop reading as a render; hassaku's
Style release is inherently flat and needs the sheen *left in* to reach 2.5D
rather than 2D. Both are Illustrious and take identical settings, so switching
between them costs nothing — see the family note. Two checkpoints from the same
family are not interchangeable on rendering style, whatever they share on
sampler and CFG.

**`selected_tags.csv` is evidence, not a verdict.** Every command here checks
tags against it, and that is worth keeping in proportion: it is the *tagger*
model's vocabulary — the ~10,000 tags it was trained to predict — not the
checkpoint's, and not danbooru's. A tag can be absent from it and still work
perfectly well, because CLIP reads the words compositionally: `gigantic ass` is
not in the file and renders exactly as you would expect, which was confirmed
against many real generations. Absence is a reason to *check*, never a reason to
tell someone their tag does nothing.


**Body tags are framing, not subject — filter them per shot.** The single
biggest failure this table has produced, and it is not close. A weighted body
tag outranks an unweighted rung every time: `(huge ass:2)` in a prompt whose
first line reads `close-up, face focus, looking at viewer` does not describe the
character, it tells the model what fills the frame, and at weight 2 it beats
every rung on the ladder.

Measured, on one 15-shot set: **all fifteen came back as the same from-behind
ass shot** — including `portrait, face focus`, `close-up, breast focus` and
`full body, standing, looking at viewer`. The facing tags had been stripped
correctly. It made no difference, because `(huge ass:2)`, `arched back` and
`bent over` were still in the shared body outweighing everything.

So the body tags are not part of the shared text. Cut them to what is actually
in frame:

| Rung | Keep | Drop |
|---|---|---|
| `close-up`, `portrait` | nothing below the neck | ass, hips, thighs, legwear, undress state, `arched back`, `bent over`, `legs together` |
| `upper body` | breasts, waist | ass, hips, thighs, legwear, `arched back`, `bent over` |
| `cowboy shot` | breasts, waist, hips, thighs | `bent over` on a front shot |
| `full body`, `wide shot` | all of them | nothing |

**Hips and ass are one body seen from two sides — carry the weight across.**
Cutting an out-of-frame tag is right; letting the *figure* change with it is
not. A source asking for `(huge ass:2)` and `(wide hips:1.2)` renders its front
shots visibly slimmer than its back shots if the ass simply loses its weight,
and then the set is two different women.

So when the camera turns, the weight moves to whichever tag shows from the new
side:

- **Source boosted the ass** → front, side and low-angle shots take a matching
  boost on `wide hips`. `(huge ass:2)` in the source needed
  `(wide hips:2), (thick thighs:1.8), (curvy:1.6)` on the front shots before
  the two angles read as one person — 1.8 on the hips alone was tried first
  and was still visibly narrower than the back view. The ass tag is doing
  more work than its number suggests, so the front side needs more than a
  matching weight on one tag.
- **Source boosted the hips** → back-facing shots take the matching boost on
  `huge ass`, for exactly the same reason in reverse.

The number is a judgement, not a formula: match the *silhouette*, and check the
two angles side by side before sending the rest of the set.

**`arched back` and `bent over` are facing tags wearing a pose's clothes.** They
decide which side of the body meets the camera, so they belong in the list you
strip for a front or face shot — not in the pose you preserve.

And weight the rung on a tight shot when heavy body tags survive it:
`(close-up:1.4), (face focus:1.4)`. The wide rungs already get this for the same
reason, which is the half of the rule that was written down first.

**A wide shot needs more than its rung, and more than a weight.** `wide shot`
carries 11,630 training images against `full body`'s 624,413 — a fifty-fold
disadvantage — so it loses to almost anything. `(wide shot:1.3)` alone came back
indistinguishable from a full body. What worked, measured on one render:

- `(wide shot:1.6)`, not 1.3.
- `(scenery:1.3)` beside it. At 42,503 images it is far better learned than the
  rung, and it is the tag that actually asks for an environment.
- **Drop the body size tags entirely.** They pull the camera in, which is the
  whole problem, and at this distance the figure is too small to show them.
  **Check this one against the outfit before believing it.** On a floor-length
  gown it bought almost no extra distance — the dress already fills the frame
  whatever the camera does — and the figure came back visibly slimmer than the
  other fifteen shots, which is a worse failure than a slightly tight wide: the
  set stops being one person. Restoring `(wide hips:1.4), (thick thighs:1.4),
  (curvy:1.4)` gave both the room *and* the silhouette. The rule holds for
  swimwear and short outfits, where the body really is what fills the frame.
- **Name footwear** — `boots`, `high heels`. The model zooms out to fit what it
  has been told to include, and feet are the bottom of the figure.
- Keep `full body` alongside the rung. This breaks "one rung per shot" on
  purpose: `full body` is the far better learned tag and guarantees the whole
  figure, while `wide shot, scenery` pushes the camera back. Measured once, so
  treat it as a recipe rather than a law.

**Clear the old facing before you write the new one.** The migration treats the
ladder rungs as competing and drops the one already there — but `from behind`,
`looking back`, `ass focus`, `from side`, `profile`, `from above` and
`from below` are not rungs, and it leaves every one of them where it is. On a
source whose framing lives *outside* the first line, which is every prompt not
composed by `/recreate`, that means a front shot arrives with `from behind`
still in it, outnumbering and outweighing the rung you just asked for. The
render faces away and nothing says why.

So when the shot you picked faces differently from the prompt you started with,
strip those tags from the whole prompt as you write `--prompt`, not only from
the first line. Measured on a real block: `--shot "cowboy shot"` against a
back-facing source left `from behind`, `looking back`, `(ass focus:2)` and
`(from behind, no panties:1.1)` untouched across two chunks.

The reverse direction is already handled — `enforceFraming` drops the front-only
anatomy and `looking at viewer` when the framing turns away.

**Front-facing has a tag after all: `facing viewer`, 46,277 images.** An earlier
version of this file said no such tag existed, and that was wrong — the claim
came from `front view`, which genuinely is absent (see the character-sheet
notes). `facing viewer` is real, well learned, and is the positive instrument
for a front composition. Use it whenever the prompt carries anything that pulls
the other way, and put `from behind, looking back, ass focus, facing away` in
the negative beside it.

**A weighted ass tag is a facing tag.** Measured on a front-facing source
recreated with `(huge ass:1.5)`: the render came back rear-view with her looking
over her shoulder, in a composition that named nothing about turning around.
`huge ass` is trained overwhelmingly on rear views, so at weight it stops
describing the body and starts deciding which way it points — the same trap as
`arched back` and `bent over`, but less obvious because it reads as a size.

So on any front-facing shot: drop the ass tag entirely if it is out of frame,
and let the hips carry the silhouette. That is the "hips and ass are one body
seen from two sides" rule run in the front direction. If it must stay — to keep
a figure consistent across a set — plain and unweighted is the ceiling.


**One rung per shot, always.** `SHOT_LADDER` in `migrate.ts` treats `close-up`,
`portrait`, `upper body`, `lower body`, `cowboy shot`, `full body`, `wide shot`
and `very wide shot` as competing instructions rather than a midpoint, and
`--shot` deletes every rung in the prompt before writing the one it was given.
So the stacked forms a general danbooru guide recommends — `portrait, upper
body, face focus` — are collapsed here to the tightest rung plus its
modifiers. Write two and one is silently dropped, or on `/recreate`, kept and
fought over.

**Body tags never come from this table.** A guide written for someone starting
from nothing puts `large breasts` and `large ass` in its framing recipes; here
call 2 already answered those axes, and a second rung of the same axis is the
tug of war every other rule in these commands exists to prevent. Take the
framing tags only — the rung, `from behind`, `looking back`, `looking at
viewer`, `face focus`, `ass focus`, `breast focus`, `hip focus`, `from above`,
`from below`, `from side`, `profile`, `standing`, `scenery`.

**A framing that faces away has to be made to win, twice over.** This is the one
rule that breaks the "chunks 2-4 are byte-identical" promise, and it has to.
`from behind, ass focus` beside `cleavage, huge nipples, topless, navel` does
not draw a back view missing those details — the model satisfies the larger,
louder group and **turns her back around**, so the framing loses and the whole
row of tabs comes back as the same angle. No error, nothing in the UI.

`enforceFraming` in `@luma/core` does both halves, and both `open-in-forge` and
`migrateGeneration` call it, so composing a prompt by hand cannot get it wrong.
It reports everything it changed.

1. **It clears the front-only tags** — `cleavage`, every `nipples` form,
   `areolae`, `navel`, `stomach`, `collarbone`, `underboob`, `between breasts`,
   `breast focus`, `topless`, `cameltoe`.
2. **It weights what is left**, to `(from behind, ass focus:1.5)`, and moves it
   to the front. Clearing alone is necessary but not sufficient: what survives —
   `(huge breasts:1.7)`, `(wide hips:1.8)` — is *still* a front-facing
   description as far as the model's learned distribution goes, and two bare
   framing tags do not outrank it. 1.5 was measured. The wide rungs need only
   1.3 against the same body tags, because they are arguing about where the
   camera sits rather than about which way the subject is turned.

A framing already weighted by hand is left alone — a second opinion layered on
top of the first would fight it.

What it deliberately keeps: **breast and hip size**, which still read as
silhouette from behind, and `looking at viewer` whenever `looking back` is also
present, because `from behind, looking back, looking at viewer` is one of the
most common framings there is. And `skirt lift`, which works from either side.

**Crops are the softer version of the same problem.** A `close-up, face focus`
tab still carrying `black skirt, thigh strap, city street` is not contradicting
itself — those tags are merely outside the frame, competing for attention rather
than fighting. Nothing strips them automatically, because "outside the frame" is
a judgement and deleting the setting from a portrait is sometimes wrong. Trim
them by hand when a tight tab comes back busy.

**`hip focus` and the wide rungs do not mix.** It is a camera instruction that
drags the crop back to the hips, which is why the maximum-hips combo drops it
for anything `full body` or wider. The table only pairs it with `cowboy shot`.

**Hip focus means the hips only, and `head out of frame` is what gets you
there.** Asked for as the hip area alone, it kept coming back as a cowboy shot
with her whole face in it. Negating the face does not work — two rounds of it,
first `face, head` and then `face, head, portrait, upper body, looking at
viewer, facial expression`, both lost against a prompt naming hair colour, eye
colour and a character tag. Weighting the rung did not work either:
`(hip focus:1.8), (close-up:1.5), (lower body:1.3)` still drew the head.

What worked in one attempt was asking for the crop positively:

```
(hip focus:1.6), (lower body:1.5), (head out of frame:1.4), cropped torso
```

`head out of frame` is a real tag at 17,569 images and `cropped torso` at
28,143 — both far better learned than `lower body`'s 4,426. The general lesson
is worth more than the shot: **a crop is something to ask for, not something to
negate.** The negative removes content; it does not move the camera.

**The backstop is per shot, not per run — and it cuts both ways.** `close-up,
cropped, portrait, upper body` belongs in the negative of the `full body` and
`wide shot` tabs and nowhere else; in a `close-up` tab it argues against the
shot being asked for. Passing `--shot` handles this on a migrated block;
composing a prompt you write the negative yourself, so vary it.

The mirror image is not automatic anywhere and has to be written by hand. A
tight rung needs stopping from drifting *wide* exactly as a wide rung needs
stopping from drifting tight:

| Rung | Add to the negative |
|---|---|
| `close-up`, `portrait` | `full body, cowboy shot, wide shot, upper body, thighs, legs, feet` |
| `upper body`, tight focus shots | `full body, cowboy shot, wide shot, legs, feet` |
| `cowboy shot` | `close-up, portrait` |
| `full body`, `wide shot` | `close-up, cropped, portrait, upper body` |

The `cowboy shot` row is the one that looks unnecessary and is not. Measured:
`cowboy shot, from behind, ass focus, looking back` beside `(huge ass:1.4)` and
`enforceFraming`'s own 1.5 boost cropped to the hips — which then duplicated the
two shots in group C that are *meant* to be ass close-ups. Three near-identical
rear crops in one set of sixteen.

Watch for the inverse too: if the *source* block's own negative already carries
`close-up` or `portrait`, a tight variant is fighting itself before it starts.
Say so rather than sending it quietly.

## Getting the shots rendered

**Two or fewer: open tabs. Three or more: render through the API instead.**

### Or on a machine that is not this one: `LUMA_FORGE_URL`

`scripts/lib/forge.mjs` reads `LUMA_FORGE_URL` and only defaults to
`http://127.0.0.1:7860`, so every command here can drive a Forge in another
room or on a rented GPU. Three things stop being true when it does, and each
used to fail without saying so:

- **`filename` in a checkpoint listing is a path over there.** `resolveModel`
  sorted by statting it, which threw the moment two checkpoints matched;
  `inspectCheckpoint` opened it, which threw outright. The extension now
  reports `architecture`, `v_pred` and `mtime` on `/luma/v1/checkpoints` so a
  remote caller needs neither. Older installs do not send them, and the client
  falls back to reading the file and then to the name — saying out loud when it
  is guessing, because a guess in a block looks exactly like a fact.
- **`save_images` files Forge's copy on that machine**, and that copy is what
  normally puts a render in the library. Remotely it is turned off, and the
  bytes that came back — they always do, base64 in the response — are written
  to **`LUMA_RENDER_DIR`** instead. Point it at a watched folder. Unset, the
  render still arrives but nothing is indexed, and the command says so.
- **Nothing errors either way**, which is the whole problem: the picture
  appears in the scratchpad and quietly never reaches the vault.

Localhost, `127.0.0.1` and `[::1]` count as local; anything else is remote.
Never expose Forge's API to the internet — it has no authentication. Use the
host's authenticated proxy, or an SSH tunnel and point the URL at the local end.

### Or later, when the room is empty: `--queue`

A 3090 mid-render is loud enough to be antisocial, and a sixteen-shot set is a
quarter of an hour of it. `--queue` writes the job down instead of generating
it, and `pnpm queue --drain` works through the lot whenever nobody minds — a
scheduled task at 3am, or by hand once the flat is empty.

```bash
pnpm open-in-forge <the same flags> --queue --label "<n>-<shot>"
pnpm migrate-prompt <image> <model> <the same flags> --queue --label "<n>-<shot>"

pnpm queue                 # what is waiting, and roughly how long it will take
pnpm queue --drain         # render all of it, one job at a time
pnpm queue --retry         # put the failed ones back to pending
pnpm queue --clear         # forget the finished ones
```

**It composes with `--render` rather than replacing it.** Given both, the job
remembers where the picture should land; given only `--queue`, it goes to
`queue-out` beside the index. So a shot script gains this by adding one flag.

What gets stored is the **finished parameter block and nothing else** — no
image name, no model, no flags. By the time either command has a block, model
resolution, `enforceFraming`, `enforceUndress`, the family tuning and `--style`
have all been applied, so a drained job reproduces byte for byte what a live
render would have sent. There is nothing left to re-derive and therefore nothing
that can drift between queueing and draining.

Three things it does deliberately:

- **A failed job is a row, not an abort** — the same rule the scanner follows. A
  bad tag fails its own job and the drain carries on. But a *connection* failure
  stops the run and leaves the rest pending, because continuing would convert
  the whole queue into failures for a reason that has nothing to do with them.
- **Forge is probed once before anything is marked.** Draining against a Forge
  that is not running would otherwise fail every job in turn, and you would come
  back to a queue that had destroyed itself.
- **The queue is written back after every job**, not at the end, so an
  interrupted overnight run keeps the hours it already spent.

Measured on the 3090 this was written for: **32 seconds** per job at 832x1216
with the 1.5x hires pass and an ADetailer face pass, checkpoint already
resident. The "two to four minutes" quoted elsewhere in this file is the cold
case — the first render after a model switch pays the load as well.

The tab route is pleasant when it works — the picture appears in a page you can
tweak and re-roll from. It stops working at scale, for a reason no amount of
waiting fixes, and past two tabs the failure is more likely than the success.

### Three or more shots: `--render`

```bash
pnpm migrate-prompt <image> <model> <flags> --render "<scratchpad>/<n>-<shot>.png"
pnpm open-in-forge <flags> --render "<scratchpad>/<n>-<shot>.png"
```

One call per shot, sequentially, each one waiting for its own render. No browser
is involved: the request queues as *work*, behind whatever else Forge is doing,
and comes back with the picture. Nothing to stagger and nothing to wedge.

Write each file into the session scratchpad, not into a watched folder — Forge
saves its own copy into its outputs with its own numbering, which is what puts
the picture in the library. The scratchpad copy exists only so you have a path
to hand to the user.

**Show each one as it lands**, with `SendUserFile` and a caption naming the shot
it was prompted for. That is the whole point of this route over a row of tabs:
the shot names are the one thing the pictures cannot tell you themselves, and a
render arriving three minutes later with no label is a puzzle.

**Say how long it will take before you start.** A render is two to four minutes
on this machine, so five shots is a quiet quarter of an hour. Unannounced, that
reads as a hang.

It is safe while Forge is busy. `toApiPayload` sends the checkpoint in
`override_settings`, per request, so nothing changes a global out from under a
running batch — the case `selectCheckpoint` refuses. The render simply queues.

### Two or fewer: tabs, one at a time

**Each only after the previous one has finished loading, and never while Forge
is generating.** Not on a timer — on the condition.

A Forge page's `load` handler runs on **Gradio's queue, which drains one event
at a time**. Every tab enqueues a job that waits behind every other tab's job
*and* behind any render in progress. A script run returns when it has *spawned*
the browser opener, not when that job has drained — so the loop has no idea
whether the last tab is ready.

This is why sleeping does not work, and cannot: a fixed delay is a guess about a
queue it cannot see. Measured, in this order:

- **Twelve tabs, five seconds apart** — wedged. The API answered in 2ms
  throughout, the log held no tracebacks, and the pages simply sat there.
- **Twelve tabs, ten seconds apart** — wedged identically. Doubling the delay
  bought nothing.
- **Four tabs, ten seconds apart, while renders were running** — one loaded,
  three stuck on "Loading…". The renders were holding the same queue.

Those measurements are why the threshold is two and not five. Raising the delay
is the tempting fix and it is the wrong one every time. The signal to wait on is
the handler *completing*, which it announces in `webuiorge.log` as
`Environment vars changed` followed by `[GPU Setting]`. Wait for a new one of
those before opening the next tab, and give up rather than stack another tab
behind a stuck one.

Check `/sdapi/v1/progress` first as well: a non-zero `job_count` means a render
holds the queue, and every tab opened now will stall behind it.

Never in parallel, either. Beyond the queue, each run selects the checkpoint,
and that setting is global — two runs racing on it is the failure both commands
already warn about, arriving from your own loop instead of from a batch.

### Do not trust that log line as a tab counter

It records that the handler *ran*, which is not one-to-one with tabs opened —
fourteen of them have been seen against sixteen completed renders. It is a good
edge trigger for "a slot just freed" and a bad total. An earlier version of this
file used it to claim a measured concurrency ceiling of four; that claim was
wrong, and the ceiling is not a count at all.

### When a run has wedged anyway

Restarting Forge clears it, but it kills **every other open tab's session** with
it, and the prefill extension strips the prompt from the URL on first read — so
a reload cannot recover a tab. The wedged ones have to be closed and re-opened
from the command. Say that rather than suggesting a reload.

## Not in the table

`character sheet, multiple views` is a real and useful framing, but it argues
with `1girl, solo` and produces one image of several small figures — which is
the opposite of what a tab-per-shot run is for. Available under Other for
someone who wants it deliberately.
