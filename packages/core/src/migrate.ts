/**
 * Lifting a generation from one model to another.
 *
 * The point is not to translate a prompt — it is to stop the *silent* failures
 * that make a migrated prompt look like it worked and produce something else.
 * Three of them, all invisible at the UI:
 *
 * 1. **A LoRA trained for SD1.5 does nothing on SDXL.** Different text-encoder
 *    dimensions, so the tag is parsed, matched against nothing, and dropped.
 * 2. **A textual inversion is the same.** `EasyNegative` on an SDXL model is
 *    not an embedding, it is the literal words "easy negative" steering the
 *    image somewhere nobody asked for.
 * 3. **SD1.5 resolutions produce broken anatomy on SDXL**, which was trained
 *    at ~1 megapixel. 660x990 is not "smaller", it is out of distribution.
 *
 * None of these raise an error. Each one quietly changes the picture.
 *
 * Everything here is a string transformation over a parameter block: no I/O, no
 * knowledge of which models exist, and no network. What *is* installed is the
 * caller's problem.
 */

/** The architectures this app can tell apart from a checkpoint's tensor names. */
export type Architecture = 'sd' | 'xl'

export interface MigrationTarget {
  architecture: Architecture
  /** Checkpoint name as Forge knows it, which is what `Model:` must contain. */
  checkpoint: string
  /**
   * The checkpoint predicts **v** rather than epsilon.
   *
   * Read from the file, not from its name: a v-prediction checkpoint carries
   * `v_pred` as a non-weight tensor in its safetensors header. NoobAI's v-pred
   * release carries `ztsnr` beside it.
   *
   * The only thing this changes here is the **sampler**, and that is the limit
   * of what a parameter block can do about it. Applying the prediction mode is
   * the webui's job, and a build that does not — Forge around 2024 samples
   * every SDXL as epsilon, having read `v_pred` and then called nothing with
   * the answer — renders a v-pred checkpoint as saturated noise whatever this
   * writes. The scripts warn about it; see `warnAboutVPrediction`.
   */
  vPred?: boolean
  /**
   * Which booru vocabulary the target was trained on.
   *
   * `noob` swaps the quality tags and the baseline negative for NoobAI-XL's,
   * which are genuinely different words rather than a preference — see
   * {@link NOOB_QUALITY}. Anything else uses the common XL set.
   */
  family?: 'noob' | 'aniverse' | 'illustrious'
  /**
   * Override the CFG the family tuning would otherwise set.
   *
   * The one number the sources genuinely disagree about. A Hassaku-specific
   * page says 7 where the Illustrious guides call 4.5-5 the sweet spot, and
   * PerfectDeliberate's own card asks for 5-8 — so the tuning sends 5, which is
   * inside all of them, and this is how someone tries the other reading when a
   * render looks flat. Applied after the family tuning rather than instead of
   * it: everything else that tuning decides is still wanted.
   */
  cfg?: number
  /**
   * How the picture is rendered: flat anime, semi-real, or photoreal.
   *
   * The axis with the largest visible effect on a booru model and the one with
   * the least obvious controls, because the tags that do it are ordinary words
   * — so `glossy skin` reads like it should work and does nothing. See
   * {@link STYLES}.
   */
  style?: '2d' | '2.5d' | '3d'
  /**
   * The emphasis mode the webui is *currently* set to.
   *
   * Passed in so the block can state it. A block that says nothing about a
   * settings-backed field does not leave that setting alone — the paste fills
   * in the default and records the difference as an override, which then
   * reverts the setting for that generation. So omitting `Emphasis` silently
   * undoes a person's own choice, and they see an override chip they never
   * added. Naming the current value gives the paste nothing to override.
   */
  emphasis?: string
  /**
   * A framing rung to impose on the prompt — `full body`, `wide shot`, …
   *
   * This is the person changing the crop, not the migration translating
   * anything, so it applies on every move including same-architecture ones.
   * Whatever rung the prompt already carries is removed rather than argued
   * with: two rungs in one prompt is a tug of war, and the result is neither
   * framing.
   */
  shot?: string
  /**
   * Body tags to impose — `(gigantic ass:2), (wide hips:1.4)`, or the hips
   * maximum combo. Same contract as `shot`: an explicit ask, applied on every
   * move, and every rung the prompt already carries for a mentioned axis is
   * removed rather than argued with.
   */
  body?: string
  /**
   * Tags the picture shows and its prompt never said, appended to the prompt.
   *
   * **An img2img generation keeps its subject in the init image**, and a PNG
   * parameter block does not carry that image. So a block can be twelve words
   * about a face, with the character, the outfit, the pose and the room all
   * living in a file nothing downstream has — and migrating it faithfully then
   * produces a prompt that describes almost nothing, on a model that will
   * happily invent the rest. Reading the picture is the only way to get those
   * back, which is why `/sdxl` looks at it.
   *
   * Appended rather than prepended: these are the scene, and whatever the
   * person originally wrote stays in front where its weight is. Anything the
   * prompt already carries is dropped rather than said twice — a duplicated
   * concept is encoded twice at half the attention each.
   */
  add?: string
  /**
   * An explicit canvas — `832x1216`. Wins over the bucket rule.
   *
   * The caller choosing a shape rather than inheriting the source's. `/sdxl`
   * passes `832x1216` on every run: what these prompts are for is a standing
   * figure, and the source's aspect is an accident of whatever it was made
   * from — a square init image is not a request for a square picture. Snapped
   * to the nearest SDXL bucket when the target is XL: the aspect is what was
   * asked for, the pixel count is what the model was trained at.
   */
  size?: string
  /**
   * The positive prompt, replaced wholesale after every rewrite has run.
   *
   * The last look. `/sdxl` migrates and opens a tab in one movement, so the
   * only text the person ever saw was the one they asked for — and once the
   * tab is open the prompt is in Forge's box, where fixing it means retyping
   * it by hand. `--dry-run` prints the migrated block, and whatever comes back
   * through here supersedes it.
   *
   * Deliberately applied *late*: the rewrites still run, because their output
   * is what was shown for editing, and everything downstream that reads the
   * prompt back — the negative-conflict pass, the ADetailer face prompt — then
   * reads the approved text rather than the proposed one. An edit that renames
   * the character would otherwise leave the face pass repainting a head from a
   * description nobody agreed to.
   */
  prompt?: string
  /**
   * The negative prompt, replaced wholesale, for the same reason as `prompt`.
   *
   * A rung the shot asked for can already be sitting in the source's negative:
   * a block made as a `cowboy shot` carries `close-up, portrait` there as the
   * wide-rung backstop, and reframing it to `close-up` leaves the new rung
   * negated by the old one. The backstop pass only ever *adds* — it cannot know
   * which of the terms already there the caller now wants — so the removal has
   * to come from outside.
   */
  negative?: string
}

export interface Migration {
  /** The rewritten parameter block, ready to hand to Forge. */
  block: string
  /** What changed and why, in the order it was decided. Shown, not logged. */
  notes: string[]
}

/**
 * SDXL's training buckets. A generation must land on one of these or the
 * anatomy degrades — the model never saw other shapes.
 */
const XL_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [1024, 1024],
  [1152, 896],
  [896, 1152],
  [1216, 832],
  [832, 1216],
  [1344, 768],
  [768, 1344],
  [1536, 640],
  [640, 1536],
]

/**
 * Embeddings that exist only for SD1.5. Left in a prompt for an SDXL model they
 * become ordinary words — `bad-hands-5` reads as "bad hands 5", which is the
 * opposite of what it was doing.
 */
const SD15_EMBEDDINGS = [
  'easynegative',
  'bad-hands-5',
  'badhandv4',
  'bad_prompt',
  'bad_prompt_version2',
  'ng_deepnegative_v1_75t',
  'ng_deepnegative_v1_4t',
  'ng_deepnegative',
  'bad-artist',
  'bad-artist-anime',
  'bad-image-v2-39000',
  'verybadimagenegative_v1.3',
  'negative_hand-neg',
  'bad_pictures',
]

/**
 * Phrasings canonicalised onto the tag that carries the same meaning.
 *
 * **Never a change of degree.** This list used to rewrite `big ass` to
 * `huge ass` and `bbw` to `plump`, on the reasoning that a phrase absent from
 * `models/anime-tagger/selected_tags.csv` carries no learned meaning. That
 * reasoning does not hold: the file is the *tagger's* vocabulary — the ~10,000
 * tags it was trained to predict — not the checkpoint's and not danbooru's, and
 * CLIP reads unknown phrases compositionally. `gigantic ass` is absent from it
 * and renders exactly as expected, confirmed over many real generations.
 *
 * So absence is a reason to check, not a licence to substitute. What survives
 * here is only where the axis has a single real tag and the left-hand side adds
 * no size of its own — `wasp waist` and `narrow waist` are the same request;
 * `big ass` and `huge ass` are not, and picking one of them is the user's job.
 *
 * `naked` is gone for a second reason on top of that one: rewriting it to
 * `nude` put the word "nude" into prompts that only said `naked ass`, which
 * tripped [`UNDRESS_CONFLICTS`]'s full-nudity row and stripped a shirt that was
 * plainly in the picture.
 */
