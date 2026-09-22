# Writing the story for a comic

The Comics panel's first step wants prose: `# Title`, then paragraphs, and **three paragraphs make a
page** — the picture pipeline now cuts the prose into pages on exactly that rule and holds the writer
to it. This develops those paragraphs with him, from a seed of his, one question at a time.

Same shape as `/canon`, same one rule that outranks the rest: **I never approve.** The story model
proposes, he clicks, `story approve` writes. His own words go in as they are.

## 1. The seed

He gives one to three paragraphs (one is enough). If `/story` came with a comic name from the app
(`/story testing`), the seed is that project's `prose.md` in
`%LOCALAPPDATA%\net.glitchvector.luma-vault\comics\<name>\prose.md`; if it came with text, that is
the seed; if it came with nothing, ask for the text in the chat — this is the one input that is his
and it should be typed, not clicked.

Then one `AskUserQuestion`, two questions: **who is in it** and **how many pages** (2 / 4 / 6 / 8;
three paragraphs each). The cast options come from

```
pnpm studio characters
```

which lists every studio character with her canon count and her LoRAs, and ticks the ones that have
BOTH a developed canon and a LoRA in the catalogue. Only the ticked ones are options, multi-select,
with the LoRA name in the description. Say in the chat who was left out and why (canon missing which
facets, or no LoRA), so a character he expected is a `/canon` or a training away, not a mystery. If
nobody is ready, stop there and say so. A comic in the studio is created or reused for it:

```
pnpm studio comic new <id> --title "<title>" --characters a,b
```

`<id>` is the app project's name when it came from the app, so the two stay paired. The seed goes
into `comics/<id>/concept.md` under `## Author <date>`, in his words, before anything is asked, so
every call reads it as canon.

## 2. Which model, decided from the seed

The studio has two: `model` (claude-cli, everything ordinary) and `explicit_model` (Grok, the
delicate material). `story brainstorm` takes `--explicit` to use the second. **Decide it from what
the seed and the approved outline actually contain**, and say which in the chat before the first
call:

- Sex, nudity, kink, or a story that is plainly heading there → `--explicit` on every brainstorm of
  this story. A refusal from the fallback comes back shaped like an answer and gets written into a
  proposals file as though the model had nothing to say, which is worse than an error.
- Anything else → no flag. Claude is free, local, and nothing leaves the machine.
- If it starts tame and a picked direction turns explicit, switch from that brainstorm on and say so.
  Never switch the other way to get a "better" answer; the routing is his rule.

`pnpm studio model` says whether the explicit model can answer right now (key set, service up).

## 3. Depth, one narrow ask at a time

```
pnpm studio story brainstorm <id> "<ask>" [--explicit] --count 4
```

Four options fit one click. The asks, in this order, skipping what the seed already answers:

1. what she wants in this story, and what is in her way
2. where it starts and what the first page must show
3. the turn: the moment the story stops being what it looked like
4. how it ends, and what it costs her
5. the tone: what the book keeps doing on every page, and what it never does

Per ask: explain the four options in the chat in a line each, say plainly when two contradict each
other or contradict canon (`characters/<id>/core.md` is the rules; the facet files are the
authority), then one `AskUserQuestion`, `multiSelect: true`, one option per proposal in the file's
numbering. He clicks; approve exactly that into `outline`:

```
pnpm studio story approve <id> <proposals-file> "<n,n>" --into outline
```

Name the proposals file, never `latest` (a second brainstorm may have run). Quote the numbers in
PowerShell. Options he did not pick are passed (`story pass`) so nothing waits. When he answers with
his own words instead of a number, that is canon: write it into `outline.md` under
`## Author <date>` and continue from it. Stop asking when he says the outline is enough, or after
the five.

## 4. The pages

One brainstorm per page, in order, with the outline as context and the page count he chose:

```
pnpm studio story brainstorm <id> "page N of M as three paragraphs of prose, each paragraph one beat that can be drawn as one or two panels; show the story visually, dialogue only where a picture cannot carry it; pages so far: <one line each>" [--explicit] --count 3
```

Three options, each a whole page. He clicks one (or types "none, more like X"); approve it into
`story`. The next page's ask names the pages already approved in one line each so the model
continues rather than restarts. A page he rewrites in his own words goes in under `## Author`.

## 5. Into the app

```
pnpm studio story prose <id> --out "%LOCALAPPDATA%\net.glitchvector.luma-vault\comics\<name>\prose.md"
```

writes `# Title` and the approved paragraphs, nothing else, over the project's `prose.md`. Tell him
to open the comic again in the Comics panel — it reads `prose.md` when the comic is opened — and
that "Write the script again" turns it into the script. Before writing, say how many pages the
paragraph count makes; if it is not what he chose, say which page is short.

## What to watch for

- **The model writes the writer's job if allowed to.** Pages are prose, not panel lists, not camera
  words, not tags. If a proposal comes back as "Panel 1: …", pass it and ask again with "as prose".
- **Canon is the authority.** Ari's rules in `core.md` — six words then stop, never bodies, hands to
  objects, the tells — apply to every page she is on. A page that has her explaining herself is a
  contradiction to name before he clicks.
- **The explicit pages keep the book's tone.** `boundaries.md` says what is never drawn and that the
  joke stays in the hall; a page that crosses it is named as such, and it is his call.
- **Three paragraphs make a page, and nothing else does.** A page of two paragraphs is a short page;
  four is a page and a third of the next. Count before writing `prose.md`.
- **Never approve from praise.** "They're all good" gets the question again.
