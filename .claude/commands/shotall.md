---
description: Every /shot angle at once, no questions asked
argument-hint: <image> [model — optional; defaults to the one it was made on]
---

# Every angle, without the questions

`/shotall <image>` is `/shot` with the selection skipped: the whole catalogue,
rendered without asking. It exists because ticking all sixteen boxes every time
is a ritual with one answer.

**This file is an alias, not a second flow.** Read `.claude/commands/shot.md`
and `.claude/shot-tags.md` and follow them exactly, with these differences and
nothing else:

- **Both `AskUserQuestion` calls are skipped.** The camera set is the entire
  table — all sixteen — plus the legs shot. The **character sheet is not
  included**: it is the one entry that argues with `1girl, solo` and cannot be
  steered per panel, so it stays behind `/shot`'s explicit yes. Someone who
  wants it asks for it there.
- **Sizes are detected, never asked** — exactly as `/shot` already does. The
  set keeps the input's figure, and the seven bracket shots are where it
  varies.
- **Say the arithmetic before starting.** Ten singles, seven brackets of five,
  the breast close-up's wardrobe flip: **~46 renders, roughly 25 minutes
  warm**. Scale is the reason this command was invoked, but announced rather
  than discovered — unannounced it reads as a hang twice over.

Everything else is `/shot`'s, unchanged: the block read, the model default and
positional override, the size ladders and detection, the reframe and
per-frame filtering rules, the landscape ass close-up, sequential `--render`
into the scratchpad with a captioned `SendUserFile` per picture, and the
closing report with the detected figure and each bracket's two-step direction.