const TAG_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // Hips and thighs each have exactly one tag on the axis, so these are
  // spellings of it rather than degrees of it. `huge hips` measured *smaller*
  // than `wide hips`, which is what this row is for.
  ['huge hips', 'wide hips'],
  ['large hips', 'wide hips'],
  ['big hips', 'wide hips'],
  ['wide hip', 'wide hips'],
  ['huge thighs', 'thick thighs'],
  ['fat thighs', 'thick thighs'],
  // `voluptuous` and `curvaceous` used to be rewritten to `curvy` here. They
  // are absent from the tagger's list, but so is `gigantic ass`, which works —
  // and they do not mean quite the same thing as `curvy`, so swapping them was
  // the same quiet substitution as `big ass → huge ass`. Left alone.
  ['slim waist', 'narrow waist'],
  ['thin waist', 'narrow waist'],
  ['wasp waist', 'narrow waist'],
  ['hourglass figure', 'narrow waist, wide hips'],
  ['naked breasts', 'breasts out'],
  ['bare breasts', 'breasts out'],
]

/**
 * Negatives that cancel what the prompt is asking for.
 *
 * `thick thighs` in the prompt and `fat` in the negative is a tug of war the
 * negative usually wins, and the result reads as the model ignoring the prompt.
 * These pairs were carried over from SD1.5 prompts where the negative was
 * fighting a different failure mode — SD1.5 made people doughy, so `fat, chubby`
 * earned its place there. On a booru model it just deletes the body type.
 *
 * Only removed when the prompt actually asks for the opposite; a negative
 * saying `fat` on a prompt that says nothing about body shape is left alone.
 */
const NEGATIVE_CONFLICTS: ReadonlyArray<{ wants: string[]; suppressedBy: string[] }> = [
  {
    wants: ['wide hips', 'thick thighs', 'curvy', 'plump', 'huge ass', 'breast expansion'],
    suppressedBy: ['fat', 'chubby', 'obese', 'overweight', 'skinny', 'thin', 'petite', 'slim'],
  },
  {
    wants: ['huge breasts', 'gigantic breasts', 'large breasts', 'breast expansion'],
    suppressedBy: ['flat chest', 'small breasts', 'flat chested'],
  },
  {
    wants: ['nude', 'topless', 'breasts out', 'nipples', 'completely nude'],
    suppressedBy: ['clothed', 'fully clothed'],
  },
  {
    wants: ['muscular', 'abs', 'toned'],
    suppressedBy: ['muscular', 'abs'],
  },
]

/**
 * Tags describing a side of the body the framing has turned away from.
 *
 * A prompt is a set of simultaneous claims, not a priority list. Ask for
 * `from behind` while `cleavage, huge nipples, topless, navel` are still in the
 * prompt and the model does not draw a back view missing those details — it
 * satisfies the larger, louder group and **turns her back around**, so the one
 * tag that was the whole point of the shot is the one that loses. No error, no
 * warning, and a set of "different angles" that are all the same angle.
 *
 * This is the reason a tab-per-shot run cannot simply reuse one prompt: the
 * framing decides which claims are still possible, and the impossible ones have
 * to go rather than be outvoted.
 */
const FACING_CONFLICTS: ReadonlyArray<{ framing: string[]; hides: string[] }> = [
  {
    framing: ['from behind', 'ass focus', 'back focus'],
    hides: [
      'cleavage',
      'nipples',
      'huge nipples',
      'large nipples',
      'puffy nipples',
      'inverted nipples',
      'nipple slip',
      'areolae',
      'large areolae',
      'navel',
      'stomach',
      'collarbone',
      'underboob',
      'between breasts',
      'breast focus',
      'bare breasts',
      'naked breasts',
      'breasts out',
      'topless',
      'cameltoe',
    ],
  },
]

/**
 * Whether a prompt carries a tag, as a tag rather than as a substring.
 *
 * `ass` is inside `glass` and `bass`; `from behind` is not inside anything, but
 * the check has to be the same one either way or the table's behaviour depends
 * on which entry you are reading.
 */
/**
 * What a state of undress forbids the wardrobe from putting back.
 *
 * For `/swap`, which keeps a picture's composition and changes who is in it.
 * The new character brings her own outfit, and the prompt already says how much
 * of the old one was being worn — so `bottomless` beside a freshly-added
 * `pleated skirt` is the swap arguing with itself, and the model resolves it by
 * drawing the skirt. What the original said about *coverage* has to outrank
 * what the new character's reference sheet says about *cloth*.
 *
 * Matched as whole tags, so this only removes what it is sure about: a
 * `pleated skirt` is listed because `skirt` alone would not catch it, and a
 * garment nobody thought of survives. Under-removing leaves one contradiction
 * in a prompt somebody is about to read; over-removing silently undresses a
 * character the user asked for.
 *
 * Legwear and footwear are deliberately absent from every row. `nude,
 * thighhighs` and `topless, gloves` are ordinary, wanted combinations rather
 * than mistakes — these tags are about what covers the torso and hips, and
 * nothing else.
 */
const UNDRESS_CONFLICTS: ReadonlyArray<{ state: string[]; hides: string[] }> = [
  {
    // Everything off.
    //
    // Bare `naked` is deliberately not a trigger. Its common uses in these
    // prompts are `naked apron`, `naked shirt` and `naked breasts`, and every
    // one of those describes something still being worn — treating them as
    // full nudity would strip a character the user dressed on purpose. `nude`
    // is the canonical tag and the one that means it.
    state: ['nude', 'completely nude', 'fully nude'],
    hides: [
      'shirt', 't-shirt', 'blouse', 'sweater', 'hoodie', 'jacket', 'coat', 'cardigan',
      'tank top', 'crop top', 'camisole', 'tube top', 'turtleneck', 'vest', 'kimono',
      'dress', 'sundress', 'long dress', 'evening gown', 'school uniform', 'serafuku',
      'leotard', 'bodysuit', 'corset', 'swimsuit', 'one-piece swimsuit', 'bikini',
      'bikini top', 'bikini bottom', 'bra', 'sports bra', 'panties', 'thong', 'underwear',
      'skirt', 'miniskirt', 'pleated skirt', 'long skirt', 'pencil skirt', 'pants',
      'shorts', 'short shorts', 'denim shorts', 'jeans', 'leggings', 'bloomers', 'hakama',
    ],
  },
  {
    // Bare above the waist. A jacket stays: `topless, open jacket` is a real
    // framing and the jacket is not what would be covering her.
    state: ['topless'],
    hides: [
      'shirt', 't-shirt', 'blouse', 'sweater', 'hoodie', 'cardigan', 'tank top',
      'crop top', 'camisole', 'tube top', 'turtleneck', 'dress', 'sundress',
      'school uniform', 'serafuku', 'leotard', 'bodysuit', 'corset', 'swimsuit',
      'one-piece swimsuit', 'bikini', 'bikini top', 'bra', 'sports bra',
    ],
  },
  {
    // Bare below the waist, underwear included.
    state: ['bottomless', 'no pants'],
    hides: [
      'skirt', 'miniskirt', 'pleated skirt', 'long skirt', 'pencil skirt', 'pants',
      'shorts', 'short shorts', 'denim shorts', 'jeans', 'leggings', 'bloomers', 'hakama',
      'panties', 'thong', 'underwear', 'bikini bottom', 'swimsuit', 'one-piece swimsuit',
    ],
  },
  {
    // Underwear absent, whatever is over it is not. The distinction is the
    // whole point of the tag: `no panties` under a skirt is a different picture
    // from `bottomless`, and collapsing the two loses the skirt.
    state: ['no panties', 'pantyless'],
    hides: ['panties', 'thong', 'underwear', 'bikini bottom'],
  },
  {
    state: ['no bra', 'braless'],
    hides: ['bra', 'sports bra', 'bikini top'],
  },
]

/**
 * Take back whatever the prompt's own state of undress rules out.
 *
 * Runs over the *finished* prompt rather than over the wardrobe being added, so
 * it catches the contradiction whichever side introduced it — a state tag
 * carried over from the original, or a garment typed into the last-look edit.
 *
 * Names everything it removed. The user picked the character whose outfit this
 * is, and a garment quietly deleted from their prompt is exactly the kind of
 * change they would otherwise only find in the render.
 */
export function enforceUndress(prompt: string): { text: string; removed: string[] } {
  const hidden = new Set<string>()
  for (const { state, hides } of UNDRESS_CONFLICTS) {
    if (!state.some((tag) => hasTag(prompt, tag))) continue
    for (const term of hides) hidden.add(term)
  }
  if (hidden.size === 0) return { text: prompt, removed: [] }

  // Every state tag in the table, not only the ones that fired. `no panties`
  // ends with `panties` and `no bra` ends with `bra`, so without this the rule
  // deletes the very instruction that asked for the removal — and the garment
  // it was supposed to take then has nothing arguing against it.
  const protectedTags = new Set(
    UNDRESS_CONFLICTS.flatMap(({ state }) => state).map((tag) => tag.toLowerCase()),
  )
  return dropGarmentsByLine(prompt, [...hidden], protectedTags)
}

