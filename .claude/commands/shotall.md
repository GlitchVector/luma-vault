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

- **Only the camera-set question is skipped.** The camera set is the entire
  table — all sixteen — plus groups E, F and G. **Everything else is asked,
  and nothing is derived** (user 2026-09-15: "the command has several
  questions, they should all be questioned and you should derive nothing").
  Two `AskUserQuestion` calls before anything renders:
  1. **The figure**, `/photostory`'s four ladders — thickness, breasts, hips
     and thighs, rear ass — with "none, the LoRA's / block's own" as the
     first option on each axis. A "none" axis stays unnamed on every frame
     and the brackets leave it alone.
  2. **Waist · leg length · the legs shot (yes/no) · the character sheet
     (yes/no) · the setting.** A third call asks the **lighting** on its own
     (the tool caps a call at four questions): the options and the exact words
     are *Lighting* in `.claude/shot-tags.md`, and the answer joins the setting
     chunk of every frame, never the style flag. Leg length is `(long legs:1.2)` · `1.5` ·
     `1.8` · `2` as in `.claude/shot-tags.md`; the setting offers a plain
     ground first and two or three scenes. The character sheet still argues
     with `1girl, solo`, so it is asked rather than assumed.
  The answers are the frozen body block and setting for all 51 frames; the
  frames carry ` legs <n>` in their shot label so two boards can share a set.
- **Sizes are answered, not detected.** The old rule read the block and kept
  its figure; a LoRA-driven board has no block, and a detected rung is a
  derivation the user did not make.
- **Say the arithmetic before starting.** Ten singles, seven brackets of two,
  the breast close-up's wardrobe flip, group E's sixteen, group F's four and
  group G's six: **51 renders, roughly 30 minutes warm**. Scale is the reason this command was invoked, but announced rather
  than discovered — unannounced it reads as a hang twice over.

- **The whole run is one set**, named for the command that made it:
  `--set "shotall/<character>/<stamp>"`, with `<stamp>` fixed once at the start
  and repeated on all 51 calls, and `--shot-label` naming the rung. `/shot`'s
  "only for three or more" caveat never applies here — this command is never
  fewer. Say the set name in the closing report, so the sidebar entry can be
  recognised as this run.

- **Angles and canvas vary, the way `/photostory` varies them (user, 2026-09-08:
  "shotall needs more variation regarding camera angles and portrait vs
  landscape mode").** The sixteen are all portrait and mostly level, so the
  board adds group E from `.claude/shot-tags.md` — three-quarter front and
  back, dutch angle, full body from above and from below, lying, sitting,
  kneeling, over the shoulder, walking away — and renders six catalogue shots
  a second time on the other canvas (side profile, cowboy front and behind,
  full body from behind, the ass close-up tall, the breast close-up wide).
  Sixteen more renders.

- **Rear frames state a pose.** Group F from `.claude/shot-tags.md` — bent
  over from below, all fours, arched cowboy from behind, kneeling from behind
  — because the catalogue's own rear entries name no pose, and a character
  whose rear garment comes from a LoRA falls into its training stance on
  every one of them (user, 2026-09-08). Any rear-garment LoRA runs at 0.3 on
  these four. Four more renders. It was 66 with brackets of five, which is
  why the brackets are two now.

- **Six frames are nude.** Group G from `.claude/shot-tags.md` — full front,
  cowboy front, full from behind, bent over from below, lying, all fours —
  with the jewellery, veil, gauntlets and boots kept and every garment negated
  by name (user, 2026-09-08). Six more renders; the board is 51.

Everything else is `/shot`'s, unchanged: the block read, the model default and
positional override, the size ladders and detection, the reframe and
per-frame filtering rules, the landscape ass close-up, sequential `--render`
into the scratchpad with a captioned `SendUserFile` per picture, and the
closing report with the detected figure and each bracket's two rungs.
