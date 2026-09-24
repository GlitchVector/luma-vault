---
description: Train a character LoRA with the owner — references, dataset, stage 1, the candidate round he stars, the final train, the epoch sweep, his verdict, the register
---

# Training a character LoRA, with the owner

One character, start to finish: references, dataset, stage 1, the candidate round he stars, the
final train, the epoch sweep, his verdict, the register. The rules are in `.ai/lora-training.md`
and this does not restate them; it says what to run, in what order, and where he decides. Read that
file's §3 before the first step of any character.

**What is his, not mine:** every verdict on a render (I build the side-by-side and list the
differences against the reference; I never say it matches), the stars in a candidate round, the
choice of epoch file, and the go for every training and every full render. Praise for a test frame
is not a go for the run. Every decision is a click (`AskUserQuestion`), and a typed answer in his own
words outranks the options.

## Where things are, in one line each

- `pnpm lora status <name>` — what exists for a training: saved epochs, the trainer's last progress
  line, whether a trainer is running, whether Forge is up, which epoch files are in Forge, which
  checks have run and where their sheets are. Start every session on a character with this.
- `pnpm lora sweep <name> --trigger <word> [--epochs 20,28,final]` — the fixed 32-frame check on
  each saved epoch, both checkpoints, 1.0 and 1.2, trigger only; frames in
  `D:\AI\lora-train\checks\<name>\`, sheets in `checks\<name>\sheets\`. It refuses while a trainer
  runs, starts Forge if needed, queues only missing frames and drains until none are missing.
- `D:\AI\lora-train\train-oracle.ps1 -Name <name> -Epochs N -Dim D -Alpha A -TeLr L -Dataset <toml>`
  — the runner; the recipe is passed every time (§4). Started detached, log to
  `output\<name>.log` and `.err.log`.
- `D:\AI\lora-train\prep-<name>.py` — one per character, writes `datasets\<name>\` and its `.toml`;
  `check-crops.py datasets\<name>` before any train (FILL ≥ 0.85, no flat panels, no sheet text).
- `/character-refs` — the reference set from one image, when he has no owner-picked references.
- `docs/loras.md` (the register) and `packages/core/src/loras.ts` (the app's catalogue): a row at
  dataset time, updated per verdict, committed with the work. At dataset time the line's catalogue
  entry MOVES to the new training - `name` becomes the file about to train, `dataset` the new
  folder, the previous names go into `olderVersions` - so the page's "Training images" always shows
  the data that is training, not the data of three trainings ago (owner, 2026-09-23: the Ari card
  still showed v1's set while v4 was being prepped). Step 3 below does it, not the verdict.

## The line, step by step

Ask which step he is at with one question whose options are the steps below, defaulting to what
`status` implies (no dataset → 1; dataset, no output → 3; epochs saved, no checks → 6; checks
built → 7).

1. **References.** Owner-picked renders or `/character-refs`. Trim to the figure. Open
   `check-crops.py`'s `edge-strips.png` and say what is in it. Then the board table (§6): for every
   framing and state a board will ask, the data must hold it at that scale. A row it cannot fill is
   a request to him for source images, said as a list of inputs with counts, not as advice.
2. **Dataset.** `prep-<name>.py`: captions are the trigger and only what varies inside the set (§5).
   The bottom is named in every topless caption, because the shorts vary between topless and nude and
   a garment with no word has no anchor (Ari, 2026-09-22). Show him the per-folder counts and the
   undressed share, and ask for the go.
3. **Stage 1** (rank 32 / alpha 16, 20 epochs, dressed data only). Forge off for the whole run —
   `status` says whether a trainer runs; never render beside one. Say when it will end, from the
   steps and the s/it of the first minutes, and leave it; the log is checked when he asks or when it
   is due, not polled.
4. **Candidate round** with stage 1 at 0.8 and the traits named (§3.10): undressed states, front,
   side and rear, bottom named, censor words negated, into a set `lora/<name>-candidates/<stamp>`.
   Audit every frame against the reference and send them individually with the differences listed;
   he stars. Then a second round for the slots that failed if he wants one, into the same set.
5. **Final train** (rank 64 / alpha 32, >= 40 epochs and at least `ari_adopt_v4`'s 19,840 steps, TE lr 1e-4,
   undressed folders near 15 % of an epoch). Start it ONLY with `pnpm lora train <name> --dataset <toml> --go`,
   and only after the owner's explicit go: the gate computes the epochs from the dataset, shows the budget
   table (send it to him) and refuses a run below the reference in `scripts/lora-recipe.json`. After a failed
   sweep, `pnpm lora diff <name>` FIRST - never change captions while the budgets differ. His go, Forge off, saved every 2 epochs.
6. **Epoch sweep.** `pnpm lora sweep <name> --trigger <word>` on 20 / 28 / final. Open every sheet
   before sending it. For each: what holds on every frame, what drifts, on which checkpoint and
   weight, counted (dressed right of N, undressed clean of N, the recurring garment, the blob
   family). Send the sheets with the counts; never a bare number, never a verdict.
7. **His verdict.** One question: which epoch file, or none. Then the file into
   `models\Lora\final\` (or the older versions to `wip\`), the row in `docs/loras.md` and the entry
   in `loras.ts` updated with what was measured, committed and pushed with the work.

A third training on the same data means the data is wrong: fix the data, name the one variable,
and say which measurement will tell whether it was the lever. A run whose sweep matches the previous
one's numbers is evidence about the data, not a reason for a fourth.

## What to watch for

- **The numbers must be comparable.** The sweep's prompts, negatives, scene and framings are fixed in
  `scripts/lora.mjs` and have been since 2026-09-16; do not "improve" them for one line, or its
  counts stop meaning anything against the ones in the register.
- **1.2 is the weight to read.** 1.0 is the stress test; a checkpoint's own habits out-vote a correct
  LoRA at low weight. Say both, judge at 1.2.
- **The queue loses jobs when a drain dies under a stale lock.** The sweep tops up missing frames
  until none are; if it still reports missing frames after its passes, run it again rather than
  hand-queueing.
- **GPU noise is his call, not a rule.** Never delay or question a run because of the hour; say how
  long it will take and let him decide.
- **Re-renders reuse the stamp.** A fix round goes into the run's own set with a label suffix, not a
  fresh set.
