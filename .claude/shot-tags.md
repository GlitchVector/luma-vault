# The shot catalogue

The checkbox list `/sdxl-multi` and `/recreate-multi` ask last. Not a command —
both read this file so there is one copy of the table rather than two that
drift.

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
| Hip focus (front) | `cowboy shot` | `cowboy shot, hip focus, looking at viewer` |
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

## Rules that make the table work

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
On `/sdxl-multi` passing `--shot` handles this; on `/recreate-multi` you write
the negative yourself, so vary it.

Watch for the inverse too: if the *source* block's own negative already carries
`close-up` or `portrait`, a tight variant is fighting itself before it starts.
Say so rather than sending it quietly.

## Opening the tabs

**One at a time, each only after the previous one has finished loading, and
never while Forge is generating.** Not on a timer — on the condition.

### The mechanism, because the obvious fix is the wrong one

A Forge page's `load` handler runs on **Gradio's queue, which drains one event
at a time**. Every tab you open enqueues a job that waits behind every other
tab's job *and* behind any render in progress. A script run returns when it has
*spawned* the browser opener, not when that job has drained — so the loop has no
idea whether the last tab is ready.

This is why sleeping does not work, and cannot: a fixed delay is a guess about a
queue it cannot see. Measured, in this order:

- **Twelve tabs, five seconds apart** — wedged. The API answered in 2ms
  throughout, the log held no tracebacks, and the pages simply sat there.
- **Twelve tabs, ten seconds apart** — wedged identically. Doubling the delay
  bought nothing.
- **Four tabs, ten seconds apart, while renders were running** — one loaded,
  three stuck on "Loading…". The renders were holding the same queue.

Raising the delay is the tempting fix and it is the wrong one every time. The
signal to wait on is the handler *completing*, which it announces in
`webuiorge.log` as `Environment vars changed` followed by `[GPU Setting]`.
Wait for a new one of those before opening the next tab, and give up rather than
stack another tab behind a stuck one.

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
