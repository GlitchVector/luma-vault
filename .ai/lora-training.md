# Training a character LoRA

Everything a session with no memory needs to train, judge, file and render one of the owner's
character LoRAs. Written 2026-09-21 from the notes of a week of Ari trainings (v1 through
`ari_adopt_v7`) and the six subjects before her. Every rule here cost a run; the dates say which.

Two documents sit beside this one and stay authoritative for their part:

| Where | What |
|---|---|
| `docs/loras.md` | the register: every LoRA, trigger, kind, what each run measured, the verdict. A LoRA not in that table does not exist for the pipeline |
| `packages/core/src/loras.ts` | the short catalogue the app's **LoRAs** panel reads (name, trigger, character, description, `final`/`wip`, `dataset`). Changes together with `docs/loras.md`, and at DATASET time, not verdict time: the line's entry moves to the training about to run (`name`, `dataset`, previous names into `olderVersions`), so the page shows the data that is training |
| `D:\AI\lora-train\TRAINING-A-CHARACTER.md` | the training guide next to the trainer, same rules as §4-§7 here with the run-by-run evidence |
| `D:\AI\lora-train\WORKFLOW.md` | the 2026-09-06 sheet-crop bootstrap loop (crop-sheet, tag-dataset, masked loss). Superseded for new characters by the reference pipeline in §3, still the record for the older LoRAs |
| `openai-character-dataset/README.md` and `.claude/commands/character-refs.md` | the reference-generation pipeline: one image in, the reference set out |

## 1. Where things are

| Thing | Path |
|---|---|
| trainer | `D:\AI\lora-train\sd-scripts` (kohya, main), venv `D:\AI\lora-train\venv` (Python 3.12, torch cu124) |
| runner | `D:\AI\lora-train\train-oracle.ps1 -Name -Epochs -Dim -Alpha -TeLr -Dataset [-MaskedLoss] [-Weights]` |
| base model | `D:\AI\Stable Diffusion\webui\models\Stable-diffusion\Illustrious-XL-v1.1.safetensors` (same family as every checkpoint we render on) |
| output | `D:\AI\lora-train\output\<name>\<name>.safetensors` plus `<name>-0000NN.safetensors` every 2 epochs (a subdirectory, not the output root) |
| installed LoRAs | `D:\AI\Stable Diffusion\webui\models\Lora\final\`, `wip\`, `external\` (§2) |
| datasets | `D:\AI\lora-train\datasets\<name>\` with `dataset-<name>.toml`; prep scripts `D:\AI\lora-train\prep-<name>.py` |
| owner references | `D:\AI\lora-train\sheets\<name>-refs-gen\` and `<name>-face-refs-gen\` (written by `pnpm refs collect`), older hand-made sets `sheets\<name>-refs*`, sheets `sheets\<name>-sheet-*.png` |
| checks | `D:\AI\lora-train\check-crops.py` (flat panels, edge strips, skin saturation), `audit-frames.py` (tagger audit of candidates), `correct-skin.py`, `make-face-masks.py`, `crop-sheet.py`, `tag-dataset.py` |
| tag checker | `scripts/check-tags.mjs <board-script.mjs>` in this repo |
| epoch sweep | `pnpm lora sweep <name> --trigger <word> [--epochs 20,28,final]` (`scripts/lora.mjs`): the fixed 32-frame check per saved epoch on both checkpoints, frames in `D:\AI\lora-train\checks\<name>\`, sheets beside them; `pnpm lora status <name>` for what exists. Refuses while a trainer runs. `/lora` is the command that walks the whole line with the owner |
| dataset viewer | the app's LoRAs page, "Training images" on a card: `lora_dataset` (`apps/desktop/src/lora.rs`) reads the dataset's `.toml` and shows every subset, repeat count and caption; the folder name per LoRA is `dataset` in `packages/core/src/loras.ts` |
| tag vocabulary | `models/anime-tagger/selected_tags.csv` (the tagger's filtered list, so absence is not proof a word is inert; presence is proof it is a tag) |
| reference generator | `openai-character-dataset/` (`pnpm refs init|generate|collect|status <name>`), key in the repo `.env` |
| vault RPC | `POST http://127.0.0.1:7870/luma/v1/rpc` with `{"name":"query_media","args":{"query":{...full MediaQuery incl. "sort"}}}`; deep link `http://192.168.1.160:7870/?set=<slug>` at home, `http://100.72.26.22:7870/?set=<slug>` over the tailnet |
| render sets | `//jebpot/devs/AI/Stable Diffusion/outputs/txt2img-images/<date>/.luma-sets/<slug>.json` |

