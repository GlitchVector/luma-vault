---
description: Recreate a generation with a different character in it, wearing her own outfit
argument-hint: <image> [model] [bg — render in the background]
---

# Same picture, different character

Keep the composition and change who is in it. The pose, the framing, the
setting, the light and the camera all stay exactly as they are; the character
and everything she is wearing are replaced.

**This is not `/recreate` with a name typed in.** `/recreate` rebuilds a prompt
from the picture, so the result is a new composition that resembles the old one.
This one edits the original prompt in place and touches only two of its groups —
which is what makes the pair comparable afterwards. Reach for `/recreate` when
the prompt is thin; reach for this when the picture is *right* and only the
person in it should change.

## 1. Ask who she should become, and which model

One `AskUserQuestion` call, two questions, both single-select, before anything
is read.

### The character question

**Read `.claude/character-tags.md`** — the lookup, the counts and the spelling
rules are all there and all apply.

Two differences from the other commands, and both matter:

- **The answer is not optional here.** It is the entire command. If it comes
  back as "you work it out" or empty, say that `/swap` has nothing to do without
  a name and stop — do not pick somebody.
- **"Nobody in particular" is still a real answer.** Swapping a named character
  for an unnamed one is a normal thing to want. Take the features from the user
  or invent a coherent set, and say which you did.

Word the question so the point is obvious — *"Who should be in this picture
instead?"* — and say the original will be read for its composition, not for who
is in it.

### The model question

The same table `/sdxl` uses, and the same rule: skip this half when a model was
given positionally. Read step 1 of `.claude/commands/sdxl.md` for the options
and the family tuning, which are not restated here.

## 2. Read the original, and split it in two

```bash
pnpm migrate-prompt <image> --show
```

**Then open the file and look at it.** For this command the picture matters more
than usual: the prompt says what was *asked for*, and the wardrobe you are about
to replace is whatever is actually being worn.

Now split every tag in the original prompt into two piles. Getting this boundary
right is the whole job.

**Keep — the picture:**

- Quality and style tags.
- Framing and camera: the ladder rung, `from behind`, `looking at viewer`,
  `dutch angle`, depth of field.
- Pose and expression: `standing`, `arms up`, `bent over`, `smile`, `blush`.
- Setting, background and light: `outdoors`, `bedroom`, `night`, `backlighting`.
- Body tags: `huge breasts`, `wide hips`, `thick thighs`. These describe the
  *body*, not the character, and the user tuned them on the original.
- **State of undress** — see step 3. These are the reason this command needs a
  rule rather than judgement.

**Replace — the person:**

- The character tag, and every identity tag that belongs to her: hair colour,
  length and style, eye colour, `animal ears`, `horns`, distinctive marks.
- Every garment: tops, bottoms, dresses, swimwear, underwear, footwear,
  legwear, headwear.
- Every accessory: jewellery, ribbons, glasses, weapons she carries as part of
  her look.

Say which pile each unusual tag went into when you report, because a tag in the
wrong pile is the difference between "the same picture with someone else in it"
and "a different picture".

## 3. What she is *not* wearing survives the swap

The rule that makes this command work, and the one place judgement is not
trusted.

The original prompt says how much of the old outfit was being worn. Those tags
are about the *picture*, not about the character, so they stay — and having
stayed, they constrain what the new wardrobe is allowed to add:

| The original says | The new outfit must not add | But may still add |
|---|---|---|
| `nude`, `completely nude` | anything covering torso or hips | legwear, gloves, jewellery |
| `topless` | shirts, bras, dresses, bikini tops | an open jacket, anything below the waist |
| `bottomless`, `no pants` | skirts, shorts, trousers, underwear | anything above the waist |
| `no panties`, `pantyless` | underwear only | **the skirt** — that is the whole point of the tag |
| `no bra`, `braless` | bras and bikini tops | the top worn over it |

**`no panties` is not `bottomless`.** One is a skirt with nothing under it and
the other is no skirt at all. Collapsing them loses a garment the user
deliberately kept, and it is the easiest mistake here to make.

Compose the new outfit against that table: a character whose reference outfit is
a pleated skirt, swapped into a `bottomless` picture, arrives wearing everything
*except* the skirt. Do not "fix" the contradiction by dropping the state tag —
it is part of the picture being kept.

