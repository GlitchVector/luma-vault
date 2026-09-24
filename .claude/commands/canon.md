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

Every choice he makes in this loop is a click, not typed numbers. `AskUserQuestion` is the way he
picks; the chat is where the options are explained. Never make him open a file, and never make him
type "1,5" when a checkbox would do.

1. **Show him where he is.** `studio plan <character>`. If proposals are waiting, ask him what to do
   with them before making more — one `AskUserQuestion`, options: pass the unpicked ones (they are
   marked passed and stop counting as waiting), keep them open and ask anyway (`--force`), or go back
   and choose from them now. A pile of unapproved brainstorms is the failure mode to avoid, and a
   file he has already chosen from does not need `--force` every session.
2. **Ask one narrow question.** `pnpm studio character next <id>` does the whole step: works out the
   next missing facet, picks an ask that has not been asked before, runs the brainstorm, and prints
   the approve line. Use `character brainstorm <id> "<ask>"` when he wants a question of his own
   instead. Never ask a whole facet at once: "how she behaves when embarrassed" gave four genuinely
   different answers, "tell me about her personality" gives mush.
3. **Explain the proposals in the chat first.** Read the file and summarise each option in a line or
   two — what it is, the line of hers that carries it. Say plainly when two options contradict each
   other or contradict existing canon; the model will do that and it is the most useful thing to
   notice. A proposal in the file he already has reached for a bracelet and had to catch itself
   against the bare-wrists rule in `appearance.md`. This paragraph is the reading; the question that
   follows is only the picking.
4. **Then let him click.** One `AskUserQuestion`, `multiSelect: true`, one option per proposal in
   the file's numbering, label = `<n>. <title>`, description = one sentence, the tell or the line.
   A question holds four options, so five proposals are two questions in the same call: the first
   with 1–4, the second single-select with "5. <title>" and "Not 5". Never make "none — ask it
   differently" a click there: it forced him to type "done with my previous select" into Other on
   every round he was happy with 1–4 alone (2026-09-24). Asking again is what he types into Other
   when he wants it; a typed "none, ask about X instead" is a new ask, not a pick.
5. **Approve exactly what he clicked.**
   `pnpm studio character approve <id> latest <n,n> --into <facet>`
   Name the proposals file, never `latest`, whenever a second brainstorm may have run since — a
   background one writes a newer file and `latest` silently picks it (this approved a history
   option into `relationships.md` once). Quote the number list in PowerShell (`"1,5"`), or it
   splits into two arguments. It copies those
   items under a dated heading naming the brainstorm they came from and ticks them off, so the same
   idea cannot be approved twice. Options he did not click stay open in the file; do not pass them
   for him.
6. **Ask what next, the same way.** After the approval, `studio plan` again, then one
   `AskUserQuestion`: the remaining asks of the facet he is in (one option each, so he can choose
   depth), the next facet by name with its `because`, or stop here. The plan's own next step is the
   first option and says "(Recommended)". If the facet has no asks left, the next facet is first.
7. **Back to 2.**

## What to watch for

- **Contradictions are information.** Canon is the authority. If a proposal fights `appearance.md` or
  a rule in `world/rules.md`, say which and let him decide — never silently reconcile it. Say it in
  the chat before the question, and repeat it in that option's description, so it is in front of him
  at the moment he clicks.
- **A click is a pick, nothing more.** "All of them" clicked is a list and is approved as one;
  "they're all good" typed is praise and gets the question again. Never approve from praise.
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
- **Thin is not done.** `studio plan` marks a facet done as soon as it holds anything, and
  `character next` then skips to the next EMPTY facet — it will never ask the remaining asks of a
  started facet. For those, run `character brainstorm <id> "<ask>"` with the ask's exact wording
  from `facets.ts` (and `--explicit` for an explicit facet), so the proposals file is titled the same
  way and `plan` can see it was asked.
- **His own words are canon without a proposal.** When he answers a question with a fact instead of a
  number ("grown up on an old farm…"), write it into the facet under `## Author <date>` in his words,
  then brainstorm on top of it if he wants more; the model reads it as canon from then on.
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