## 2. The two classes, and the acceptance test

**`final`** is a LoRA that passed the acceptance test and the owner said so. **`wip`** is everything
else we trained, superseded versions included; it doubles as the rebuild queue. `external/` holds
downloaded LoRAs. Forge walks the subfolders and resolves a LoRA by its filename, so moving a file
between folders never changes a prompt. On 2026-09-21 only `ari_adopt_v4` is final.

The acceptance test, decided before anything else: the trigger ALONE renders the character complete.

```
masterpiece, best quality, very aesthetic, absurdres, <framing>
BREAK
<lora:NAME:1.2>, TRIGGER, 1girl, solo
BREAK
<setting words>
```

No hair colour, no eye colour, no garment word, no weights on traits. The fixed check is 32 frames
(six framings, dressed and undressed states, weights 1.0 and 1.2) on **both** checkpoints, delburry75
and plantmilk. Undressed frames are judged only with the bottom named and `(censored:1.4), light
censor` in the negative; a bare state prompt overstates the leak (v4's check said 4/4 rear leaks, the
candidate round with those two things said 28/32 clean).

If the character appears only when the prompt re-describes her, the LoRA has not learned her and no
prompt work fixes that. Retest at 1.2-1.3 before concluding: a checkpoint's own habits can out-vote a
correct LoRA at 0.9.

## 3. One character, start to finish

The order for every rebuild and every new character (owner's decision 2026-09-16: Ari was the pilot,
every other original character is retrained one by one from owner-generated data; nothing else
trains in between).

1. **One source image** from the owner (an adoptable, a commission, his own character sheet). A
   sheet is the better reference: it gives the generator the back, the profile and the detail
   panels at once, and the chain at the nape came out right for the first time from one.
2. **`pnpm refs init <name> --reference <image>`**, then fill `characters/<name>/character.json`
   from the image: `description` (one dense paragraph: hair and where its colour changes, eyes,
   skin, build, every garment with cut, colour, material, every accessory and where it sits,
   footwear, and what she does NOT have) and `audit` (the per-character checklist every frame is
   read against, physics first: how a chain hangs, which side an asymmetric piece sits on, what of
   each accessory shows from front, side, back, above, below). Never copy another character's list.
3. **`pnpm refs generate <name> --dry-run`** prints every request. Show the owner the count and the
   cost class and wait for his go. Never pass `--no-dry-run` while billing is blocked.
4. **`pnpm refs generate <name> --vault`** renders 22 body views and 6 cowboy views at 1024x1536,
   8 upper-body views, 13 portraits and her garment close-ups (`details` in character.json) at
   1024x1024 - every framing a board renders at, native at its own scale (a portrait pass gives an
   819 px head where a 1024x1536 full body gives 287 px, for a quarter of the cost of a 2048x3072
   frame; the same arithmetic is why cowboy and upper are generated rather than cut). The portraits
   keep the top's neckline and collar IN frame since 2026-09-23: cut at the collarbone, they taught a
   strapless top on every face crop of three trainings. Every view carries its own
   rotating neutral background (`config/views.json`), quality `high` (`max` makes no visible
   difference on anime and there is no seed, so two runs are never a controlled comparison). A
   moderation refusal is retried with rewordings up to 30 times, then the view is reported OPEN.
   Results in `characters/<name>/out/` and in the vault as set `refgen-<name>-<stamp>`.
