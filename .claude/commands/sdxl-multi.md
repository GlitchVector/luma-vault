---
description: Migrate a generation onto a newer checkpoint and open one tab per chosen shot
argument-hint: <image> [model — optional; otherwise you are asked]
---

# One migration, a tab per shot

`/sdxl` with one more question and more than one tab. The point is a row of
tabs holding the *same* character, outfit and setting at different framings —
hit Generate down the row and the set comes back consistent, because everything
except the first line of the prompt is byte-identical between them.

## 1. Do everything `/sdxl` does, up to and including the last look

**Read `.claude/commands/sdxl.md` and follow it.** All of it: step 1's character
and model questions, step 2's look at the picture, step 3's two question calls,
step 4's `--dry-run`, and step 5's prompt edit. Every rule there holds here — the
canvas, the character question, the model question, the locked first line,
`--add`, the family tuning.

That file is the source of truth and this one is a wrapper. Nothing about the
migration is restated here, so if the two ever seem to disagree, that one wins.

**Stop before the send.** Step 5 ends by re-running without `--dry-run` to open
a tab; do not. The shots question replaces that single send.

## 2. The shots question — always last

One `AskUserQuestion` call, four questions, all `multiSelect: true`. The table
is in **`.claude/shot-tags.md`** — read it: it carries each option's ladder rung
and framing tags, and the rules about rungs, body tags and the wide backstop
that make them safe to combine.

**Mark the shot the picture already is.** You read its framing in step 2 and it
is whatever `--shot` would have been. Append ` — detected` to that option's
label and put it first inside its own group. `AskUserQuestion` has no true
preselection, so this is a label and nothing more: say in the question text that
it is the framing the source already has and that it still needs ticking to be
included. Do not assume it — someone asking for four new angles may not want a
fifth tab of what they already have.

If nothing comes back ticked, ask once whether they meant to cancel, rather than
opening zero tabs in silence.

## 3. One run per shot

**One tab at a time, each only after the previous one has finished loading.**
Not on a timer. `.claude/shot-tags.md` has the measurements under "Opening the
tabs"; the short version is that a Forge page's load handler runs on Gradio's
queue, which drains one event at a time — so a fixed `sleep` is guessing about a
queue it cannot see, and twelve tabs wedged identically at five seconds and at
ten. Wait for the handler to log `Environment vars changed`, and stop rather
than stack another tab behind a stuck one.

**Never open tabs while Forge is generating.** Renders hold that same queue.
Check `/sdapi/v1/progress` first — a non-zero `job_count` means every tab you
open now will sit on "Loading…".

```bash
pnpm migrate-prompt <image> <model> <the step 4 flags> \
  --shot "<the rung>" --prompt "<line 1 for this shot>\n<lines 2+, unchanged>"
```

Per shot, exactly two things move:

- **Line 1 of `--prompt`** is that shot's framing tags. Weight the rung the way
  the migration would — `(full body:1.3)`, `(wide shot:1.3)` — because a bare
  wide rung loses to body tags pulling the camera in. Tight rungs go in bare.
- **`--shot "<the rung>"`** is passed as well, and only the ladder rung, never
  the whole tag set.

Everything from line 2 down is the text step 5 approved, byte for byte, in every
tab. That is what makes the set a set — with one exception, below.

**A back-facing tab loses its front-only tags, and gets its framing weighted.**
`from behind` beside `cleavage, huge nipples, topless, navel` renders a *front*
view: the framing is outvoted and the tab is wasted. Clearing them is only half
of it — what remains still describes a front view, so the facing tags are
weighted to `(from behind, ass focus:1.5)` and moved to the front. `migrateGeneration` does
both for you and reports what it changed, so you do not have to hand-edit each
`--prompt` — but say what went in the report, because the user chose those tags and
is entitled to know they are not in that render.


### Why both flags, when `--prompt` overrides the prompt anyway

`--shot` lands before `--prompt` in the rewrite, so its prompt work is thrown
away — but its *negative* work is not. A wide rung is what adds `close-up,
cropped, portrait, upper body` to the negative, and that backstop has to be
present in the `full body` tabs and absent from the `close-up` ones. Passing the
rung is how each tab gets the negative its own framing needs. Drop the flag and
every wide tab quietly crops at the waist.

### And why the flags from step 4 come along again

Each run migrates from the original file from scratch — the block is rebuilt,
not resumed. A `--body` or `--style` left off run three is a tab that silently
disagrees with the other four.

## 4. Report the row

The tabs are indistinguishable once open, so number them:

```
tab 1  cowboy shot (front)      — detected
tab 2  full body (from behind)
tab 3  close-up, face focus
```

Then the change notes, once — they are identical across runs apart from the
reframe line, so printing all of them five times buries the one thing that
differs. Say which of them varied.

Two things worth saying when they apply:

- **A tight tab whose negative already fought it.** If the source block's
  negative carried `close-up` or `portrait`, that tab is arguing with itself.
- **How long the row took.** At ten seconds a tab the wait is real and worth
  stating, so a quiet minute does not read as the command having hung.

Seeds stay random per tab, which is correct: consistency here comes from the
shared prompt, not from a seed, and a seed reused across framings does not
reproduce a character anyway.