/**
 * Whether `term` is one of `garments`, allowing for the modifiers these tags
 * are nearly always written with.
 *
 * Danbooru garment tags are `<modifier> <noun>` — `black pants`, `pleated
 * skirt`, `lace-trimmed panties` — and a real prompt uses the modified form
 * almost every time. Matching only the whole tag would have caught `pants` and
 * left `black pants`, which is the same contradiction wearing an adjective.
 *
 * Suffix, not substring, and on a word boundary: `bikini bottom` must not be
 * taken by an entry reading `bikini top`, and under a `topless` that keeps the
 * bottom half of a swimsuit that distinction is the whole answer.
 */
function isGarment(term: string, garments: string[]): string | null {
  const bare = term.toLowerCase()
  for (const garment of garments) {
    if (bare === garment || bare.endsWith(` ${garment}`)) return garment
  }
  return null
}

/** `enforceUndress`'s removal, line by line so BREAK boundaries survive. */
function dropGarmentsByLine(
  text: string,
  garments: string[],
  protectedTags: Set<string>,
): { text: string; removed: string[] } {
  const removed: string[] = []
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const kept = line
      .split(',')
      .map((term) => term.trim())
      .filter((term) => {
        if (!term) return false
        const bare = term
          .replace(/^[([{]+|[)\]}]+$/g, '')
          .replace(/:[\d.]+$/, '')
          .trim()
        if (protectedTags.has(bare.toLowerCase())) return true
        if (!isGarment(bare, garments)) return true
        removed.push(bare)
        return false
      })
    const rest = kept.join(', ')
    // A newline is whitespace to the prompt parser rather than a separator, so
    // a line that ended with a comma has to keep it or its last tag fuses with
    // the first tag of the next line.
    const trailing = /,\s*$/.test(line) && rest ? ',' : ''
    if (rest || !line.trim()) lines.push(rest + trailing)
  }
  return { text: lines.join('\n'), removed }
}