5. **Audit, then hand over.** Open every frame, read it against the `audit` list, send the frames
   individually (never merged sheets) with the differences listed per frame and the view keys in
   order. The owner stars in the vault; his star is the gate, never the audit. A single view is
   re-rendered with `--only <kind>/<id> --redo` and slots back into the same set.
6. **`pnpm refs collect <name>`** copies the starred frames into one folder per kind:
   `sheets/<name>-refs-gen/` (body), `<name>-cowboy-refs-gen/`, `<name>-upper-refs-gen/`,
   `<name>-face-refs-gen/` and `<name>-detail-refs-gen/`, a `.tags.txt` beside each with that
   view's caption words. `--all` when he accepted the whole set in words instead of stars.
7. **Prep** (`prep-<name>.py`, model: `prep-ari-gen-v2.py`, adapted): every reference TRIMMED TO THE
   FIGURE first (`tight()`, per-row edge comparison), then used whole; the cowboy and upper folders
   ARE those rungs, so the prep no longer cuts them out of the body frames (a generated set from
   before 2026-09-23 has no such folders and keeps the 0.42 / 0.66 cuts); details are their own
   subset at low repeats; everything mirrored, portraits whole. The trim is
   not cosmetic: kohya buckets at constant area, so a figure at 54 % of the frame trains at ~450 px
   and at 92 % at ~530x1790 - `ari_gen_v1` lost the shorts' colour on 8-10 of 32 frames to exactly
   that margin (2026-09-22). Measure it: median figure width over the frame must be > 0.85. Captions per
   §5. Repeats balance the rungs: full-body refs highest (they alone carry the outfit's colour
   layout), then faces, then crops. Run `check-crops.py datasets/<name>` and OPEN `edge-strips.png`.
8. **Audit the dataset against the board table** (§6) BEFORE the first train. A row the data cannot
   fill is a request to the owner for source images now, not a discovery after four trainings.
9. **Stage 1**: rank 32 / alpha 16, 20 epochs, dressed data only. Its one job is to render undressed
   candidates.
10. **Undressed candidate round** with stage 1 at 1.2 on both checkpoints: topless and nude, front,
    side and rear, the bottom named on topless frames, `(censored:1.4), light censor` negated, no
    garment negatives, no body words. Set `lora/<name>-candidates/<stamp>`. Audit against the list,
    send individually, the owner stars. Shoes are cut out of every undressed keeper (no footwear
    word in those captions).
11. **Final train**: rank 64 / alpha 32, >= 40 epochs AND at least the reference run's 19,840 steps (see the step budget row), TE lr 1e-4, undressed folders at repeats
    that put them near 15 % of an epoch. Forge OFF for the whole run.
12. **Epoch sweep**: the same 32-frame check on the saved epoch files (e.g. 20 / 28 / final), both
    checkpoints — `pnpm lora sweep <name> --trigger <word>`, which queues only missing frames and
    drains until none are, then builds the sheets. Pick the file by the sheets, never by the loss and never by the final file alone.
13. **The owner's verdict.** Then: copy the file into `models/Lora/final/` (the older versions to
    `wip/`), update the row in `docs/loras.md`, the entry in `packages/core/src/loras.ts`, commit and
    push with the work.

A new character gets one stage-1 train, one candidate round, one final train. A third training means
the DATA is wrong and gets fixed there, never with a fourth (stop rule, 2026-09-18).

## 4. The recipe

