---
description: Develop a character's canon facet by facet — brainstorm, he picks, approve, repeat
argument-hint: <character id> [facet]
---

# Building a character's canon

The studio holds twelve facet files per character and only two of Ari's have anything in them. This
develops the rest, one narrow question at a time, with the author picking what becomes true.

**The one rule that outranks everything else here: I never approve.** A brainstorm writes a numbered
proposals file, which is not canon. Only `character approve` writes a facet, and it only runs when he
has named the numbers. If he says "they're all good", I still ask which numbers, because "all good"
is praise and approval is a list.

## Where you are

```
pnpm studio plan <character>
```

Prints every facet as done or empty, any proposals still waiting on him, which facet is next and why,
and the asks to use. The order lives in `packages/studio/src/facets.ts` — personality first because
everything is downstream of it, speech and humour next because they are personality made audible,
then history, then relationships which need a history to have happened in, and `current_state` last
because it is the only per-story facet. Do not invent an order; read it.

Start every session with this, and run it again after each approval so the next step is the folder's
answer rather than mine.

## Sheets: the one input that is already decided

She may come with pictures — an adoptable, a commission, a design sheet. File them with her so
nothing has to remember where they were:

```
pnpm studio character sheets <id> --sheet <path> [--sheet <path> …]
```

If he attaches images in the chat instead, save them somewhere and file them the same way; a sheet
that only exists in a message is a sheet the next session cannot see.

**The story model cannot look at them.** `wizard-vicuna-uncensored` is text only. So I open them,
say what I actually see, and write that into `appearance` or `outfits` as a proposal for him to
approve — exactly like any other proposal, never straight into canon. Anything I cannot see clearly I
say I cannot see rather than filling in. `studio plan` lists the sheets so this is not forgotten.

## The loop

1. **Show him where he is.** `studio plan <character>`, and if proposals are waiting, deal with those
   before making more. A pile of unapproved brainstorms is the failure mode to avoid.
2. **Ask one narrow question.** `pnpm studio character next <id>` does the whole step: works out the
   next missing facet, picks an ask that has not been asked before, runs the brainstorm, and prints
   the approve line. It refuses while proposals are waiting unless given `--force`, which is the
   behaviour to want. Use `character brainstorm <id> "<ask>"` when he wants a question of his own
   instead. Never ask a whole facet at once: "how she behaves when embarrassed" gave four genuinely
   different answers, "tell me about her personality" gives mush.
3. **Put the proposals in front of him.** Read the file and summarise each option in a line or two in
   the chat — he should not have to open a file to choose. Say plainly when two options contradict
   each other or contradict existing canon; the model will do that and it is the most useful thing to
   notice. A proposal in the file he already has reached for a bracelet and had to catch itself
   against the bare-wrists rule in `appearance.md`.
4. **He picks.** Numbers, or "none of these, ask again like this".
5. **Approve exactly what he picked.**
   `pnpm studio character approve <id> latest <n,n> --into <facet>`
   It copies those items under a dated heading naming the brainstorm they came from and ticks them
   off, so the same idea cannot be approved twice.
6. **Back to 1.**

## What to watch for

- **Contradictions are information.** Canon is the authority. If a proposal fights `appearance.md` or
  a rule in `world/rules.md`, say which and let him decide — never silently reconcile it.
## The explicit facets

`sexuality` and `boundaries` are marked `explicit` in `facets.ts`, and `character next` refuses to
ask them through the claude fallback. That is routing, not a warning: the fallback's refusal comes
back shaped like an answer and gets written into a proposals file as though the model simply had
nothing to say about her, which is worse than an error because it looks like a result.

**Relay what the model wrote, as it wrote it.** This is an adult book, the characters are adults, and
he is the author deciding what is true about his own character. When I summarise the options for him
to choose between, a sanitised summary is not tact — it makes him approve something other than what
is in the file, and the file is what becomes canon. Same job as every other facet: say what each
option is, say plainly where two contradict each other or fight existing canon, and let him pick.

Two things do not change here. I still never approve, and `boundaries` in particular is his: whatever
the model proposes about what the book will not do is a question for him, not an answer.

- **`sexuality` reads as a checklist until the rest of her exists.** That is why it sits late in the
  order. Do not pull it forward because it is the interesting one.
- **Thin is not done.** `studio plan` marks a facet done as soon as it holds anything. If a facet has
  one approved item and he wants depth, ask the remaining asks for that facet rather than moving on.
- **Nothing here needs the GPU** except the model answering. If a training is running, a local model
  cannot load; say so rather than waiting. The everyday facets still work through `claude-cli`; the
  explicit ones wait, or go to Grok if he says so.

## The model

`pnpm studio model` says which one answers, whether it can, and what the service offers. Run it
before a long session rather than finding out through a failed brainstorm.

`studio.config.json` in the studio root picks two: `model` answers everything, `explicit_model`
answers only the facets marked `explicit` in `facets.ts` and any brainstorm run with `--explicit`.
The owner's rule (2026-09-22): the everyday model is `claude-cli`, and only the delicate facets go
out to Grok. Do not route an ordinary facet through the explicit model to get a better answer.

| | url | model | key |
|---|---|---|---|
| local | `http://127.0.0.1:11434/v1` | `wizard-vicuna-uncensored:30b` | none |
| Grok | `https://api.x.ai/v1` | ask `studio model` | `XAI_API_KEY` in the repo `.env` |
| fallback | — | `claude-cli` | none |

`wizard-vicuna-uncensored:30b` was measured to comply with explicit material where
`mistral-small:24b` refused outright; `dolphin-mistral` is the small fast one. The claude fallback
refuses explicit material, so it can only ever be `model`, never `explicit_model`.

**Local versus hosted is a real choice, not a preference.** Local costs nothing per call, needs the
GPU free, and nothing leaves the machine. A hosted model writes better and is available while the
card is training — and it means the canon and the prompts go to somebody else's server. Say which
one is configured when it matters; do not switch it without being asked.

Every call is assembled from the files, never from what was said earlier in the chat, so the canon on
disk is the only memory.
