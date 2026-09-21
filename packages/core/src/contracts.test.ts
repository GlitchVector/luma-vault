import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  characterCountSchema,
  comicProjectSchema,
  comicRunOptionsSchema,
  comicInspectionSchema,
  comicStatusSchema,
  comicSummarySchema,
  loraDatasetSchema,
  deviantArtAccountSchema,
  deviantArtDraftSchema,
  deviantArtGallerySchema,
  deviantArtSummarySchema,
  folderSchema,
  libraryStatsSchema,
  mediaFrameSchema,
  mediaItemSchema,
  mediaQuerySchema,
  remoteStatusSchema,
  scanProgressSchema,
  setSummarySchema,
  setMemberRowSchema,
  patreonRequestSchema,
  patreonAccessRuleSchema,
  patreonSummarySchema,
  shareStatusSchema,
  sourceOriginSchema,
  timelineBucketSchema,
} from './schemas.ts'

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '../../../contracts')

/**
 * Each fixture is parsed and then deep-compared against the raw JSON.
 *
 * The `toEqual` half is the one that earns its keep: zod's `parse` STRIPS
 * unknown keys, so a schema that is missing a field the fixture carries would
 * pass a bare `parse()` without complaint and fail here. Together with the Rust
 * round-trip in `apps/desktop/src/contract_tests.rs`, that pins both directions.
 */
const CASES: Array<[file: string, schema: z.ZodType]> = [
  ['media-item.json', z.array(mediaItemSchema)],
  ['folder.json', z.array(folderSchema)],
  ['scan-progress.json', z.array(scanProgressSchema)],
  ['media-frame.json', z.array(mediaFrameSchema)],
  ['library-stats.json', libraryStatsSchema],
  ['media-query.json', mediaQuerySchema],
  ['timeline.json', z.array(timelineBucketSchema)],
  ['character-count.json', z.array(characterCountSchema)],
  ['set-summary.json', z.array(setSummarySchema)],
  ['set-member.json', z.array(setMemberRowSchema)],
  ['patreon-request.json', z.array(patreonRequestSchema)],
  ['patreon-access-rule.json', z.array(patreonAccessRuleSchema)],
  ['patreon-summary.json', z.array(patreonSummarySchema)],
  ['deviantart-draft.json', z.array(deviantArtDraftSchema)],
  ['deviantart-gallery.json', z.array(deviantArtGallerySchema)],
  ['deviantart-account.json', z.array(deviantArtAccountSchema)],
  ['deviantart-summary.json', deviantArtSummarySchema],
  ['remote-status.json', z.array(remoteStatusSchema)],
  ['share-status.json', z.array(shareStatusSchema)],
  ['comic-summary.json', z.array(comicSummarySchema)],
  ['lora-dataset.json', loraDatasetSchema],
  ['comic-project.json', comicProjectSchema],
  ['comic-run-options.json', z.array(comicRunOptionsSchema)],
  ['comic-status.json', z.array(comicStatusSchema)],
  ['comic-inspection.json', comicInspectionSchema],
  ['source-origin.json', z.array(sourceOriginSchema)],
]

describe('contract fixtures', () => {
  for (const [file, schema] of CASES) {
    it(`${file} round-trips through its schema unchanged`, () => {
      const wire: unknown = JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8'))
      expect(schema.parse(wire)).toEqual(wire)
    })
  }
})