`migrateGeneration` enforces this as well, from `UNDRESS_CONFLICTS` in
`packages/core/src/migrate.ts`, and reports whatever it removed.

It matches the **head noun**, so `black pants` and `blue pleated skirt` are
caught the way `pants` and `skirt` are — that is how these tags are written in
practice. What it cannot catch is a garment whose noun is not on the list, and
it deliberately never touches legwear, footwear or jewellery.

Treat it as the backstop and not the plan. Compose against the table above and
it should find nothing; if it reports a removal, that is a tag you should not
have added, and it is worth saying so rather than quietly accepting the fix.

## 4. Migrate, but do not send yet

```bash
pnpm migrate-prompt <image> <model> --dry-run --prompt "<the rewritten prompt>"
```

`--prompt` replaces the whole positive prompt, so hand it the complete rewritten
text — the kept tags in their original order and positions, with the new
character and wardrobe in place of the old. Newlines are written `\n`; pnpm on
Windows cannot carry a real one through an argument.

Everything else about the run is `/sdxl`'s step 4, unchanged: the canvas is
`832x1216`, the flags repeat on every run because the block is rebuilt rather
than resumed, and the family tuning comes from the checkpoint.

**Leave the body flags alone unless asked.** `--body` and `--shot` exist to
change the picture, and this command is trying not to.

## 5. Show it, and offer the last look

The same fourth call `/sdxl` makes, with one question — and here the diff is
the thing worth showing rather than the prompt. Print it as three short lists
before the question:

```
kept      cowboy shot, from behind, looking back, huge breasts, wide hips,
          bedroom, night, bottomless
was       aqua (konosuba), blue hair, long hair, blue eyes, detached sleeves,
          blue skirt, thighhighs
now       makima (chainsaw man), red hair, braid, ringed eyes, white shirt,
          black necktie, black pants  → black pants dropped: bottomless
```

That third line is the command's whole output, and none of it is visible in the
tab afterwards. Then send exactly as `/sdxl` does.

## `bg` — render in the background instead of opening a tab

**A bare `bg` anywhere in the arguments means: generate it and show the
picture, do not open Forge.** `/sdxl 00489 bg`, `/swap 00205 wai bg`,
`/recreate 00316 bg` — the token is never a model, because no installed
checkpoint contains those two letters, so it can sit in the model slot without
ambiguity.

What changes at the send step, and nothing else — every question, every rule
and the last look all happen exactly as written above:

```bash
<the same command> --render "<scratchpad>/<image>-<what-it-is>.png"
```

Then show it with `SendUserFile`, captioned with what was asked for.

Three things worth knowing:

- **It is safe while Forge is busy.** The checkpoint travels in
  `override_settings` per request rather than being selected globally, so the
  render queues behind whatever is running instead of changing the model out
  from under it. No need to check `/sdapi/v1/progress` first.
- **Forge saves its own copy** into its outputs with its own numbering, which
  is what puts the picture in the library. Write the `--render` file into the
  session scratchpad, not a watched folder, or it is indexed twice.
- **It takes two to four minutes** on this machine, and there is nothing on
  screen meanwhile. Say so before starting, or the wait reads as a hang.

`.claude/shot-tags.md` has the measurements behind all of this under "Getting
the shots rendered". `/shot` does not take `bg`: it already decides by count,
opening one or two as tabs and rendering three or more.

## What to say afterwards

- **The character's training count**, from the lookup in step 1. A swap onto a
  tag with 300 images will not look like her, and that is worth knowing before
  the render rather than after.
- **Anything the undress rule removed**, and why — the user chose that character
  partly for her outfit, and is entitled to know which piece of it is not in
  this picture.
- **Identity tags you had to invent.** A character whose hair you are unsure of
  is a guess sitting in the prompt looking like a fact.
- **What you kept that you were unsure about.** A tag that could be read as
  either the outfit or the setting — `armor` on a battlefield — is the one most
  likely to be in the wrong pile.

The seed is randomised like every migration. A seed is a coordinate in one
model's noise space, and the same seed with a different character in the prompt
does not produce the same picture with a different character in it — the
composition comes from the tags that were kept, which is why so much care goes
into keeping the right ones.