| | |
|---|---|
| base | Illustrious XL 1.1, for every LoRA rendered on delburry75, plantmilk, the pies, NoobAI, delnoob |
| rank / alpha | **64 / 32** final; 32 / 16 stage 1 |
| epochs / step budget | **Match the reference run's total steps: `ari_adopt_v4` = 40 epochs, 19,840 steps.** Compute epochs from the dataset: epochs = 19,840 / (images x repeats per epoch / batch 2), never below 40. The old "28-30" came from the v7 sweep, whose 33 % undressed data capped every epoch at ~13/20 - a data ceiling, not proof that 30 is enough. `ari_gen_v1`-`v5` trained at 30 epochs = 12,270 steps (62 %) and shuffled garment colours in all five; on the same check (2026-09-24) `ari_adopt_v4` got 3/16 dressed frames wrong, `ari_gen_v5` 6/16. 20 epochs for stage 1. Always save every 2 epochs and sweep. **Before ANY train: print the new run's steps, epochs, images x repeats per subset and undressed share next to the reference run's log; below the reference budget = do not start** |
| learning rates | unet 1e-4, text encoder **1e-4** (`-TeLr 1e-4`; the runner's default 5e-5 is the old value) |
| optimiser, schedule | AdamW8bit, cosine, min_snr_gamma 5, noise_offset 0.03, bf16, cached latents, sdpa, gradient checkpointing, seed 42 |
| dataset toml | resolution 1024, batch 2, buckets 512-2048 step 64, `shuffle_caption = true`, `keep_tokens = 1`, `caption_extension = ".txt"` |
| undressed share | **~15 % of an epoch**. 16 % (v4) held the outfit on 20/20 dressed frames; 33 % (v6, v7) dropped to 12/20 at weight 1.0 and lost the collar on every face crop, whatever the captions said |
| saves | every 2 epochs, always; the sweep needs them |
| budget | a full rebuild day: stage 1 ~2.5 h, candidates ~20 min, final ~8-9 h, sweep ~30 min. Training runs by daylight when the owner is home (§8) |

```
powershell -File D:\AI\lora-train\train-oracle.ps1 -Name <name> -Epochs <>= 40, from the step budget> -Dim 64 -Alpha 32 -TeLr 1e-4 -Dataset D:\AI\lora-train\datasets\<name>\dataset-<name>.toml
```

`-Weights <file>` continues from a saved LoRA (the optimiser restarts, so pass the learning rates the
schedule would have reached). `-MaskedLoss` for a body-only LoRA (masks from `make-face-masks.py`,
`conditioning_data_dir` in the toml; the body LoRA then never goes into the face pass).

## 5. Captions: the trigger owns everything constant

The rule for every character LoRA (owner, 2026-09-16, "not just the rule for ari_adopt_v2 but for all
LoRAs"): the trigger alone renders the character complete, face, body, hair, accessories and the
default outfit, on any checkpoint. **Captions carry only what varies inside that one dataset.**

```
ari, 1girl, solo, full body, standing, looking at viewer
ari, 1girl, solo, cowboy shot, standing, from behind
ari, 1girl, solo, portrait, close-up, smile
ari, 1girl, solo, full body, standing, topless, breasts out, nipples
ari, 1girl, solo, full body, standing, from behind, completely nude
```

- Framing, pose, view, expression, and the undressed state on undressed frames. An accessory only
  some references wear (`bracelet` on three of twenty-one) is captioned so it stays a prompt word.
- **No trait word, no garment word, no colour, no background word.** A captioned constant binds to
  its word and the trigger stops owning it: `aqua shirt` on every frame meant every board had to say
  six words to get her; `simple background` on every reference meant every board needed that phrase
  and painted teal walls without it. The references now carry ten different backgrounds precisely so
  nothing but her is constant.
- A state word REMOVES a piece of the outfit (`topless` = top off, `completely nude` = all off). It
  never re-names what stays on: `white shorts` captioned on 420 undressed steps per epoch handed the
  shorts' colour to the word and the dressed frames went teal (v6).
- Once a trait varies, every image says which value it has, both sides of the variation. v4 (the old
  line) added undressed frames captioned `topless` to dressed frames captioned with nothing about
  clothes, and the trigger absorbed "sometimes bare".
- A colour shuffle after a trigger-only train means UNDER-TRAINED, not mis-captioned. The same
  captions at rank 32 / 20 epochs shuffled every garment colour; at rank 64 / 40 epochs they held on
  20/20. Give it rank and epochs before touching the captions. **Check this with the training LOGS, not the
  recipe table**: the whole `ari_gen` line (v1-v5) ran at 62 % of adopt_v4's steps while three trainings
  (v3-v5) changed captions - the exact thing this rule forbids (2026-09-24).
- A variant outfit is its own LoRA with its own trigger, trained on the shared head shots plus its own
  body references. Nothing is gained by keeping the main trigger "outfit-neutral". Names follow the
  line (owner, 2026-09-21): `<line>_<outfit>` (`ari_gen_spacesuit`, versions `_s1`/`_v1`), trigger
  `<trigger><outfit>`, refs and dataset `<trigger>-<outfit>`; the app's LoRAs page writes the request
  message (**+ Add outfit** on a card) and `.claude/commands/character-refs.md` § Outfit variants says
  what differs from a new character.
- Text on clothes: caption the printed word beside `clothes writing` (`solen`, `ihs`) and send it in
  the prompt, or the print renders the trigger letters.
- Keep `keep_tokens = 1` so the trigger stays first under `shuffle_caption`.
- The older sheet-crop LoRAs (`tag-dataset.py --drop`) were captioned the other way round, identity
  dropped and outfit kept; that is why they need their outfit named at render time and why they are
  all `wip`. `tag-dataset.py` keeps existing captions unless `--force`.

## 6. Dataset rules

**The board table.** Before the first train, write what the boards will ask for and check each row
against the folder at the scale it will be rendered:

| a board asks for | the data must hold |
|---|---|
| face close-up, portrait | faces at close-up size, native (a 280 px head from a full-body frame blown to 1024 teaches blur; Ari's face was soft for four trainings for exactly this) |
| full body, every angle | front, three-quarter, side, back, from above, from below |
| upper body, cowboy | crops of the references at those rungs, or references at that framing |
| each undressed state | that state captioned, front AND side AND back, at the scale the board renders it |
| colour | measured against the references, no render cast |
| the outfit's small parts (shorts, yoke, cuffs) | the figure fills the frame - `check-crops.py` FILL >= 0.85 per refs subset; a reference with margins trains the garment at half size - AND a `detail` close-up per part in the generated set, so the part is seen large at least once |

**Look at the crops.** `check-crops.py` prints any panel over 60 % one colour and writes
`edge-strips.png`. A 71 %-flat lips panel taught a surgical mask; the sheet's own "FRONT"/"BACK"
labels inside the full-body crops taught lettering, decals and a cat face onto plain garments. No
negative removed either. A numeric text detector was tried and dropped (it flags hair and limbs at
the edge just as readily): open the montage.

**Owner inputs are pixel-identical.** His references and head shots go in trimmed, flipped and
captioned, nothing else. No colour correction (check-crops' saturation lines on them are
information, not a to-do), no background swap (the whiten mask ate her skin, 2026-09-16). Correction
exists only for frames WE rendered (`correct-skin.py`, shown before/after, his pick), and background
variety is a generation setting, never a post-process.

**Candidates.** The bar for a starred keeper is "every garment matches AND the silhouette matches
AND every accessory is physically right at that angle": from behind only the chain shows at the
nape, a pendant on the back or no chain disqualifies; hairband from behind, earrings from the side,
sneakers when the feet are in frame. Five of Ari's sixteen first keepers contradicted her sheet
(black shorts, no collar, an invented midriff band) and cost a night. 48 frames rendered with
`(gigantic breasts:1.3)` carried a cleavage gap the sheet does not have and trained straight in. But
do not drop them all: removing every keeper left the LoRA unable to answer a generic prompt.
Balance keepers by view before training; thirty rear keepers against three fronts taught the Oracle
to answer `portrait` with a rear full body.

**Mirrors** only of symmetric designs. One-sided holsters, a single pauldron, a mechanical left arm,
a back print are never flipped.

**Never touch a dataset while kohya trains on it**; it reads the cached latents and masks every step.

**Resolution.** The trainer caps at 1024. Upscaling never helps (the owner rejected an ESRGAN-upscaled
sheet: "crunchy"). The only thing that must be native at render scale is the face, which is what the
portrait pass of the reference pipeline is for. Small parts (buttons, buckles, D-rings) are not
trained and cost the owner nothing to shoot; say that in the same sentence as "too small to train".

## 7. Rendering with a character LoRA

- **Weight 1.2** for a final LoRA on the checkpoints it was checked on (delburry75, plantmilk); 1.0
  on duo frames was too weak (hair went fully aqua, headband dropped), use 1.1. A checkpoint the LoRA
  was not checked on drifts (novaCartoonXL: 8 of 51 frames with teal shorts); there, naming the
  drifting garment in a fix round works and the trigger alone does not.
- **Undressed frames**: name the bottom on topless frames (`white shorts`), state word alone
  otherwise, `(censored:1.4), light censor` in the negative. Never the full censor set on a LoRA
  whose undressed states are trained: it drew tape and then paint at the nipples. Never negate a
  garment on such a LoRA: a negated colour word recolours the garment (orange, red, black), a negated
  garment noun brings the colour back as paint on the skin.
- **No ADetailer** on a board driven by a character LoRA. The face pass runs its own prompt and, on
  extreme proportions, inpaints a false-positive region with it (a gem on her crotch for hours).
- **Framing words weighted** from the start on a LoRA-driven board (`(cowboy shot:1.4)`,
  `(portrait:1.2)`, `(close-up:1.4)`), the neighbouring rungs negated, shoes out of cowboy frames,
  `ass focus` off the cowboy-behind line, `(head out of frame:1.6)` negated on rear rungs, landscape
  full body at 1.3 not 1.4 (1.4 splits into a turnaround).
- **The build is the prompt's**, never the trigger's: hips, breasts, glutes come from the body block.
  Measured on `msbs` v1-v4: four sheet views do not overrule the checkpoint's body prior.
- **Negative near 20 terms.** 102 terms produced artefacts on most frames, 50 masks on 2 of 5, 20
  clean. When an artefact appears, ask what was added last and try REMOVING it. Never invent a
  multi-word phrase for the negative; it still tokenises.
- **Every weighted word is a tag** (`scripts/check-tags.mjs`): `aqua crop top` at 1.55 did nothing
  for hours, the tag is `aqua shirt`; `text` is `english text`.
- `simple background` never goes into a prompt for a LoRA whose references were captioned with it.
- Rear frames of a character with a multi-view sheet need the heavier duo negative
  `(multiple views:1.5), (reference sheet:1.5), (turnaround:1.4), (2girls:1.4), extra body, clone`.
- Setting and lighting are asked in every render command (`.claude/shot-tags.md` § Lighting has the
  verified tags; `soft lighting`, `cinematic lighting`, `golden hour` are not tags).
- Mira body LoRAs: `<lora:<body>:0.9>, <trigger>, <lora:lcface_v7:0.6>, lcface` with the Lara face
  pair on delburry75 in the face pass; never a body LoRA in the face pass. Details in `docs/loras.md`.

## 8. Working with the owner

- **He judges. I do not issue verdicts.** Every check is the render beside the reference with the
  differences I can see listed; never "this passes", never "fixed". I never send a frame I have not
  opened, and I audit against the image, never from memory (every side-by-side found the fault in
  seconds; every check from recall missed it).
- **Frames go to him individually**, as they render, never as merged sheets, never as a bare count.
  A view key or label goes with each so he can name one back.
- **Stars are his.** Nothing generated or rendered is training data before he has starred it (or
  accepted the whole set in words). My audit passes, when he hands starring back, get 2 stars via
  `set_stars_many`; 4 and 5 are his.
- **A plan is not a run.** Praise for test frames is not approval for a full set or a training; ask
  one plain question and wait for the yes. A question about a LoRA is answered with one render, not
  with training runs. "Use this" on a new sheet means start on it at once.
- **Requirements are a numbered list of inputs with counts** and nothing else in the list; what he
  does NOT need goes in a separate line starting "You do not need". A mechanism explained mid-list
  reads as a demand (it once nearly bought him Topaz Gigapixel).
- **The GPU is loud and shares the apartment with his bed.** Training runs by daylight when he is
  home, starting by ~10:00; overnight only while he is away. Ask before queueing anything long in an
  evening. "Wait with training, I need the GPU" holds until he says otherwise.
- **Never render while training.** Forge beside kohya filled 24 GB, hung Forge and killed the trainer
  with a CUDA illegal memory access at step 3609. Kill Forge (`Stop-Process` on the `launch.py`
  python) before a train, relaunch with `START_FORGE.bat` after the final file exists; every check
  waits.
- **Re-renders reuse the run's stamp** with a label suffix (`-r2`, `-r3`) so they sit beside the frame
  they replace; a fresh stamp per fix round litters the sidebar. Test rounds that are not a board go
  under `lora/<name>/<stamp>`.
- **Never enqueue while a drain runs**; the drain rewrites the queue file from memory after each job.
- **Deep links take the slug** (`lora-ari-adopt-candidates-20260917t1205`, not the slash form).
  Confirm `ok.total` through the RPC before sending one.
- The owner's original characters: the Celestial Oracle, Mira Solen, Kira Voss, Ember Kael, 7C,
  Sable Thorne, Lyra Vane, Rati, Ari. Only Lara Croft is borrowed. He names them; my placeholders are
  replaced when he does.

## 9. Operational gotchas

- `train-oracle.ps1` must stay ASCII: PowerShell 5.1 reads a BOM-less script as ANSI and one
  multibyte dash broke the parser. kohya prints Japanese and needs `PYTHONUTF8=1` and
  `PYTHONIOENCODING=utf-8` (set in the runner) or it dies on its first status line under cp1252.
- The xformers "triton not available" traceback is a warning; filter `triton|ModuleNotFound` out of
  any log monitor or it fires on every start.
- A driver's unattended check is only as good as the script it calls: `node --check <file>` after
  any edit, and make the driver fail loudly when its queue step prints no "queued N" line. A 12-hour
  run once ended with a check that died at module load and a driver that said "CHECK done".
- The runner's defaults (dim 16 / alpha 8, TE 5e-5, 10 epochs) are the 2026-09-06 values; the recipe
  is passed on the command line every time.
- The OpenAI image API: `gpt-image-2.5-sunburst` rejects `input_fidelity` (the client drops it);
  a `bad_request` is not retried; the SDK's size literals are stale (longest edge <= 3840 plus a pixel
  budget; 2048x3072 works, 2560x3840 does not); no seed. The moderation gate false-positives on
  dressed images, hence the retry cap of 30. Nudity is never requested there; tattoos are out until a
  generator keeps them consistent across angles.
- Rescanning a set the watcher caught mid-write leaves failed rows; `retry_failed` fixes them, a
  rescan alone never does.
- **Pausing a training for Forge** (`D:\AI\lora-train\pause-training.py pause|resume|status`,
  kohya venv python): suspends the trainer's process tree at the current step; the trainer keeps
  its ~13 GB of VRAM while paused, which leaves ~11 GB - enough for Forge renders and upscales.
  Pattern the owner uses several times a day: "pause" -> start Forge -> his renders -> "continue"
  -> check Forge is idle (`/sdapi/v1/progress`, `/queue/status`), kill it, `resume`. A reboot while
  paused loses everything after the last epoch file. tqdm's s/it averages the pause in; judge the
  pace from steps between two epoch files.
- **Trim every reference to the figure before it enters a dataset.** kohya buckets at constant
  area, so background margins shrink her: the generated Ari refs at 54 % frame width trained at
  ~450 px and lost the white shorts' colour on 8-10 of 32 frames at every epoch (`ari_gen_v1`);
  the adopt refs at 92 % (`tight()` in the prep) held 20/20. `check-crops.py` now prints a FILL
  line per refs subset and flags anything under 0.85 - run it and fix the prep BEFORE the first
  train, never after a sweep. Model prep: `prep-ari-gen-v2.py` (2026-09-22).

## 10. What the Ari week established (the evidence behind §4-§6)

- v1-v9 of the first line: captions named every constant trait, so `ari_v6` rendered a black-haired
  stranger from the trigger while its boards looked right because the prompt did the work. Sheet
  labels inside the crops and a 71 %-flat lips panel taught marks and a mask. Deleted.
- `ari_v1` / `ari_adopt_v1` (audited data, traits captioned by design for a planned variant): every
  frame right with six words in the prompt; the owner rejected the six words.
- `ari_adopt_v2` / `v3` (trigger-only, rank 32, 16 + 8 epochs): identity and states bound, outfit
  colours shuffled. `v5` (outfit token `aridef`, rank 32): fixed one checkpoint at 1.2.
- **`ari_adopt_v4`** (trigger-only, rank 64 / 32, 40 epochs, TE 1e-4, undressed 16 %): 20/20 dressed
  frames on both checkpoints at both weights; undressed clean once the bottom is named and the
  censor words negated. **Final**, rendered at 1.2.
- `v6` (undressed raised to 33 %): undressed 12/12, dressed 12/20. `v7` (same, `white shorts` removed
  from topless captions): unchanged, so the caption word was not the lever; the undressed share was.
  The v7 epoch sweep put a plateau at ~28 epochs - but v7's 33 % undressed data capped it; it is NOT
  evidence that 28-30 epochs suffice. Do not cite it as the epoch rule.
- Deleted 2026-09-18: `ari_adopt_v1b`, `v2`, `v3`, `v5`, `v6`, `v7`. Kept: `ari_v1`, `ari_adopt_v1`
  (the comic pipeline's pick, needs the trait words), `ari_adopt_v4`.
- 2026-09-20/21: the first reference set generated from the owner's own sheet through
  `openai-character-dataset` (35/35 views, no refusals, ~18 min), three library fixes that every
  later character inherits (per-view backgrounds, a collarbone crop guard on all face views, explicit
  camera-angle wording), the set accepted in full, `prep-ari-gen.py` written (674 images per epoch,
  337 steps at batch 2). Training waits for the owner to free the GPU.
- 2026-09-22: `ari_gen_v1` (30 epochs) and `ari_gen_v2` (same, every reference trimmed to the
  figure) both hold identity on 32/32 and both lose the white shorts on 8-10 of the dressed frames at
  every saved epoch (v2 sweep e20/e28/e30: 8/8/10 of 24, 1.2 always better than 1.0). Doubling the
  figure's pixels changed nothing about the shorts, so the lever is the references' CONTENT (how
  many views show the shorts clearly, front and side, against the undressed share), not their
  scale - audit that before anything trains again (stop rule, §3).
  Audited the same evening: the content difference to `ari_adopt_v4` is ONE caption word - v4 names
  `white shorts` on every topless caption (the shorts vary inside the undressed folders, so §5 says
  name them there), the gen line named them on none. `ari_gen_v3` = v2 + that word on the 42 topless
  captions, nothing else (started 17:37). Until its sweep says otherwise, treat "the bottom is named
  in every topless CAPTION" as part of the recipe, not only of the candidate render prompt.
- 2026-09-24: **the audit above was wrong.** It compared captions and missed the step count: the whole
  `ari_gen` line (v1-v5) trained at 30 epochs / 12,270 steps = 62 % of `ari_adopt_v4`'s 40 epochs /
  19,840 steps, and v3-v5 spent three trainings on caption words. Same 32-frame check, same day:
  `ari_adopt_v4` 3/16 dressed frames wrong (teal shorts from behind only), `ari_gen_v5` e30 6/16 (teal
  shorts, a white top, invented stockings and trousers). The "28-30 epochs" rule is retracted (see the
  step budget row). `ari_adopt_v4` at epoch 24 (~11,900 steps, gen_v5's budget) is rendered on the
  same check to separate training length from data. Standing order: before any train and after any
  failed sweep, diff the run's LOG against the reference run's log first.
