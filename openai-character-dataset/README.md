# openai-character-dataset

## Purpose

One image of an original character in, the reference set for a full-character LoRA out.
Every angle, framing and head shot the LoRA needs is generated from the source image
through the OpenAI Images API (`images.edit` with the reference attached), filed into the
image vault as a review set the owner stars, and only the starred frames are copied into
the training sheet folders. The training recipe itself lives in
`D:\AI\lora-train\TRAINING-A-CHARACTER.md`; the Claude Code command `/character-refs`
drives this project end to end.

This is the single implementation. Every part exists once:

| Part | Where |
|---|---|
| shared settings (model, quality, sizes, retry cap, vault) | `config/defaults.json`, overridable by env |
| the view library: 22 body + 13 face views, each with the image-model prompt AND the caption tags | `config/views.json` |
| the prompt template both layers are built from | `prompts/global_dataset_prompt.txt` |
| one character: description, audit list, references, view selection, overrides | `characters/<name>/character.json` |
| the CLI: `init`, `generate`, `collect`, `status` | `src/charrefs.py` |

## Setup

```
python -m venv .venv
.venv\Scripts\Activate.ps1          # Windows PowerShell; on Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and put the real OpenAI API key in it, or leave it in the
repository's own `.env` one folder up: the CLI reads both. `.env` is ignored by git and is
never committed. From the repository root, `pnpm refs <subcommand> <name>` runs the CLI.

## A new character, step by step

1. `pnpm refs init <name> --reference <image>` creates `characters/<name>/character.json`
   and copies the image beside it. Fill `description` (who she is, every garment and
   accessory, and what she does not have) and `audit` (what every generated frame is
   checked against, physics first) from the image. Nothing renders while either is empty.
2. `pnpm refs generate <name> --dry-run` prints every request in full and sends nothing:
   model, size, quality, the call, the references, the output path, the caption tags and
   the final prompt. Check the count and the description, then decide.
3. `pnpm refs generate <name> --vault` renders the pending views. A moderation refusal is
   retried with reworded prompts up to the cap of 30, then the view is reported **open**
   and the run moves on. Images land in `characters/<name>/out/` and, with `--vault`, in
   the vault's watched folder as the set `refgen-<name>-<stamp>` (deep link printed; the
   vault takes the slug). One failing view never stops the batch; an authentication or
   billing error does.
4. Star the correct frames in the vault.
5. `pnpm refs collect <name>` copies the starred frames into
   `D:\AI\lora-train\sheets\<name>-refs-gen\` and `<name>-face-refs-gen\`, a `.tags.txt`
   beside each with the caption for that view, and names every view still open or
   unstarred. `generate <name> --only body/05-back --redo` fills a gap.

`pnpm refs status <name>` shows done / open / pending and the review set link.

## Settings

`config/defaults.json` holds the model (`gpt-image-2.5-sunburst`), quality (`high`), the
body and face sizes, `dry_run`, the retry caps, the rewordings used on refusal, and the
vault paths. Environment overrides: `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`,
`OPENAI_OUTPUT_FORMAT`, `OPENAI_IMAGE_SIZE` (body views), `LUMA_VAULT_OUTDIR`, `LUMA_RPC`.
A character may override any setting under its own `"settings"`. The installed SDK
accepts qualities `low`, `medium`, `high`, `xhigh`, `max`, `auto`; unknown values are
passed through with a warning so a newer service value still works.

## Dry run and billing

`dry_run` is `true` in the defaults. While the account's billing is blocked, leave it so:
`--no-dry-run` sends real requests, and the first `[billing]` answer stops the batch. When
billing works, set `"dry_run": false` (or pass `--no-dry-run`) and run step 3.

## Errors you may see

| Situation | What you get |
|---|---|
| a config file missing or malformed | the path and the line/column |
| description or audit empty | the character file named, nothing sent |
| reference image missing | a warning in dry run, a refusal to run live |
| `OPENAI_API_KEY` missing or rejected | `[auth]`, batch stops |
| billing or quota problem | `[billing]`, batch stops |
| moderation refusal | `[moderation]`, reworded retry, then the view is open |
| invalid response data | `[invalid_output]`, counted as a service error |
| cannot write a file | the path and the OS error |
| vault unreachable on `collect` | the endpoint named |

Anything shaped like an API key is masked before it reaches the console or a log file.

## Layout

```
openai-character-dataset/
  README.md  requirements.txt  .env.example  .gitignore
  config/defaults.json  config/views.json
  prompts/global_dataset_prompt.txt
  characters/<name>/character.json  reference*.png  out/  state.json
  logs/   output/.gitkeep (unused; results live under characters/<name>/out)
  src/charrefs.py  config_loader.py  prompt_builder.py  file_utils.py  logger_utils.py  openai_image_client.py
```

Nudity is never requested here; undressed training frames come from a stage-1 LoRA's
candidate round, as described in the training guide. Tattoos are out until a generator
keeps them consistent across angles.