function hasTag(text: string, tag: string): boolean {
  return new RegExp(`(^|[^a-z])${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(
    text,
  )
}

/**
 * The tags that turn the subject around, and what they have to be weighted to.
 *
 * Bare, they lose. Suppressing the front-only tags is necessary but not
 * sufficient: what remains — `(huge breasts:1.7)`, `(wide hips:1.8)` — is still
 * a front-facing description as far as the model's learned distribution is
 * concerned, and two unweighted framing tags do not outrank it. 1.5 is the
 * value measured to hold against body tags in that range; the wide rungs need
 * 1.3 against the same pressure and this is the harder ask, because it is
 * fighting what the *body* implies rather than only where the camera sits.
 */
const FACING_TAGS = ['from behind', 'ass focus', 'back focus']
const FACING_WEIGHT = '1.5'

/**
 * Make a framing win: drop what it faces away from, and weight what turns the
 * subject around.
 *
 * Both halves address the same failure — a framing tag outvoted by everything
 * else in the prompt — and doing only one leaves it happening. Names everything
 * it changed, because silently deleting or reweighting a tag someone chose is
 * its own kind of wrong.
 */
export function enforceFraming(prompt: string): {
  text: string
  removed: string[]
  weighted: string[]
} {
  const hidden = new Set<string>()
  for (const { framing, hides } of FACING_CONFLICTS) {
    if (!framing.some((tag) => hasTag(prompt, tag))) continue
    for (const term of hides) hidden.add(term)
  }
  // `looking at viewer` is only a contradiction when nothing says she is looking
  // over her shoulder. `from behind, looking back, looking at viewer` is one of
  // the most common framings there is, and dropping the gaze from it would
  // leave her facing away for no reason.
  if (hasTag(prompt, 'from behind') && !hasTag(prompt, 'looking back')) {
    hidden.add('looking at viewer')
  }

  const cleared = hidden.size > 0 ? dropTermsByLine(prompt, [...hidden]) : { text: prompt, removed: [] }
  return { ...cleared, ...weightFacing(cleared.text) }
}

/** The weighting half of `enforceFraming`. */
function weightFacing(text: string): { text: string; weighted: string[] } {
  // Already weighted by hand somewhere — the author has an opinion about this
  // exact thing, and a second one layered on top would fight it.
  if (/\([^)]*(?:from behind|ass focus|back focus)[^)]*:\s*[\d.]+\s*\)/i.test(text)) {
    return { text, weighted: [] }
  }
  const present = FACING_TAGS.filter((tag) => hasTag(text, tag))
  if (present.length === 0) return { text, weighted: [] }
  const dropped = dropTermsByLine(text, present)
  // One group rather than a weight each: it is a single instruction about which
  // way she is facing, and it goes to the front of the prompt for the same
  // reason a reframe does — that is where weight is worth most.
  const group = `(${present.join(', ')}:${FACING_WEIGHT})`
  return {
    text: dropped.text ? `${group},\n${dropped.text}` : group,
    weighted: present,
  }
}

/** What booru-trained SDXL models expect at the front of a prompt. */
const XL_QUALITY = 'masterpiece, best quality, amazing quality, very aesthetic, absurdres'

/** A baseline negative for booru-trained SDXL, replacing the SD1.5 embeddings. */
const XL_NEGATIVE = [
  'worst quality',
  'low quality',
  'lowres',
  'bad anatomy',
  'bad hands',
  'missing fingers',
  'extra digits',
  'jpeg artifacts',
  'signature',
  'watermark',
  'username',
  'artist name',
]

/**
 * What the NoobAI-XL family expects instead.
 *
 * A different booru vocabulary, not a stylistic preference: NoobAI was trained
 * with recency tags (`newest`, and `old`/`early` on the negative side) that the
 * other XL checkpoints never saw, and without `very aesthetic`, whose
 * equivalent there is `very awa`. Left out of the positive on purpose — it is
 * a strong aesthetic push rather than a quality floor, and belongs to whoever
 * wants it rather than to every migration.
 */
const NOOB_QUALITY = 'masterpiece, best quality, newest, absurdres, highres'

/**
 * What AniVerse XL asks for, from its own model card.
 *
 * An earlier version of this was measured from the AniVerse images in this
 * library and was wrong: those are **SD1.5** generations, and the XL release is
 * a different model with different numbers. Reading a library tells you what
 * somebody did, not what a checkpoint wants.
 */
const ANIVERSE_QUALITY = 'masterpiece, best quality, more details, (hyperdetailed:1.15)'

/**
 * AniVerse XL's activation token, which goes at the **end** of the prompt.
 *
 * The card puts it last, after the description and the background. Its absence
 * is the likeliest explanation for one prompt producing several unrelated
 * styles: without it the trained aesthetic is simply not engaged, and what
 * comes back is base SDXL wearing the prompt.
 */
const ANIVERSE_TRIGGER = '4n1v3rs3'

/**
 * What the Illustrious checkpoints ask for.
 *
 * `masterpiece, best quality, amazing quality` in front is the part the guides
 * are emphatic about, with `very aesthetic` and `newest` after — so this is the
 * common XL set plus `newest`, which Illustrious learned as a recency tag and
 * the plain SDXL merges never saw.
 */
const ILLUSTRIOUS_QUALITY =
  'masterpiece, best quality, amazing quality, very aesthetic, newest, absurdres'

/**
 * The matching negative.
 *
 * `bad quality` beside `worst quality` on purpose: the Illustrious guidance
 * names both, and they are separate learned tags rather than synonyms. These
 * models are described as responding to the negative about as strongly as to
 * the prompt, which is why it is worth stating fully rather than thinly.
 */
const ILLUSTRIOUS_NEGATIVE = [
  'worst quality',
  'bad quality',
  'low quality',
  'lowres',
  'bad anatomy',
  'bad hands',
  'missing fingers',
  'extra digits',
  'jpeg artifacts',
  'signature',
  'watermark',
  'username',
  'artist name',
]

/**
 * Illustrious sampling, as far as the sources agree.
 *
 * `Euler a` is named repeatedly as the best sampler for Illustrious models, at
 * around 28 steps. **CFG is where the sources disagree**: one Hassaku-specific
 * page says 7, the Illustrious user guides call 4.5-5 the sweet spot within a
 * usable 3-7. Neither is the creator — Civitai moved the model behind a host
 * that cannot be read — so this takes 5, which is inside both claims and
 * matches the other Illustrious checkpoint here. `--cfg 7` tries the other
 * reading.
 */
const ILLUSTRIOUS_SETTINGS = { cfg: '5', steps: '28', sampler: 'Euler a', schedule: 'Automatic' }

const ANIVERSE_NEGATIVE = [
  'worst quality',
  'low quality',
  'abs',
  'muscular',
  'rib',
  'greyscale',
  'monochrome',
  'text',
  'title',
  'logo',
  'signature',
  'watermark',
  'censored',
  'crease',
  'fat',
  'chubby',
]

/**
 * AniVerse XL's own recommended sampling, from the card.
 *
 * `DPM++ 2M` rather than the SDE variant on purpose — the creator names it as
 * the one that gives colour, detail and a **2.5D** result, against `Euler Max`
 * which is flatter and closer to 2D. Karras is the scheduler it asks for, and
 * unlike a v-prediction target that is fine here: this is an epsilon model.
 */
const ANIVERSE_SETTINGS = { cfg: '5.5', steps: '30', sampler: 'DPM++ 2M', schedule: 'Karras' }

/** The matching baseline negative, with the recency terms that make it work. */
const NOOB_NEGATIVE = [
  'worst quality',
  'low quality',
  'normal quality',
  'old',
  'early',
  'lowres',
  'bad anatomy',
  'bad hands',
  'mutated hands',
  'missing fingers',
  'extra digits',
  'jpeg artifacts',
  'signature',
  'watermark',
  'username',
  'artist name',
]

/**
 * What a v-prediction checkpoint is sampled with.
 *
 * v-prediction changes what the model outputs at every step, and the SDE and
 * DPM++ samplers that suit epsilon models can diverge on it — the failure is a
 * burnt or washed-out image rather than an error.
 *
 * **Euler, not Euler a.** NoobAI's own card names Euler and DDIM, and says
 * plainly that v-prediction *does not support the Karras schedule series* —
 * which is why the schedule is dropped along with the sampler rather than
 * carried over. An ancestral variant already in the block is left alone, since
 * it is in the same family and someone chose it.
 */
const V_PRED_SAMPLER = 'Euler'

/** Samplers that are safe to leave alone on a v-prediction model. */
const V_PRED_SAFE = /^euler/i

/**
 * The framing ladder, tightest to widest. A prompt should carry at most one
 * rung — the encoder treats two as competing instructions, not a midpoint —
 * so a reframe removes every rung before adding the requested one.
 */
/**
 * Forge's `img_downscale_threshold`, in pixels.
 *
 * Its `export_for_4chan` setting saves an extra, downscaled JPEG of any render
 * past this — a real file beside the PNG, which the scanner has no reason not
 * to index, so the generation lands in the library twice. The setting is not
 * ours to turn off from here, but the hires factor is ours to pick.
 */
const FOUR_MEGAPIXELS = 4_000_000

const SHOT_LADDER = [
  'close-up',
  'portrait',
  'upper body',
  'lower body',
  'cowboy shot',
  'full body',
  'wide shot',
  'very wide shot',
]

/** Shots wide enough to need the backstop against the model drifting tight. */
const WIDE_SHOTS = ['full body', 'wide shot', 'very wide shot']

/**
 * The size-rung families of the four body axes the commands ask about. A body
 * override that mentions an axis replaces that axis's rung outright — the
 * family is cleared first so the prompt never argues a size with itself.
 * Focus tags stay out of the ass family (nothing re-adds `ass focus`), but
 * `hip focus`, `curvy` and `narrow waist` belong to hips because the hips
 * maximum combo re-adds all three.
 */
const BODY_FAMILIES: ReadonlyArray<{ mentions: RegExp; rungs: string[] }> = [
  {
    mentions: /\b(ass|butt)\b/i,
    rungs: ['big ass', 'large ass', 'fat ass', 'huge ass', 'gigantic ass', 'hyper ass', 'bubble butt'],
  },
  {
    mentions: /\bbreasts?\b/i,
    rungs: [
      'small breasts',
      'medium breasts',
      'big breasts',
      'large breasts',
      'huge breasts',
      'gigantic breasts',
      'hyper breasts',
      'busty',
    ],
  },
  {
    mentions: /\bthighs?\b/i,
    rungs: ['thick thighs', 'huge thighs', 'fat thighs'],
  },
  {
    mentions: /\bhips?\b|\bcurvy\b|\bnarrow waist\b/i,
    rungs: [
      'wide hips',
      'big hips',
      'large hips',
      'huge hips',
      'hyper hips',
      'hip focus',
      'curvy',
      'narrow waist',
    ],
  },
]

/** The upscaler the Hires default names — the one installed on this machine. */
const HIRES_UPSCALER = '4xUltrasharp_4xUltrasharpV10'

/**
 * How far the Hires pass enlarges, when the block does not name its own.
 *
 * Only the default. A block that already carries a hires pass keeps whatever
 * factor it named, and a migration that has to preserve an original's final
 * resolution recomputes one — see the note about the hires factor further
 * down. This is the number used when there was no pass at all.
 */
const HIRES_FACTOR = '1.5'

/**
 * The rendering axis, in tags the models were actually trained on.
 *
 * **Every term here was checked against `models/anime-tagger/selected_tags.csv`**,
 * the same standard `TAG_ALIASES` is held to — because the obvious words for
 * this are mostly not tags. `3d`, `cel shading`, `soft shading`, `glossy skin`
 * and `detailed skin` are all absent from those 10,861 names, so a prompt
 * asking for them is asking in a language the model never learned. `shiny
 * skin` is the one that carries the gloss, `realistic` the semi-real
 * rendering, `photorealistic` the rest of the way.
 *
 * 2.5D and 3D both assert `realistic` — the difference between them is
 * `photorealistic`, negated in one and asserted in the other, which is what
 * separates a soft anime-shaded figure from a rendered one.
 */
const STYLES = {
  '2d': {
    positive: 'anime coloring, flat color',
    negative: ['realistic', 'photorealistic', 'shiny skin'],
  },
  '2.5d': {
    positive: 'realistic, shiny skin',
    negative: ['flat color', 'anime coloring', 'photorealistic'],
  },
  '3d': {
    positive: 'photorealistic, realistic, shiny skin',
    negative: ['anime coloring', 'flat color', 'lineart', 'sketch'],
  },
} as const

/** Every rendering tag any style asserts, so a switch can clear the others. */
const STYLE_VOCABULARY = [
  'anime coloring',
  'flat color',
  'realistic',
  'photorealistic',
  'shiny skin',
]

/**
 * The words in a prompt that describe a face, for ADetailer's own pass.
 *
 * The convention — "ADetailer jargon" — is a short prompt carrying only what
 * the repainted region should contain: identity and expression, not pose or
 * setting. Inheriting the full prompt instead makes the face pass re-argue
 * about hips inside a 512px crop of a head.
 */
const FACE_WORDS =
  /(hair|eyes?|face|facial|blush|lips?|mouth|teeth|tongue|freckle|mole|makeup|eyelash|eyebrow|eyeshadow|lipstick|smile|frown|expression|glasses|headband|hat|twintails|ponytail|braid|bangs|\w+ \(\w[^)]*\))/i

/**
 * Words that veto a fragment however face-like the rest of it is.
 *
 * The include-list matches on shared words: "Seductive Smile full body"
 * carries "smile", and "(pubic hair:1.2)" carries "hair" — both sailed into a
 * real face pass, which is exactly the body-inside-a-head-crop failure the
 * whole jargon rule exists to prevent. Word-bounded, so "glasses" survives
 * containing "ass".
 */
const NOT_FACE_WORDS =
  /\b(pubic|body|breasts?|nipples?|ass|butt|hips?|thighs?|legs?|chest|stomach|belly|armpits?|navel|waist|shoulders?|feet|barefoot)\b/i

export function facePrompt(prompt: string): string {
  const kept = prompt
    .split(/[,\n]/)
    .map((part) => balanced(part.trim()))
    .filter((part) => part.length > 0 && FACE_WORDS.test(part) && !NOT_FACE_WORDS.test(part))
    .slice(0, 12)
  if (kept.length === 0) return ''
  return `masterpiece, best quality, detailed face, beautiful detailed eyes, ${kept.join(', ')}`
}

/**
 * Drop brackets a tag lost its partner for when the prompt was split on commas.
 *
 * A weighted group spans commas — `(best quality, perfect face:1.2)` is one
 * group holding two tags — so splitting it hands back `perfect face:1.2)` with
 * a closing bracket and nothing to match it. Pasted into ADetailer that is not
 * a cosmetic problem: the attention parser reads brackets across the whole
 * field, so one stray closer re-weights everything after it or fails outright.
 *
 * Trailing weights go with them. `:1.2` is an instruction about the *prompt*
 * this tag came from, and the face pass is a different, smaller prompt where
 * the number was never calibrated.
 */
function balanced(part: string): string {
  let text = part
  while (/^[([{]/.test(text) && !/[)\]}]/.test(text)) text = text.slice(1).trim()
  while (/[)\]}]$/.test(text) && !/[([{]/.test(text)) text = text.slice(0, -1).trim()
  return text.replace(/:\s*\d+(\.\d+)?$/, '').trim()
}

/** A settings line split into ordered pairs, quote-aware. */
function settingsFields(line: string): Array<[string, string]> {
  const parts: string[] = []
  let buffer = ''
  let quoted = false
  for (const character of line) {
    if (character === '"') quoted = !quoted
    if (character === ',' && !quoted) {
      parts.push(buffer)
      buffer = ''
    } else {
      buffer += character
    }
  }
  parts.push(buffer)

  const fields: Array<[string, string]> = []
  for (const part of parts) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const key = part.slice(0, at).trim()
    if (key) fields.push([key, part.slice(at + 1).trim()])
  }
  return fields
}

/**
 * A parameter block as a `/sdapi/v1/txt2img` request body.
 *
 * The block is what the prefill extension paints into a tab. This is the same
 * generation asked for over the API instead — for the `-multi` commands, where
 * opening a row of tabs is the part that keeps failing. A Forge page's load
 * handler runs on Gradio's queue, which drains one event at a time, so tabs
 * past the second sit on "Loading…" behind each other; an API request has no
 * page to load and simply queues as work.
 *
 * `override_settings` rather than a prior checkpoint selection, because it is
 * per-request: the model, clip skip and VAE arrive *with* the generation
 * instead of being set globally beforehand and hoped to still hold. That also
 * sidesteps the reason `selectCheckpoint` refuses mid-batch — nothing here
 * changes a global out from under a running job.
 *
 * Anything the block does not name is left out rather than defaulted, so
 * Forge's own settings decide it, exactly as they would for a pasted block.
 */
export function toApiPayload(block: string): Record<string, unknown> {
  const { prompt, negative, settings } = splitBlock(block)
  const fields = settingsFields(settings)
  const get = (key: string) => fields.find(([name]) => name === key)?.[1]
  const num = (key: string) => {
    const raw = get(key)
    if (raw === undefined) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }

  const payload: Record<string, unknown> = { prompt, negative_prompt: negative }
  const set = (key: string, value: unknown) => {
    if (value !== undefined) payload[key] = value
  }

  set('steps', num('Steps'))
  set('sampler_name', get('Sampler'))
  set('scheduler', get('Schedule type'))
  set('cfg_scale', num('CFG scale'))
  set('seed', num('Seed'))
  set('denoising_strength', num('Denoising strength'))
  // The refiner is two fields and both are needed: a checkpoint with no switch
  // point never engages, a switch point with no checkpoint is a no-op.
  set('refiner_checkpoint', get('Refiner'))
  set('refiner_switch_at', num('Refiner switch at'))

  const size = (get('Size') ?? '').match(/(\d+)x(\d+)/)
  if (size) {
    payload['width'] = Number(size[1])
    payload['height'] = Number(size[2])
  }

  // The hires pass is one switch plus its settings, and the switch is implied
  // by an upscale factor being present at all — the same way the block reads.
  const upscale = num('Hires upscale')
  if (upscale !== undefined && upscale > 1) {
    payload['enable_hr'] = true
    payload['hr_scale'] = upscale
    set('hr_second_pass_steps', num('Hires steps'))
    set('hr_upscaler', get('Hires upscaler'))
    // Forge-only, and not optional despite looking it. Its txt2img endpoint
    // defaults this to `None` and then iterates it, so *any* API request with
    // `enable_hr` and no `hr_additional_modules` dies with `argument of type
    // 'NoneType' is not iterable` — a 500 naming neither the field nor the
    // hires pass. Measured against this Forge; an empty list is the same as
    // the UI's "Use same choices".
    payload['hr_additional_modules'] = []
  }

  const overrides: Record<string, unknown> = {}
  if (get('Model')) overrides['sd_model_checkpoint'] = get('Model')
  if (num('Clip skip') !== undefined) overrides['CLIP_stop_at_last_layers'] = num('Clip skip')
  if (get('VAE')) overrides['sd_vae'] = get('VAE')
  if (Object.keys(overrides).length > 0) {
    payload['override_settings'] = overrides
    // Not restored afterwards: the next shot in a row wants the same
    // checkpoint, and putting it back between every render would reload the
    // model each time — minutes of nothing, for a setting about to be asked
    // for again.
    payload['override_settings_restore_afterwards'] = false
  }

  const adetailer = adetailerUnit(get)
  if (adetailer) payload['alwayson_scripts'] = { ADetailer: { args: [true, false, adetailer] } }

  return payload
}

