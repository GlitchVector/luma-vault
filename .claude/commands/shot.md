---
description: Take a generated image you like and get it from other angles
argument-hint: <image> [model — optional; defaults to the one it was made on]
---

# The same picture, from somewhere else

You have a generation you like. This gets you more angles of it, and changes
nothing else — not the character, the outfit, the body or the setting.

**The second half of every workflow here.** `/sdxl`, `/recreate` and `/swap`
each make *one* picture and are where all the tuning questions live. When one of
them lands, this is where you come for the rest of the set. It asks one
question, and nothing it asks is about the subject.

One shot or twelve, the question is the same; only what happens afterwards
changes, and that is decided for you. **`/shotall`** is this command with the
selection skipped — the whole catalogue, brackets and all, no questions.

## 1. Read the block

```bash
pnpm migrate-prompt $ARGUMENTS --show
```

Three things to take from it, and nothing else needs deciding:

- **The framing it already has** — the ladder rung if it carries one, plus
  `from behind`, `looking back`, `ass focus` and the rest. That is the shot to
  mark as detected in the question below.
- **The checkpoint it was made on**, from `Model:`.
- **The figure, as four rungs.** Map the block's breast, ass, hip and thigh
  tags — weights included — onto the size ladders in `.claude/shot-tags.md`,
  and say the four detected levels in the announcement. The whole set keeps
  this figure; the variation brackets are where size moves.

Do not open the picture. This changes the camera and nothing else, so what the
prompt fails to say about the subject is not its business — that is what `/sdxl`
is for, and if the prompt is thin every angle is thin the same way, which is
what keeps the set a set.

### Which model, without asking

**Default to the checkpoint the original was made on**, when it is installed and
XL — that is what makes these the same picture from other angles rather than
different renders. Pass the substring that finds it, so
`Model: waiNSFWIllustrious_v110` becomes `wai`.

Fall back to the script's own default when that checkpoint is SD1.5 or is no
longer installed, and **say which happened** — a family change moves the style,
and the user did not ask for that.

A model named positionally — `/shot 00205 aniverse` — overrides both.

