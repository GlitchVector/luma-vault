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

| Option | Rung | Framing tags |
|---|---|---|
| Ass focus, low angle | `cowboy shot` | `cowboy shot, from behind, ass focus, from below, looking back` |
| Hip focus (front) | `close-up` | `close-up, hip focus` |
| Breast close-up | `close-up` | `close-up, breast focus` |
| Ass close-up | `close-up` | `close-up, ass focus, from behind` |

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

The character sheet is the one shot that overrides the portrait canvas, and it
is the case the rule was written for: the user asked for landscape in words.

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
  boost on `wide hips`. `(huge ass:2)` in the source became `(wide hips:1.8)`
  on the front shots of one set, and the two angles finally read as one person.
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
anatomy and `looking at viewer` when the framing turns away. It is only
front-facing that needs doing by hand, because there is no tag meaning "facing
forward" for a rule to key on.


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

**The wide backstop is per shot, not per run.** `close-up, cropped, portrait,
upper body` belongs in the negative of the `full body` and `wide shot` tabs and
nowhere else — in a `close-up` tab it argues against the shot being asked for.
Passing `--shot` handles this on a migrated block; composing a prompt you write
the negative yourself, so vary it.

Watch for the inverse too: if the *source* block's own negative already carries
`close-up` or `portrait`, a tight variant is fighting itself before it starts.
Say so rather than sending it quietly.

## Getting the shots rendered

**Two or fewer: open tabs. Three or more: render through the API instead.**

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