/**
 * The face pass, as ADetailer's API takes it.
 *
 * `[enable, skip_img2img, unit]` is the arg shape the extension has used since
 * 23.x. A block with no `ADetailer model` gets no entry at all rather than a
 * disabled one, because an `alwayson_scripts` key Forge cannot match is an
 * error for the whole request rather than a setting it ignores.
 */
function adetailerUnit(
  get: (key: string) => string | undefined,
): Record<string, unknown> | null {
  const model = get('ADetailer model')
  if (!model) return null
  // Values arrive still wearing the quotes the block wrote them with.
  const unquote = (value: string | undefined) => value?.replace(/^"|"$/g, '')
  const unit: Record<string, unknown> = { ad_model: model }
  const prompt = unquote(get('ADetailer prompt'))
  const negative = unquote(get('ADetailer negative prompt'))
  if (prompt) unit['ad_prompt'] = prompt
  if (negative) unit['ad_negative_prompt'] = negative
  const denoise = Number(get('ADetailer denoising strength'))
  if (Number.isFinite(denoise)) unit['ad_denoising_strength'] = denoise
  // The face pass can run on a different checkpoint than the base render — the
  // extension's per-unit override, which works even across architectures. The
  // block names the checkpoint the way Forge lists it; the `ad_use_*` flag has
  // to accompany the value or the extension ignores it.
  const checkpoint = unquote(get('ADetailer checkpoint'))
  if (checkpoint) {
    unit['ad_use_checkpoint'] = true
    unit['ad_checkpoint'] = checkpoint
  }
  return unit
}

function joinSettings(fields: Array<[string, string]>): string {
  return fields.map(([key, value]) => `${key}: ${value}`).join(', ')
}

/** Split a parameter block into its three parts, any of which may be absent. */
function splitBlock(block: string): { prompt: string; negative: string; settings: string } {
  const lines = block.replace(/\r\n/g, '\n').split('\n')
  // Scanning backwards, not `findLastIndex`: the shared tsconfig targets a lib
  // without it, and this is not worth raising the target for.
  let settingsAt = -1
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (/(^|,\s*)Steps:\s/.test(lines[at] ?? '')) {
      settingsAt = at
      break
    }
  }
  const settings = settingsAt >= 0 ? lines[settingsAt]! : ''
  const head = settingsAt >= 0 ? lines.slice(0, settingsAt) : lines

  const negativeAt = head.findIndex((line) => line.startsWith('Negative prompt:'))
  if (negativeAt < 0) return { prompt: head.join('\n').trim(), negative: '', settings }
  return {
    prompt: head.slice(0, negativeAt).join('\n').trim(),
    negative: [head[negativeAt]!.slice('Negative prompt:'.length), ...head.slice(negativeAt + 1)]
      .join('\n')
      .trim(),
    settings,
  }
}

/** Drop comma-separated terms whose text matches one of `unwanted`. */
function dropTerms(text: string, unwanted: string[]): { text: string; removed: string[] } {
  const removed: string[] = []
  const kept = text
    .split(',')
    .map((term) => term.trim())
    .filter((term) => {
      if (!term) return false
      // `(EasyNegative:1.2)` and `[bad-hands-5]` are the same term wearing
      // emphasis syntax, which a plain equality check would miss.
      const bare = term.replace(/^[([{]+|[)\]}]+$/g, '').replace(/:[\d.]+$/, '').trim()
      const match = unwanted.some((name) => bare.toLowerCase() === name.toLowerCase())
      if (match) removed.push(bare)
      return !match
    })
  return { text: kept.join(', '), removed }
}

/**
 * The chunk separator, on its own line because Forge only reads it standing
 * alone between whitespace.
 */
const BREAK_LINE = 'BREAK'

/**
 * Put imposed material into the prompt's leading chunk, opening one if needed.
 *
 * CLIP encodes 75 tokens per chunk and a migrated prompt routinely runs past
 * that, so the boundary lands *somewhere* either way — the only question is
 * whether the migration chooses it. Left alone the cut falls at whatever comma
 * sits near token 75, which is reliably mid-outfit, and the tags either side of
 * it stop informing each other.
 *
 * What this can choose is the boundary it already creates: everything the
 * migration imposes (the reframe, the body override, the quality block) is not
 * the user's wording and belongs together, ahead of the wording it inherited.
 * It deliberately does *not* group the inherited text by concept — that means
 * classifying and reordering someone's tags, which is `/recreate`'s job and the
 * line between the two commands.
 *
 * A prompt that already carries BREAK was composed rather than inherited, so
 * its first chunk is already the quality-and-framing group: imposed material
 * joins that chunk instead of opening a second one in front of it.
 */