**The user's standing pick is the refiner pair, not a single checkpoint (2026-09-06).**
`pnpm migrate-prompt <image> vpred --refiner delburry75 --refiner-switch 0.5`: NoobAI-XL
composes the first half of the steps, delburry75 paints the rest. It is what
they chose after four sets side by side ("keep that as selection for all
commands"), so when the original's own checkpoint is not a reason to stay,
offer the pair first. `migrate-prompt` appends `Refiner:` / `Refiner switch at:`
to the settings line; the queue and the API payload carry them through.

## 2. Ask the two extra shots, then where the camera goes

Two `AskUserQuestion` calls, because the shot table needs all four question
slots of its own and the tool caps a call at four.

### Call 1 — the two shots that do not fit the table, and the leg length

The sizes are **not asked any more** — they are detected in step 1, and the
set keeps the input's figure. Exploring other sizes is what the variation
brackets do (see `.claude/shot-tags.md`), shot by shot where size is actually
judged, rather than one global answer up front.

| Question | Options |
|---|---|
| Legs (hips down) | no · yes |
| Character sheet | no · yes — **landscape**, front/back/side in one frame |
| Leg length | `(long legs:1.2)` — the block's default · `(long legs:1.5)` · `(long legs:1.8)` · **max:** `(long legs:2)` — see *Leg length* in `.claude/shot-tags.md` for what a boost does to the framing |

**Detected sizes are still filtered per shot in step 3.** A face close-up gets
none of them whatever was detected — that is not the detection being
overruled, it is the tag not being in frame. Say so when it happens.

### Call 2 — where the camera goes

**One call**: four questions, four options each, `multiSelect: true`, from the
table in **`.claude/shot-tags.md`**. Read that file — it carries each option's
ladder rung and framing tags, and the rules that make them safe to combine.

**Mark the shot it already is** with ` — detected`, first inside its group, and
say it is the framing the prompt currently carries. `AskUserQuestion` has no
real preselection, so that is a label and nothing more: it still needs ticking
to be included, and someone asking for four new angles may not want a fifth of
what they already have.

Tick as many as you like. If nothing comes back, ask once whether they meant to
cancel rather than doing nothing in silence.

## 3. Re-frame each one

Two runs per shot, because the framing tags have to land on the first line and
only the dry run knows what the rest of the prompt became.

```bash
pnpm migrate-prompt <image> <model> --dry-run --shot "<the rung>"
pnpm migrate-prompt <image> <model> --shot "<the rung>" <send flag> \
  --prompt "<the shot's framing tags>\n<every line the dry run printed below the first>"
```

The dry run is worth doing **once**, not once per shot: everything below the
first line is identical across the set, and that is exactly what makes them
comparable.

Both flags on every send. `--shot` is thrown away as far as the prompt goes —
`--prompt` supersedes it — but its *negative* work is not: a wide rung is what
adds `close-up, cropped, portrait, upper body` as the backstop, and that has to
be present for `full body` and absent for `close-up`. Drop the flag and every
wide angle quietly crops at the waist.

The first line is that shot's framing tags, weighted the way the migration
would: `(full body:1.3)` and `(wide shot:1.3)` go in weighted because a bare
wide rung loses to body tags pulling the camera in; tight rungs go in bare.

A shot the catalogue marks **landscape** — the ass close-up, the character
sheet — takes `--size 1216x832` on its send. Everything else stays on the
script's portrait default.

**Cut the body tags to what is in frame.** The rule that matters most, measured
the hard way: a 15-shot set where every single one came back as the same
from-behind ass shot, `portrait, face focus` and `close-up, breast focus`
included. `(huge ass:2)` was the strongest weight in the prompt and simply beat
every rung on the ladder.

| Rung | Keep | Drop |
|---|---|---|
| `close-up`, `portrait` | **the whole body block**: breasts, waist, hips, thighs, `curvy`, and the slider when the build uses one — all at the same weights as the full-body frame | the ass *weight* (a plain `huge ass` stays on a front), legwear, undress state, `arched back`, `bent over`, `legs together`, the leg-length tag |
| `upper body` | the whole body block, as above | the ass weight, legwear, `arched back`, `bent over`, the leg-length tag |
| `cowboy shot` | the whole body block plus the leg-length tag | `bent over` on a front shot |
| `full body`, `wide shot` | all of them | nothing |

**Every frame carries the identical body block** (changed 2026-09-10, twice in
one morning). The first version of this note kept only the hips and thighs on
the tight rungs; the board that followed was "totally inconsistent" because the
face close-up, headshot and hip-focus still had no breast words, the mid rungs
had stepped-down hips and no slider, and then none of those frames respected
its rung anyway — a LoRA or an outfit that names the pelvis pulls a "close-up"
to cowboy distance, and a frame missing a word falls back to the checkpoint's
default figure and sits beside the others as a different woman. On a LoRA whose
captions name the body (`wide hips, thick thighs, large breasts` in every
caption) the shape is bound to those words, not to the trigger, so they must be
present, identical, on every frame. What a rung gates is the *ass weight* on
fronts, the pose words, and the leg-length tag. Nothing else. `/photostory`
had already learned half of this as `BODY_T`.


Drop the **weight** on the ass for anything front-facing — it is not in frame —
but keep the weights on hips and thighs. Removing all three was tried and the
figure came back slim, which is a different picture rather than a different
angle. Full detail in `.claude/shot-tags.md`.

**Colour every garment before the first shot goes out.** A set is only a set
if the stockings are the same colour in all of it. Where the source block
names a garment without its colour, or names a colour weakly next to a
weighted one, add the colour-fused tag (`black thighhighs`), weight it if a
stronger neighbour colour sits beside it, and negate the neighbour colours on
that garment — once, in the wardrobe every shot then carries. The measured
case and the counts are in `.claude/shot-tags.md` ("Every garment carries its
own colour…").

**Strip the old facing tags out of the rest.** The second rule, and the one
people reach for first because turning a picture around is the commonest ask.
On its own it is not enough — this run stripped the facing correctly and still
produced fifteen identical ass shots, because the body tags were untouched. The
migration drops the competing *rung* and leaves `from behind`, `looking back`,
`ass focus`, `from side`, `profile`, `from above` and `from below` exactly where
they are — and on a source whose framing is spread through the prompt rather
than sitting in a first line, they outnumber and outweigh the shot just chosen.
The render faces the old way and nothing says why. See "Clear the old facing
before you write the new one" in `.claude/shot-tags.md`, measured on a real
block from this library.

Only when the new shot faces differently, and only in that direction — turning
*away* is already handled by `enforceFraming`, which also drops the front-only
anatomy and reports both. Pass those notes on: the user wrote those tags and is
entitled to know they are not in that render.

## 4. One or two open as tabs; three or more render in the background

Decided by the count, not by preference — and **a bracketed shot counts as its
two renders** (three for the breast close-up's wardrobe flip), so any bracket
in the selection already puts the run in `--render` territory. The bracket
shots, the two steps and the flip live in `.claude/shot-tags.md` under
"Variation brackets"; render a bracket's two in order, smaller then bigger,
each captioned with its suffix. `.claude/shot-tags.md` has the
measurements under "Getting the shots rendered"; the short version is that a
Forge page's `load` handler runs on Gradio's queue, which drains one event at a
time, so past two tabs they wedge behind each other and no amount of waiting
fixes it.

**One or two — tabs.** Send with no extra flag. Check `/sdapi/v1/progress`
first: a non-zero `job_count` means a render holds the queue and the tab will
sit on "Loading…" behind it. Open the second only once the first has finished
loading — on the condition, never on a timer. A tab is the better answer at this
size because it leaves you somewhere to re-roll and tweak.

**Three or more — `--render`.**

```bash
--render "<scratchpad>/<n>-<shot>.png"
```

One call per shot, sequentially, each waiting for its own render. No browser is
involved: the request queues as *work* and comes back with the picture. Safe
while Forge is busy, because the checkpoint travels in `override_settings` per
request rather than being set globally.

Write into the session scratchpad, not a watched folder — Forge saves its own
copy into its outputs with its own numbering, and that is what puts each picture
in the library.

**A multi-shot run is a set. Say so, on every call.**

```bash
--set "shot/<character>/<stamp>" --shot-label "<the rung>"
```

`<stamp>` is `YYYYMMDDThhmm`, worked out **once** at the start of the run and
repeated verbatim on every call — it is what makes two runs of the same
character on the same day two sets rather than one, so a fresh stamp per call
would file each picture into a set of its own. `<character>` is the danbooru
name; if the shot has no nameable character, drop `--set` entirely rather than
inventing one.

The vault reads these back and lists the run under "Sets" in the sidebar, so a
pass through sixteen angles can be found again as one sitting. It files by
looking in Forge's output folder for the seed it just rendered — nothing is
copied, moved or renamed, and a shot that cannot be filed still says where the
picture is. Only for runs of three or more: a set of one is noise in that list,
so the tab branch above passes no `--set`.

**Show each one as it lands**, with `SendUserFile`, captioned with the shot it
was prompted for. The shot name is the one thing a picture cannot tell you
itself, and a render arriving three minutes later unlabelled is a puzzle.

**Say how long it will take before you start.** Two to four minutes per shot on
this machine, so five is a quiet quarter of an hour. Unannounced, that reads as
a hang.

## 5. Report the set

Number them, because they are indistinguishable once they arrive:

```
1  cowboy shot (front)      — detected
2  full body (from behind)
3  close-up, face focus
```

Then, once rather than per shot:

- **The model**, and whether it is the original's own or a fallback.
- **The detected figure** — the four rungs the set was built on — and, for
  each bracket, the two rungs it stepped to and any axis that held at a
  ladder end.
- **What the framing rules removed or weighted**, from the notes. Identical
  across the set apart from the reframe line — say which line differed.
- **A tag from a free-text shot that is not in the vocabulary.** Other accepts
  anything; `models/anime-tagger/selected_tags.csv` is what the model learned.
  Say it once and send it anyway.

Seeds stay random per shot, which is right: what makes these a set is the shared
prompt, and a seed reused across framings does not reproduce a character anyway.
