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

**Four at a time. Never the whole set.**

Open at most four, ten seconds apart, then **stop and hand back to the user** —
they render those four and close them, and only then do you open the next four.
Say which batch this is and how many shots are left, every time.

### Why four, and why waiting longer does not work instead

This was measured, not guessed. Twelve tabs were opened at five seconds apart,
then again at ten. Both wedged. Afterwards:

- Forge's **API answered in 2ms** and its log held **zero tracebacks**. The
  server never crashed — only the pages did.
- The log recorded **five** tab loads and then went silent for half an hour,
  through an entire second run of twelve. Tabs six and up were never granted a
  session and never errored; they simply hung.
- Every load that did land logged `Environment vars changed` followed by
  `[GPU Setting] You will use 95.83% GPU memory…`. A Forge tab is not a viewer.
  Each one re-applies **server-wide** settings on `root_block.load` — the same
  hook behind the clip-skip stomp the commands already warn about.

So the limit is **concurrent sessions, not the rate they are opened at**. An
open tab holds its slot for as long as it exists, which is why spacing the
spawns further apart changed nothing and why it never can. Do not "fix" a wedged
run by raising the delay; the only lever is fewer tabs alive at once.

The ten-second spacing stays anyway — it costs 30 seconds a batch, it was in
place for the measurement, and there is no reason to change two variables at
once while the ceiling is still only bracketed between four and twelve.

Never in parallel, either. Beyond the load, each run selects the checkpoint, and
that setting is global — two runs racing on it is the failure both commands
already warn about, arriving from your own loop instead of from a batch.

### When a run has wedged anyway

Restarting Forge clears it, but it kills **every other open tab's session** with
it, and the prefill extension strips the prompt from the URL on first read — so
a reload cannot recover a tab. The wedged ones have to be re-opened from the
command. Say that rather than suggesting a reload.

## Not in the table

`character sheet, multiple views` is a real and useful framing, but it argues
with `1girl, solo` and produces one image of several small figures — which is
the opposite of what a tab-per-shot run is for. Available under Other for
someone who wants it deliberately.