function prependImposed(prompt: string, imposed: string): string {
  if (!prompt) return imposed
  return prompt.includes(`\n${BREAK_LINE}\n`)
    ? `${imposed},\n${prompt}`
    : `${imposed}\n${BREAK_LINE}\n${prompt}`
}

/** `dropTerms`, one line at a time, so BREAK boundaries survive the rejoin. */
function dropTermsByLine(text: string, unwanted: string[]): { text: string; removed: string[] } {
  const removed: string[] = []
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const result = dropTerms(line, unwanted)
    removed.push(...result.removed)
    // A newline is whitespace to the prompt parser, not a separator — a line
    // that ended with a comma must keep it, or its last tag fuses with the
    // first tag of the next line.
    const trailing = /,\s*$/.test(line) && result.text ? ',' : ''
    // A line the removal emptied is gone; a line that was already blank stays.
    if (result.text || !line.trim()) lines.push(result.text + trailing)
  }
  return { text: lines.join('\n'), removed }
}

/** The bucket closest in shape to `width`x`height`. */
function nearestBucket(width: number, height: number): readonly [number, number] {
  const wanted = width / height
  let best = XL_BUCKETS[0]!
  let bestGap = Infinity
  for (const bucket of XL_BUCKETS) {
    const gap = Math.abs(bucket[0] / bucket[1] - wanted)
    if (gap < bestGap) {
      bestGap = gap
      best = bucket
    }
  }
  return best
}

/**
 * Rewrite a parameter block to run on `target`.
 *
 * The seed is always randomised. A seed is a coordinate in one model's noise
 * space and means nothing in another's — carrying it over implies a
 * relationship between the two images that does not exist.
 */
