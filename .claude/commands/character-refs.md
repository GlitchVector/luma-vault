---
description: Turn ONE image of an original character into the reference set for a full-character LoRA — generated views, owner-starred, collected into the training sheets
argument-hint: <character name> [source image path | attached image]
---

# One image in, a LoRA reference set out

The owner's pipeline since 2026-09-18: he gives one picture of an original character (an adoptable, a
commission, a sheet panel), and every angle, framing and head shot the LoRA needs is generated from it
through the OpenAI image edit endpoint, filed into a vault set he stars, and only what he starred becomes
the dataset's reference folders. Nudity is never requested here: the undressed states come later from a
stage-1 LoRA's candidate round, exactly as with Ari.

**One implementation, in `openai-character-dataset/`** (official `openai` SDK, its own `.venv`). Every part
exists once: the view library `config/views.json`, the prompt template `prompts/global_dataset_prompt.txt`,
the per-character file `characters/<name>/character.json`, and the CLI `src/charrefs.py`
(`pnpm refs <subcommand> <name>` from the repo root). Do not write a second generator, a second slot list
or a second prompt; extend those files.

## 1. Look at the image before anything else

Open the source image. Derive from it, and write into `characters/<name>/character.json`:

- **`description`** — who she is in one dense paragraph: hair (length, shape, colours and WHERE they change),
  eyes, skin, build, then every garment with cut, colour and material, then every accessory and where it sits,
  then footwear, then what she does NOT have (no tattoos, no bracelet, no socks) so the model does not add
  things. This is what every prompt says about her.
- **`audit`** — the per-character checklist every generated frame is read against, physics first: how a chain
  hangs (pendant at the front, only the chain at the nape from behind), which side an asymmetric detail sits
  on, what of each accessory is visible from front / side / back / above / below, button counts, colour
  boundaries. It is different for every character; never copy Ari's.
- **`details`** — her garment close-ups: one entry per small part of the outfit that a full-body frame holds at
  a tenth of the frame (shorts, a collar and yoke, cuffs, shoes, a belt, a choker), each `{id, prompt, tags}`.
  The prompt frames that part large and says what is at the frame's edges; the `tags` name only the framing
  (`lower body`, `close-up`, `feet`, plus `from behind` / `from side`), never the garment - the trigger owns
  the outfit. Ari's six are the worked example. This is the rung the shorts were lost on for three trainings.

`pnpm refs init <name> --reference <image>` writes the skeleton and copies the image; you fill both fields.
Ask the owner only when the image genuinely does not show something the LoRA will need (the back of a
one-view sheet, for example) — then say exactly which extra view he should supply.

## 2. Dry-run, then show the plan

`pnpm refs generate <name> --dry-run` prints every request without sending one. Read it: the description
must appear verbatim, the view count must match `character.json` (default: every view in the library,
22 body + 6 cowboy + 8 upper + 13 face, plus her `details`), the references must be found. Tell the owner
the count, the cost class (quality and size come from `config/defaults.json`; roughly a quarter dollar per
image at high, so about $14 for a full set with six details) and wait for his go — a plan is not a run.

Billing note: if the account's billing is blocked (2026-09-18: card declined), the run stops at the first
`[billing]` error by itself. Never work around that.

## 3. Generate, audit, hand over

`pnpm refs generate <name> --vault` renders the pending views (source attached, high input fidelity),
retries a moderation refusal with reworded prompts up to the cap of 30 and then reports the view OPEN,
saves every image under `characters/<name>/out/` and files a copy into the vault as the review set
`refgen-<name>-<stamp>`, whose deep link it prints (the vault takes the SLUG, lowercase with hyphens).

Then, before he looks: open every frame, read it against the `audit` list, and send the frames as sheets
with the differences listed per frame. Say which views came back open. You do not decide what is correct;
he stars in the vault. Send frames you have opened, never a bare count.

## 4. Collect, and on to the recipe

`pnpm refs collect <name>` copies the STARRED frames into one folder per kind under `D:/AI/lora-train/sheets/`:
`<name>-refs-gen/` (body), `<name>-cowboy-refs-gen/`, `<name>-upper-refs-gen/`, `<name>-face-refs-gen/` and
`<name>-detail-refs-gen/` (a `.tags.txt` beside each carries the caption the prep will write) and names every
view still open or unstarred; `generate <name> --only <view> --redo` fills those. From there the training
recipe in `D:/AI/lora-train/TRAINING-A-CHARACTER.md` applies: the prep takes the cowboy and upper folders as
they are instead of cutting those rungs out of the body frames, and the detail folder as its own low-repeat
subset; then stage 1, undressed candidate round on both checkpoints, stars, final train (~30 epochs,
undressed ~15 %), epoch sweep.

## Outfit variants: the same character in a new outfit

The LoRAs page has **+ Add outfit** on every character's card; it writes the message the owner pastes here,
with his reference image attached. When a message arrives that way (it starts with `/character-refs <trigger>-<outfit> - outfit variant`),
the flow above applies with these differences:

- **The character file starts from the existing one.** Copy `characters/<trigger>/character.json`'s description
  word for word for face, hair, body and accessories; replace only the outfit with what the image shows; rewrite
  the audit list for the new outfit. Her face is not up for reinterpretation.
- **The head shots are shared.** The prep takes the new body references plus the character's existing
  `sheets/<trigger>-face-refs-gen`; the face is constant, the outfit is what varies.
- **Names follow the line** (`outfitLoraNames` in `packages/core/src/loras.ts`): LoRA `<line>_<outfit>` with
  `_s1` / `_v1` versions, trigger `<trigger><outfit>` run together, refs folder and dataset `<trigger>-<outfit>`.
  A variant outfit is its own LoRA with its own trigger, never a second token on the main one.
- **The catalogue entry** is `kind: 'outfit'` with `outfit: '<label>'` and `parent: '<main LoRA>'`, so the
  page lists it under that card with one render, not as a card of its own. A new LINE of the same
  character (a rebuild, `ari_gen` beside `ari_adopt`) has no parent: it is a new LoRA and a new card.

## Rules that bind here

- Owner inputs are never altered (no colour correction, no background swap); generated frames are never
  "fixed" either — a wrong frame is regenerated or left out.
- Nothing generated is training data until he has starred it.
- Retries are capped; an open view is reported, not looped on.
- Tattoos are out until a generator keeps them consistent across angles.
- Every new character gets a row in `docs/loras.md` at dataset time.
