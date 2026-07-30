import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  folderSchema,
  libraryStatsSchema,
  mediaFrameSchema,
  mediaItemSchema,
  mediaQuerySchema,
  scanProgressSchema,
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
]

describe('contract fixtures', () => {
  for (const [file, schema] of CASES) {
    it(`${file} round-trips through its schema unchanged`, () => {
      const wire: unknown = JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8'))
      expect(schema.parse(wire)).toEqual(wire)
    })
  }
})
