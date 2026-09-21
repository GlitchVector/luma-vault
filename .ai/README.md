# .ai

Deep-dive notes, one file per concern. `CLAUDE.md` carries only what is needed
on every task and points here for the rest.

| File | Read it when |
|---|---|
| `architecture.md` | Changing the pipeline, the layer boundaries, or the FFI wire format |
| `conventions.md` | Writing code: adding a command, a schema, a contract, a UI component |
| `gotchas.md` | Something behaves unexpectedly, or you are about to remove something that looks redundant |
| `testing.md` | Adding or changing tests |
| `lora-training.md` | Training, judging, filing or rendering with one of the character LoRAs: the recipe, the caption rule, the dataset checks, how the owner is worked with, what the Ari week proved |
| `comics.md` | Anything comics: the picture pipeline (`packages/comic`), the Comics panel, the studio (`packages/studio`), the decisions the owner made, what is verified and what is not |

## Ground rules for editing these files

- **Facts only, paths always.** Every claim should be checkable against a file.
  Prefer `apps/desktop/src/pipeline.rs` over "the scanner".
- **No secrets.** This directory is public.
- **Capture learnings in the PR that earned them.** A debugged footgun goes to
  `gotchas.md`, a new ritual to `conventions.md`, a structural change to
  `architecture.md` — in the same PR. A lesson that only lives in a PR
  description is lost.
