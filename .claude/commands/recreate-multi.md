---
description: Turn an image into a danbooru prompt and open one tab per chosen shot
argument-hint: [image name — optional; attach an image instead]
---

# One prompt, a tab per shot

`/recreate` with one more question and more than one tab. The point is a row of
tabs holding the *same* character, outfit and setting at different framings —
hit Generate down the row and the set comes back consistent, because every chunk
except the framing is identical between them.

## 1. Do everything `/recreate` does, up to and including the last look

**Read `.claude/commands/recreate.md` and follow it.** All of it: the attached
image or the named one, step 1's extraction, the three question calls, step 3's
composition, and step 4's chunk-by-chunk edit. Every rule there holds here — the
canvas, the model question, the BREAK structure, the negative baseline, the
locked chunk 1.

That file is the source of truth and this one is a wrapper. Nothing about
composing the prompt is restated here, so if the two ever seem to disagree, that
one wins.

**Stop before the send.** Step 5 opens a tab; do not. The shots question
replaces that single send.

## 2. The shots question — always last

One `AskUserQuestion` call, four questions, all `multiSelect: true`. The table
is in **`.claude/shot-tags.md`** — read it: it carries each option's ladder rung
and framing tags, and the rules about rungs, body tags and the wide backstop
that make them safe to combine.

**Mark the shot the picture already is.** You read its framing in step 1, and
call 3's shot answer may have already moved it — the detected one is whatever
the composed prompt currently carries, not what the source had. Append
` — detected` to that option's label and put it first inside its own group.
`AskUserQuestion` has no true preselection, so this is a label and nothing more:
say in the question text that it is the framing the prompt currently has and
that it still needs ticking to be included.

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
pnpm open-in-forge --model <m> --prompt "<per-shot>" --negative "<per-shot>" \
  --adetailer-prompt "..." [--style ...]
```

Per shot, exactly two things move:

- **The framing tags in chunk 1**, swapped for that shot's. Weight a wide rung
  — `(full body:1.3)`, `(wide shot:1.3)` — because a bare wide rung loses to
  body tags pulling the camera in; tight rungs go in bare. Quality and style,
  the rest of chunk 1, do not move.
- **The wide backstop in the negative.** `close-up, cropped, portrait, upper
  body` goes in the `full body` and `wide shot` tabs and nowhere else. In a
  `close-up` tab it argues against the shot being asked for, which is the same
  mistake in the other direction.

Chunks 2, 3 and 4 are the text step 4 approved, byte for byte, in every tab.
That is what makes the set a set — with one exception, below.

**A back-facing tab loses its front-only tags, and gets its framing weighted.**
`from behind` beside `cleavage, huge nipples, topless, navel` renders a *front*
view: the framing is outvoted and the tab is wasted. Clearing them is only half
of it — what remains still describes a front view, so the facing tags are
weighted to `(from behind, ass focus:1.5)` and moved to the front. `open-in-forge` does
both for you and reports what it changed, so you do not have to hand-edit each
tab — but say what went in the report, because the user chose those tags and
is entitled to know they are not in that render.


`--adetailer-prompt` also does not vary: it is identity tags — character, hair,
eyes, expression — and none of those are framing. Compose it once and pass the
same string every time.

## 4. Report the row

The tabs are indistinguishable once open, so number them:

```
tab 1  cowboy shot (front)      — detected
tab 2  full body (from behind)
tab 3  close-up, face focus
```

Then show the shared prompt **once**, with the framing line called out as the
only part that differs and each tab's version of it listed under. Repeating four
near-identical prompts buries the one line that is not.

Two things worth saying when they apply:

- **A tag from a free-text shot that is not in the vocabulary.** Other accepts
  anything; `models/anime-tagger/selected_tags.csv` is what the model actually
  learned. Say it once and send it anyway.
- **How long the row took.** At ten seconds a tab the wait is real and worth
  stating, so a quiet minute does not read as the command having hung.

Seeds stay random per tab, which is correct: consistency here comes from the
shared prompt, not from a seed, and a seed reused across framings does not
reproduce a character anyway.