export function migrateGeneration(block: string, target: MigrationTarget): Migration {
  const notes: string[] = []
  const { prompt, negative, settings } = splitBlock(block)
  const fields = settingsFields(settings)
  const get = (key: string) => fields.find(([name]) => name === key)?.[1]

  const from: Architecture = /XL|SDXL/i.test(get('Model') ?? '') ? 'xl' : 'sd'
  const crossing = target.architecture === 'xl' && from !== 'xl'

  let nextPrompt = prompt
  let nextNegative = negative

  // How the picture is *rendered*, imposed before anything else so the quality
  // block still lands in front of it. Applied on every move, not only a
  // crossing one: this is the person choosing a look, not the migration
  // translating anything.
  if (target.style) {
    const style = STYLES[target.style]
    // Whatever the prompt already says about rendering is removed rather than
    // argued with — `realistic` in front of `anime coloring` is two competing
    // instructions and the result is neither, exactly like two framing rungs.
    const cleared = dropTermsByLine(nextPrompt, [...STYLE_VOCABULARY])
    nextPrompt = cleared.text ? `${style.positive},\n${cleared.text}` : style.positive
    const already = nextNegative.toLowerCase()
    const additions = style.negative.filter(
      (term) => !new RegExp(`(^|[^a-z])${term}([^a-z]|$)`).test(already),
    )
    if (additions.length > 0) {
      nextNegative = [nextNegative.trim().replace(/,$/, ''), ...additions].filter(Boolean).join(', ')
    }
    notes.push(
      `Style set to ${target.style}: ${style.positive} in front, and ${style.negative.join(', ')} ` +
        'in the negative. Every one is a real danbooru tag — checked against ' +
        'models/anime-tagger/selected_tags.csv, where `3d`, `cel shading` and `glossy skin` are ' +
        'not, and so carry no learned meaning at all.',
    )
  }

  if (crossing) {
    // 1. LoRAs. Architecture-specific, and silently ignored rather than an error.
    const loras = [...nextPrompt.matchAll(/<(?:lora|lyco):([^:>]+)[^>]*>/gi)].map((m) => m[1])
    if (loras.length > 0) {
      nextPrompt = nextPrompt.replace(/<(?:lora|lyco):[^>]*>/gi, '').replace(/[ \t]+/g, ' ')
      notes.push(
        `Removed ${loras.length} SD1.5 LoRA${loras.length === 1 ? '' : 's'} (${loras.join(', ')}) — ` +
          'they do nothing on SDXL. Booru-trained models cover most of what they did with plain tags.',
      )
    }

    // 2. Textual inversions, in both prompts.
    const fromPrompt = dropTerms(nextPrompt, SD15_EMBEDDINGS)
    const fromNegative = dropTerms(nextNegative, SD15_EMBEDDINGS)
    nextPrompt = fromPrompt.text
    const dropped = [...fromPrompt.removed, ...fromNegative.removed]
    if (dropped.length > 0) {
      notes.push(
        `Removed ${dropped.length} SD1.5 embedding${dropped.length === 1 ? '' : 's'} ` +
          `(${dropped.join(', ')}) — on SDXL these are just words, steering the image rather than away from it.`,
      )
    }

    // 3. Phrases that are not tags, rewritten to the ones that are. Weights
    //    and emphasis brackets are preserved: `(huge hips:1.3)` keeps its 1.3.
    const renamed: string[] = []
    for (const [wrong, right] of TAG_ALIASES) {
      const pattern = new RegExp(`(^|[,(\\[|\\s])${wrong}(?=[),\\]:\\s]|$)`, 'gi')
      if (pattern.test(nextPrompt)) {
        nextPrompt = nextPrompt.replace(pattern, (_whole, before: string) => `${before}${right}`)
        renamed.push(`${wrong} → ${right}`)
      }
    }
    if (renamed.length > 0) {
      notes.push(
        `Rewrote ${renamed.length} phrase${renamed.length === 1 ? '' : 's'} that are not danbooru ` +
          `tags (${renamed.join(', ')}). These models learned exact tag strings, so a near-miss ` +
          'carries no meaning — which is why "huge hips" produces smaller hips than "wide hips".',
      )
    }

    // 5. Quality tags, which booru-trained SDXL models were trained to expect.
    if (!/masterpiece|best quality/i.test(nextPrompt)) {
      const quality =
        target.family === 'noob'
          ? NOOB_QUALITY
          : target.family === 'aniverse'
            ? ANIVERSE_QUALITY
            : target.family === 'illustrious'
              ? ILLUSTRIOUS_QUALITY
              : XL_QUALITY
      nextPrompt = prependImposed(nextPrompt, quality)
      notes.push(
        target.family === 'noob'
          ? "Added NoobAI's quality tags, which include the recency tag it was trained with."
          : target.family === 'aniverse'
            ? "Added AniVerse XL's quality tags and its `4n1v3rs3` trigger — without the trigger the trained style is not engaged at all."
            : 'Added the danbooru quality tags these models are trained to expect.',
      )
    }

    // Keep whatever of the original negative was not an embedding, then top it
    // up — a negative stripped of its embeddings is usually too thin.
    const keptNegative = fromNegative.text
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean)
    // Matched against the whole text, not term by term: `(worst quality, low
    // quality:1.4)` is one weighted group holding two terms, so a per-term
    // comparison misses both and appends them again. Duplicates dilute — the
    // encoder sees the concept twice at half the attention each.
    const already = fromNegative.text.toLowerCase()
    const baseline =
      target.family === 'noob'
        ? NOOB_NEGATIVE
        : target.family === 'aniverse'
          ? ANIVERSE_NEGATIVE
          : target.family === 'illustrious'
            ? ILLUSTRIOUS_NEGATIVE
            : XL_NEGATIVE
    for (const term of baseline) {
      if (!new RegExp(`(^|[^a-z])${term}([^a-z]|$)`).test(already)) keptNegative.push(term)
    }
    nextNegative = keptNegative.join(', ')
  }

  // Body-axis overrides from the command's questions, at the front where they
  // carry the most weight. Not gated on `crossing` — see `MigrationTarget.body`.
  if (target.body) {
    const body = target.body.trim().replace(/,\s*$/, '')
    const families = BODY_FAMILIES.filter(({ mentions }) => mentions.test(body))
    const cleared = dropTermsByLine(
      nextPrompt,
      families.flatMap(({ rungs }) => rungs),
    )
    nextPrompt = prependImposed(cleared.text, body)
    const replaced = [...new Set(cleared.removed.map((rung) => rung.toLowerCase()))]
    notes.push(
      `Imposed the asked-for body (${body})` +
        (replaced.length > 0 ? `, replacing ${replaced.join(', ')}` : '') +
        '.',
    )
  }

  // An explicit reframe, at the front of the prompt where it carries the most
  // weight. Not gated on `crossing` — see `MigrationTarget.shot`.
  if (target.shot) {
    const shot = target.shot.trim().toLowerCase()
    const wide = WIDE_SHOTS.includes(shot)
    const cleared = dropTermsByLine(nextPrompt, SHOT_LADDER)
    // A bare wide rung loses: every body tag pulls the camera in, and the
    // model satisfies them by cropping. Weighted in, with the tight rungs
    // named in the negative, it holds.
    const rung = wide ? `(${shot}:1.3)` : shot
    nextPrompt = prependImposed(cleared.text, rung)
    const replaced = [
      ...new Set(cleared.removed.map((r) => r.toLowerCase()).filter((r) => r !== shot)),
    ]
    let note = `Reframed to ${rung}` + (replaced.length > 0 ? `, replacing ${replaced.join(', ')}` : '')
    if (wide) {
      const already = nextNegative.toLowerCase()
      const backstop = ['close-up', 'cropped', 'portrait', 'upper body'].filter(
        (term) => !new RegExp(`(^|[^a-z])${term}([^a-z]|$)`).test(already),
      )
      if (backstop.length > 0) {
        nextNegative = nextNegative ? `${nextNegative}, ${backstop.join(', ')}` : backstop.join(', ')
        note += `; ${backstop.join(', ')} added to the negative as the backstop against drifting tight`
      }
    }
    notes.push(note + '.')
  }

  // AniVerse XL's activation token, at the end where its card puts it.
  //
  // Appended rather than prepended, unlike the quality block: the trained style
  // is what it turns on, and the card's own prompt structure ends with it. Not
  // added twice if the prompt already carries it — a token said twice is
  // encoded at half the attention each, which is the opposite of the intent.
  if (target.family === 'aniverse' && !nextPrompt.toLowerCase().includes(ANIVERSE_TRIGGER)) {
    nextPrompt = `${nextPrompt.replace(/,\s*$/, '')}, ${ANIVERSE_TRIGGER}`
  }

  // What the picture shows and its prompt never said — see `MigrationTarget.add`.
  // Last, so the duplicate check sees the imposed body and shot too.
  if (target.add) {
    const asked = target.add.trim().replace(/,\s*$/, '')
    const already = new Set(
      nextPrompt
        .toLowerCase()
        .split(/[,\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    )
    const fresh: string[] = []
    let repeated = 0
    for (const wanted of asked.split(',').map((part) => part.trim()).filter(Boolean)) {
      if (already.has(wanted.toLowerCase())) repeated += 1
      else fresh.push(wanted)
    }
    if (fresh.length > 0) {
      // Its own chunk, for the same reason the imposed head gets one: these
      // are the tags the prompt never had, and a fresh chunk stops the setting
      // words they land behind from swallowing them at the 75-token boundary.
      nextPrompt = nextPrompt
        ? `${nextPrompt}\n${BREAK_LINE}\n${fresh.join(', ')}`
        : fresh.join(', ')
      notes.push(
        `Added what the picture shows and the prompt never said: ${fresh.join(', ')}` +
          (repeated > 0 ? ` (${repeated} already there)` : '') +
          '.',
      )
    } else if (repeated > 0) {
      notes.push(`Nothing added — the prompt already carried all ${repeated} of those tags.`)
    }
  }

  // The last look — see `MigrationTarget.prompt`. Before the two passes that
  // read the prompt back, so both see what was approved.
  if (target.prompt !== undefined) {
    const edited = target.prompt.trim()
    if (edited && edited !== nextPrompt.trim()) {
      nextPrompt = edited
      notes.push(
        'Prompt replaced with the edited one. The rewrites above still ran — their output is what ' +
          'was shown for editing — but the text they produced is superseded by this.',
      )
    }
  }

  // The same last look, on the other half of the block — see
  // `MigrationTarget.negative`. Before the conflict pass below, so a term the
  // caller has already removed is not reported as removed a second time.
  if (target.negative !== undefined) {
    const edited = target.negative.trim()
    if (edited && edited !== nextNegative.trim()) {
      nextNegative = edited
      notes.push(
        'Negative replaced with the edited one. The backstop and conflict passes still ran — ' +
          'their output is what was shown for editing — but the text they produced is superseded ' +
          'by this.',
      )
    }
  }

  // Claims the framing has turned away from — see FACING_CONFLICTS. After the
  // override, because an edited prompt can reintroduce them, and because the
  // framing that decides this may itself have arrived in that edit.
  {
    const framed = enforceFraming(nextPrompt)
    nextPrompt = framed.text
    if (framed.removed.length > 0) {
      notes.push(
        `Dropped ${[...new Set(framed.removed)].join(', ')} — the framing faces away from them. ` +
          'Left in, they outvote the framing and the model turns the subject back around.',
      )
    }
    if (framed.weighted.length > 0) {
      notes.push(
        `Weighted the framing to (${framed.weighted.join(', ')}:${FACING_WEIGHT}) and moved it to ` +
          'the front. Bare, it loses to the body tags, which describe a front view whatever the ' +
          'camera was told.',
      )
    }
  }

  // Garments the prompt's own state of undress rules out — see
  // UNDRESS_CONFLICTS. After the override for the same reason as the framing:
  // a swap's new wardrobe arrives through `--prompt`, and that is precisely
  // where a skirt lands next to the `bottomless` it contradicts.
  {
    const dressed = enforceUndress(nextPrompt)
    nextPrompt = dressed.text
    if (dressed.removed.length > 0) {
      notes.push(
        `Dropped ${[...new Set(dressed.removed)].join(', ')} — the prompt already says that much ` +
          'is not being worn. Left in, the garment wins and the state tag reads as noise.',
      )
    }
  }

  // Negatives that cancel what the prompt asks for. An SD1.5 negative often
  // carried `fat, chubby` to fight that model's doughiness; on a booru model it
  // deletes the body type the prompt just requested.
  //
  // **After the overrides, not before.** This used to run while the prompt was
  // still the original one, so a body imposed by the command — the loudest ask
  // there is, and the whole reason `--body` exists — was invisible to it:
  // `--body "(thick thighs:1.4)"` left `fat, chubby` sitting in the negative,
  // and the render came back slim with nothing saying why.
  if (crossing) {
    const asks = nextPrompt.toLowerCase()
    const cancelling = new Set<string>()
    for (const { wants, suppressedBy } of NEGATIVE_CONFLICTS) {
      if (!wants.some((tag) => asks.includes(tag))) continue
      for (const term of suppressedBy) cancelling.add(term)
    }
    if (cancelling.size > 0) {
      const before = nextNegative
      const cleared = dropTerms(nextNegative, [...cancelling])
      nextNegative = cleared.text
      if (cleared.removed.length > 0) {
        notes.push(
          `Removed ${cleared.removed.join(', ')} from the negative — the prompt asks for the ` +
            'opposite, and the negative usually wins, which reads as the model ignoring you.',
        )
      } else if (before !== nextNegative) {
        // Defensive: the two should not disagree.
        notes.push('Adjusted the negative prompt.')
      }
    }
  }

  // --- settings -----------------------------------------------------------
  const next = new Map(fields)
  // The canvas the original was made at, read before anything rewrites it. Both
  // the bucket rule and an explicit canvas need it, and they run far apart.
  const originalSize = (get('Size') ?? '').match(/(\d+)x(\d+)/)
  const originalHeight = originalSize ? Number(originalSize[2]) : 0
  next.set('Model', target.checkpoint)
  // Always random: see the doc comment.
  next.set('Seed', '-1')

  // Provenance fields describe the *old* generation. Left in place they do not
  // merely go stale — Forge reads them back: `Model hash` would now contradict
  // `Model`, and `Lora hashes` names a LoRA that is no longer in the prompt,
  // which the paste tries to resolve and fails on.
  next.delete('Model hash')

  // Stated rather than left out — see `MigrationTarget.emphasis`.
  if (target.emphasis) {
    next.set('Emphasis', target.emphasis)
    if (crossing && target.emphasis === 'Original') {
      notes.push(
        'Emphasis is set to Original, which renormalises each chunk after applying weights — so ' +
          '(tag:1.3) mostly redistributes attention rather than adding it. "No norm" makes weights ' +
          'bite properly and is what Forge recommends for SDXL.',
      )
    }
  }

  if (crossing) {
    // An explicit canvas is applied below and would only overwrite this, note
    // and all — two lines about the size, one of them already wrong.
    if (originalSize && !target.size) {
      const width = Number(originalSize[1])
      const [bucketWidth, bucketHeight] = nearestBucket(width, originalHeight)
      next.set('Size', `${bucketWidth}x${bucketHeight}`)
      notes.push(
        `Size ${width}x${originalHeight} → ${bucketWidth}x${bucketHeight}. SDXL was trained at ` +
          'about a megapixel; an SD1.5 canvas produces distorted anatomy rather than a smaller ' +
          'picture.',
      )
    }

    // A VAE belongs to an architecture. An SD1.5 VAE handed to an SDXL model
    // does not fail — it decodes the latents wrongly and returns saturated
    // rainbow noise, which looks like a broken model rather than a wrong
    // setting. `Automatic` uses whatever the checkpoint carries.
    const vae = get('VAE')
    if (vae && vae !== 'Automatic' && vae !== 'None') {
      next.set('VAE', 'Automatic')
      notes.push(
        `VAE ${vae} → Automatic. It is an SD1.5 VAE; on SDXL it decodes to rainbow noise rather ` +
          'than erroring.',
      )
    }
    next.delete('VAE hash')

    // The receipts for what was just removed. `Lora hashes` and `TI` are how
    // Forge reports which extras a generation used; carrying them past a
    // migration that dropped those extras leaves the block describing a
    // picture that will not be made, and the paste erroring on the lookup.
    next.delete('Lora hashes')
    next.delete('TI')
    next.delete('TI hashes')
    next.delete('Hashes')
    // Written by whichever webui made the original, and read by nothing here.
    next.delete('Version')

    // A family's own numbers, where its card gives them — see the constants.
    const tuned =
      target.family === 'aniverse'
        ? ANIVERSE_SETTINGS
        : target.family === 'illustrious'
          ? ILLUSTRIOUS_SETTINGS
          : null
    if (tuned) {
      next.set('CFG scale', tuned.cfg)
      next.set('Steps', tuned.steps)
      next.set('Sampler', tuned.sampler)
      next.set('Schedule type', tuned.schedule)
      next.set('Clip skip', '2')
      notes.push(
        `CFG ${tuned.cfg}, ${tuned.steps} steps, ${tuned.sampler} ${tuned.schedule} — what this ` +
          'checkpoint asks for, rather than the booru-XL tuning.',
      )
    } else {
      next.set('CFG scale', '5')
      next.set('Steps', '28')
      next.set('Clip skip', '2')
      notes.push(
        'CFG 5, 28 steps, clip skip 2 — what booru-trained SDXL models are tuned for. Higher CFG ' +
          'burns contrast and steps past ~30 stop changing the image.',
      )
    }
  }

  // The sampler, on a v-prediction target. Outside the `crossing` branch: an
  // XL→XL move onto a v-pred checkpoint is exactly the case where the block
  // already carries a sampler chosen for an epsilon model, and nothing else in
  // a migration would touch it.
  //
  // Only the sampler. Forge reads `v_pred` from the checkpoint itself, so the
  // mode needs no help — but it will happily sample a v-pred model with an SDE
  // sampler and hand back a burnt image, with nothing in the UI to say why.
  if (target.vPred) {
    const current = next.get('Sampler') ?? ''
    if (!V_PRED_SAFE.test(current)) {
      next.set('Sampler', V_PRED_SAMPLER)
      // Ancestral samplers do their own noise scheduling, so a schedule chosen
      // for the old sampler is not meaningful next to this one.
      next.delete('Schedule type')
      notes.push(
        `Sampler ${current || '(unset)'} → ${V_PRED_SAMPLER}: this checkpoint predicts v rather ` +
          'than noise, and the SDE and DPM++ samplers can diverge on it — a burnt or washed-out ' +
          'image rather than an error.',
      )
    } else {
      notes.push(`Kept ${current}, which is safe on a v-prediction checkpoint.`)
    }
  }

  // An explicit CFG — see `MigrationTarget.cfg`. Outside the `crossing` branch
  // for the same reason as the canvas below, and *after* the family tuning
  // rather than instead of it: the steps, sampler and schedule that tuning
  // chose are still wanted, and this overrides the one number the sources
  // disagree about.
  if (target.cfg !== undefined) {
    const was = next.get('CFG scale')
    next.set('CFG scale', String(target.cfg))
    if (was !== String(target.cfg)) {
      notes.push(`CFG ${was ?? '(unset)'} → ${target.cfg}, asked for.`)
    }
  }

  // An explicit canvas — see `MigrationTarget.size`. Outside the `crossing`
  // branch, because somebody asking for portrait means it on a
  // same-architecture move too.
  if (target.size) {
    const asked = target.size.match(/(\d+)\s*x\s*(\d+)/)
    if (asked) {
      const width = Number(asked[1])
      const height = Number(asked[2])
      const [finalWidth, finalHeight] =
        target.architecture === 'xl' ? nearestBucket(width, height) : ([width, height] as const)
      next.set('Size', `${finalWidth}x${finalHeight}`)
      notes.push(
        finalWidth === width && finalHeight === height
          ? `Canvas set to ${finalWidth}x${finalHeight}.`
          : `Canvas ${width}x${height} → ${finalWidth}x${finalHeight}, the nearest SDXL bucket. ` +
            'The shape is what was asked for; the pixel count is what the model was trained at.',
      )
    }
  }

  // A hires factor is a *multiple* of the canvas, so any canvas change drags
  // the final resolution along with it — silently. This used to live beside the
  // bucket rule and so never ran for an explicit canvas, which is now the
  // ordinary path: `/sdxl` always asks for portrait. A 512x768 block at 2x
  // aimed at 1536px tall and would have inherited 1216x2 = 2432 instead.
  const upscale = Number(get('Hires upscale') ?? '0')
  const canvas = (next.get('Size') ?? '').match(/(\d+)x(\d+)/)
  if (upscale > 1 && originalHeight > 0 && canvas && Number(canvas[2]) !== originalHeight) {
    const finalHeight = Number(canvas[2])
    const wanted = (originalHeight * upscale) / finalHeight
    const clamped = Math.max(1.1, Math.min(2, Math.round(wanted * 20) / 20))
    if (clamped !== upscale) {
      next.set('Hires upscale', String(clamped))
      const aimed = Math.round(originalHeight * upscale)
      notes.push(
        // A landscape source forced portrait routinely wants a factor below the
        // 1.1 floor, and the note must not then claim a height it does not
        // reach — the whole value of these lines is that they are true.
        wanted < 1.1 || wanted > 2
          ? `Hires upscale ${upscale} → ${clamped}, as close to the original ${aimed}px as the ` +
            `1.1-2x range reaches on this canvas — the pass ends at ` +
            `${Math.round(finalHeight * clamped)}px.`
          : `Hires upscale ${upscale} → ${clamped}, keeping the final height near the original ` +
            `${aimed}px.`,
      )
    }
  }

  // Independent of the rescale above, and after it on purpose: whatever factor
  // we end up asking for, the *result* must stay under Forge's four-megapixel
  // line. Past it `export_for_4chan` writes a second, JPEG copy of the render
  // beside the PNG, and since that copy is a real file the scanner indexes it
  // as its own row — one generation arriving in the library twice.
  //
  // Measured: the landscape ass close-up is the only shot that reaches this.
  // A 832x1216 block at 1.5 reframed onto 1216x832 wants 2.19 and takes the 2x
  // ceiling, which is 2432x1664 — 4.047 MP, 1.2% over. 1.95 lands it at
  // 2371x1622 and under, which no eye will pick out of a line-up.
  //
  // Only ever reduces: the ceiling is floored onto the same 0.05 grid, and a
  // canvas already past the threshold on its own cannot be rescued by the hires
  // factor at all, so the 1.1 floor still wins there rather than this.
  const asked = Number(next.get('Hires upscale') ?? get('Hires upscale') ?? '0')
  const shape = (next.get('Size') ?? '').match(/(\d+)x(\d+)/)
  if (asked > 1 && shape) {
    const pixels = Number(shape[1]) * Number(shape[2])
    const ceiling = Math.floor(Math.sqrt(FOUR_MEGAPIXELS / pixels) * 20) / 20
    const capped = Math.max(1.1, Math.min(asked, ceiling))
    if (capped < asked) {
      next.set('Hires upscale', String(capped))
      notes.push(
        `Hires upscale ${asked} → ${capped}, keeping the render under the four megapixels ` +
          `past which Forge saves a second JPEG copy the library would index separately.`,
      )
    }
  }

  // Hires and ADetailer ride along on every XL move, added only when the block
  // does not already carry them — a block that names its own hires pass or
  // face pass knows better than a default.
  if (target.architecture === 'xl') {
    if (!next.has('Hires upscale') && !next.has('Hires upscaler')) {
      next.set('Hires upscale', HIRES_FACTOR)
      next.set('Hires steps', '30')
      next.set('Hires upscaler', HIRES_UPSCALER)
      if (!next.has('Denoising strength')) next.set('Denoising strength', '0.4')
      notes.push(
        `Turned Hires fix on (${HIRES_FACTOR}x, 30 steps, denoise 0.4) — the first pass alone stops at ` +
          'the training resolution, and every keeper gets upscaled anyway.',
      )
    }
    if (!next.has('ADetailer model')) {
      const face = facePrompt(nextPrompt)
      next.set('ADetailer model', 'face_yolov8s.pt')
      if (face) next.set('ADetailer prompt', `"${face}"`)
      next.set('ADetailer negative prompt', `"${XL_NEGATIVE.join(', ')}"`)
      next.set('ADetailer denoising strength', '0.4')
      notes.push(
        'Turned ADetailer on with a face pass' +
          (face ? ` (${face})` : '') +
          ' — faces are where a keeper fails, and the pass costs seconds.',
      )
    }
  }

  const ordered = [...next.entries()] as Array<[string, string]>
  const lines = [nextPrompt.trim()]
  if (nextNegative.trim()) lines.push(`Negative prompt: ${nextNegative.trim()}`)
  lines.push(joinSettings(ordered))

  return { block: lines.join('\n'), notes }
}
