/**
 * Ari, as far as she is already established outside this studio: her
 * appearance from the LoRA work, and how the image model draws her. Nothing
 * about who she is — that is what the studio is for, and it starts empty on
 * purpose so it is developed with the author rather than invented here.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { characterDir, scaffoldCharacter, writeText, type Studio } from './root.ts'

const APPEARANCE = `# Ari — appearance

Canon from the character sheet (\`ari-sheet-02\`) and the reference set the
LoRA \`ari_adopt_v1\` was trained on.

- Hair: a white-to-teal bob with blunt bangs; white at the roots, teal at the tips.
- Eyes: blue.
- Face: young adult, soft features; the sheet's title calls her Aurora, her name is Ari.
- Head: a plain teal headband, no gems. Blue teardrop earrings. A fine gold chain with a small blue gem pendant.
- Build: slim, athletic; bust and hips in proportion, nothing exaggerated.
- Skin: light, neutral tone; no sun-tan words in renders (they turn her orange).
- Wrists: bare — no bracelet.
- Design note (author, 2026-09-16): her nipples show through the default top in every reference; that is part of the design, not a defect.

## Rendering

See \`generation.yaml\`. She renders best on delburry75 with indoor window light and no ADetailer pass; her trait words are named in every prompt because the LoRA keeps only her face, body and bob.
`

const CORE = `# Ari — core

- Name: Ari (the design sheet says "Aurora"; nobody calls her that).
- Age: early twenties.
- One of the author's original characters, with her own LoRA. Everything below her appearance is still to be developed here, facet by facet, with the author approving what becomes canon.
`

const GENERATION = `# How the image model draws Ari. Referenced by id; never copied into a panel.
model: delburry75
lora: ari_adopt_v1
lora_weight: 1.2
trigger: ari
# The LoRA keeps only face, body and bob; these words are named in every prompt.
trait_words: white hair, aqua hair, colored tips, bob cut, blunt bangs, blue eyes, hairband, earrings, necklace
subject: 1girl
lighting_default: indoors, window
negative_identity_traits:
  - sun words (orange skin)
  - bracelet
  - gem headband
  - cleavage window on the default top
face_pass: none
undressed:
  lora_weight: 0.85
  state_words: topless | completely nude
  note: run without the censor negative set; it paints tape and blobs
preferred_reference_images:
  - D:/AI/lora-train/sheets/ari-sheet-02.png
  - D:/AI/lora-train/sheets/ari-refs-v2/
`

const OUTFIT_DEFAULT = `id: default
name: Sheet outfit
description: >-
  Teal off-shoulder crop top with a black high collar and a black yoke with bare
  shoulder cutouts; sleeves black at the shoulder, puffed teal, black at the cuff;
  bust fully covered. White high-waisted shorts with two rows of black buttons.
  White chunky platform sneakers with teal accents. Plain teal headband, blue
  teardrop earrings, gold chain with a blue gem pendant. Bare wrists.
colors: [teal, white, black, gold]
materials: [cotton jersey, denim-like twill, rubber soles]
accessories: [teal headband, blue teardrop earrings, gold chain with blue gem pendant]
footwear: white platform sneakers with teal accents
prompt_words: aqua shirt, off-shoulder shirt, black collar, white shorts, sneakers
must_not_appear:
  - bracelet
  - gems on the headband
  - cleavage cutout
  - trousers
reference_images:
  - D:/AI/lora-train/sheets/ari-sheet-02.png
`

const OUTFITS_INDEX = `# Ari — outfits

One file per outfit in \`outfits/\`. A panel names an outfit by id.

| id | name | when |
|---|---|---|
| default | Sheet outfit — teal crop top, white shorts, platform sneakers | everyday |
`

export function seedAri(studio: Studio): string[] {
  const made = scaffoldCharacter(studio, 'ari', 'Ari')
  const dir = characterDir(studio, 'ari')
  const put = (relative: string, text: string) => {
    const path = join(dir, relative)
    if (existsSync(path) && !/_Nothing established yet\./.test(readSafe(path))) return
    writeText(path, text)
    made.push(join('characters', 'ari', relative))
  }
  put('core.md', CORE)
  put('appearance.md', APPEARANCE)
  put('outfits.md', OUTFITS_INDEX)
  put('generation.yaml', GENERATION)
  put(join('outfits', 'default.yaml'), OUTFIT_DEFAULT)
  return made
}

import { readFileSync } from 'node:fs'
function readSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
