# Asking who it is, and finding the tag for them

Shared by `/sdxl`, `/recreate` and both `-multi` commands. They all ask this
question first and resolve the answer the same way, so the rule lives here
rather than in four files that would drift.

## Why it is asked at all, and asked first

A character tag is the single highest-leverage token in a booru prompt and the
easiest one to get wrong. The model learned `aqua_(konosuba)` from 4,288
tagged images; it learned nothing at all from `aqua from konosuba`, and it
learned somebody *else* from `minato_aqua`. A wrong character tag does not
degrade gracefully — it drags the face, the hair and often the outfit toward a
different person, and the render comes back looking like a stranger with no
error anywhere saying why.

Recognising a character from a picture is the least reliable thing in these
commands. The person running it usually knows, and one word from them removes
the guess entirely. So it is asked **before the picture is read**, not after:
the answer is what the extraction is anchored on, and a question asked
afterwards would only be confirming a guess already baked into the tags.

**The answer is optional and no answer is a normal answer.** Someone recreating
a picture they found on the web genuinely does not know, and the command works
exactly as it did before.

## The question

First `AskUserQuestion` call, alongside the model question — see each command
for that half.

| Question | Options |
|---|---|
| Character | You work it out from the picture (Recommended) · Nobody in particular |

Two options and the tool's own Other, which is where a name goes. Say so in the
question text: *"…or choose Other and type the name — it does not have to be
the exact danbooru spelling."* Making them type the underscored, parenthesised
form would defeat the point, which is that they know the character and should
not have to know the vocabulary.

The two options are not the same answer:

- **You work it out** — unchanged behaviour. Recognise them if you confidently
  can, describe them if you cannot.
- **Nobody in particular** — an original character, or someone the user does not
  want anchored. Do not name anyone even if you are sure you recognise them.
  Describe the features instead: hair colour, length and style, eye colour,
  distinctive marks. This is a real answer with a real effect, not a way of
  saying "I don't know", and it is worth offering because a confident wrong
  identification is the failure this whole question exists to prevent.

## Resolving what they typed

Whatever they type, look it up. Do not paste a typed name straight into a
prompt — the whole value here is landing on a string the model was trained on.

```bash
awk -F, -v q="$(echo "<what they typed>" | tr ' ' '_' | tr 'A-Z' 'a-z')" \
  '$3=="4" { n=split(q,w,"_"); ok=1
             for(i=1;i<=n;i++) if(!index($2,w[i])) ok=0
             if(ok) print $4"\t"$2 }' \
  models/anime-tagger/selected_tags.csv | sort -rn | head -6
```

`selected_tags.csv` is the vocabulary the tagger model actually learned —
category `4` is its 2,751 character tags, and column 4 is how many images
carried that tag in training. Ranked by that count, because it is the best
available answer to "did the model learn this one well enough to be worth
naming".

**It matches each word separately, and that is not a refinement.** Danbooru
writes Japanese names **family name first** — `kitagawa_marin`,
`katsuragi_misato` — and people type them the other way round, because that is
how the shows say them in English. Searching for the typed string whole finds
nothing for `Marin Kitagawa` and the answer would come back "outside the
model's vocabulary" about a character it knows from 3,869 images. Requiring
every word in any order costs nothing and fixes the commonest input there is.

Three things come back, and each means something different:

- **One clear match.** Use it. Say the count in the report — `makima
  (chainsaw man)`, 6,072 images, is an anchor; a character tag with 80 images
  is barely one and the signature features are carrying the render.
- **Several matches.** Common, and `aqua` is the example: `minato_aqua` (6,646)
  outranks `aqua_(konosuba)` (4,288), and they are different people. **The
  picture decides**, not the count — you are about to look at it anyway. Only
  ask back when the picture genuinely cannot separate them.
- **Nothing.** The character is outside the model's vocabulary. Say so once,
  plainly, and fall back to the features — a tag the model never saw is not
  free, it is tokens spent arguing for nothing. **Never substitute a near-miss
  because it looks close.** `misaka_mikoto` (8,470) and `misaka_imouto` (993)
  share a surname and are not the same person, and sending the popular one
  because it outranks the other is the wrong-character failure arriving by a
  different route.

Being unable to find a name the user is sure about is worth one line in the
report. It is usually a series the tagger's cut-off predates, and knowing that
is what stops them retyping it next time.

## Writing it into the prompt

Two conversions, both silent failures if missed:

- **Underscores become spaces.** `aqua_(konosuba)` is the CSV's spelling;
  prompts are written `aqua (konosuba)`.
- **The parentheses must be escaped** — `aqua \(konosuba\)`. Unescaped, Forge
  reads them as emphasis syntax: the prompt asks for `aqua` and separately for
  an emphasised `konosuba`, which is not the character tag at all and is the
  reason a correctly-identified character can still render wrong.

It goes in the subject chunk, first, ahead of the signature features — and the
features still go in. The tag anchors the identity and they hold it where the
tag is weak, which is most characters outside the top few thousand.

The ADetailer prompt gets it too. That pass repaints the head from its own
prompt, and a face pass with no character tag repaints a generic face over a
correctly-generated one.
