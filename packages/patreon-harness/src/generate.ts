/**
 * HAR -> TypeScript. Types and endpoint constants only.
 *
 * The codegen boundary from the brief, and it is a real boundary: this file
 * writes `endpoints.generated.ts` and the request/response types, and it never
 * writes the state machine. Polling, ordering, retries and resume are decisions,
 * not shapes, and a generator that guessed at them would be wrong in a way that
 * looked right.
 *
 * The other half of the boundary is human. A capture is a list of calls; which
 * one *is* "create the media record" is a judgement, so it comes from a mapping
 * file the operator writes once, not from a keyword guess in here. That is the
 * same rule as everywhere else in this project: no invented endpoints.
 */

import { maskPath, type HarRequest } from './har.ts'

/**
 * `endpoints.map.json`: constant name -> the request signature that is it.
 *
 * `CSRF` is the one entry that is an object rather than a signature, because
 * the token's *source* is a decision no signature can express: which endpoint
 * hands it out, which field of the response holds it, which header it goes in.
 */
export type EndpointMap = Readonly<Record<string, string | CsrfMapping | undefined>> & {
  readonly CSRF?: CsrfMapping
}

export interface CsrfMapping {
  readonly path: string
  readonly field: string
  readonly header: string
}

/** Constants the client declares. A mapping naming anything else is a typo, and is reported as one. */
export const KNOWN_ENDPOINTS = [
  'MEDIA_CREATE',
  'MEDIA_GET',
  'POST_CREATE',
  'POST_UPDATE',
  'POST_DELETE',
] as const

export interface GenerateInput {
  readonly mapping: EndpointMap
  /**
   * Every captured request, from every HAR being generated from.
   *
   * More than one, because the matrix spreads the protocol across fixtures on
   * purpose: the delete only exists in `cleanup`, the media calls only in
   * `image-1`. Generating from one HAR would null out whatever that fixture
   * happened not to do.
   */
  readonly requests: readonly HarRequest[]
  /** Where the requests came from, recorded in the file so a stale generation is visible. */
  readonly source: string
}

export interface GenerateResult {
  readonly source: string
  readonly problems: readonly string[]
}

export function generateEndpoints(input: GenerateInput): GenerateResult {
  const problems: string[] = []
  const bySignature = new Map<string, HarRequest>()
  for (const request of input.requests) {
    if (!bySignature.has(request.signature)) bySignature.set(request.signature, request)
  }

  for (const name of Object.keys(input.mapping)) {
    if (name === 'CSRF' || name.startsWith('//')) continue
    if (!(KNOWN_ENDPOINTS as readonly string[]).includes(name)) {
      problems.push(`${name}: not an endpoint the client declares — check the spelling against endpoints.generated.ts`)
    }
  }

  const lines: string[] = [
    '/**',
    ' * GENERATED FILE — do not hand-edit the values.',
    ' *',
    ` * Written by packages/harness generate from: ${input.source}`,
    ` * At: ${new Date().toISOString()}`,
    ' *',
    ' * Regenerate from a fresh capture rather than patching this by hand. A value',
    ' * edited here is a value with no capture behind it, which is the failure mode',
    ' * the whole project is arranged to avoid.',
    ' */',
    '',
    `export const CAPTURED_FROM: string | null = ${JSON.stringify(input.source)}`,
    '',
    'export interface Endpoint {',
    "  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'",
    '  readonly path: string',
    '  readonly fixture: string',
    '}',
    '',
    'export interface CsrfTicket {',
    '  readonly path: string',
    '  readonly field: string',
    '  readonly header: string',
    '}',
    '',
    `export const CSRF: CsrfTicket | null = ${
      input.mapping.CSRF === undefined ? 'null' : JSON.stringify(input.mapping.CSRF)
    }`,
    '',
  ]

  for (const name of KNOWN_ENDPOINTS) {
    const signature = input.mapping[name]
    if (typeof signature !== 'string') {
      lines.push(`export const ${name}: Endpoint | null = null`, '')
      continue
    }
    const request = bySignature.get(signature)
    if (request === undefined) {
      problems.push(`${name}: no request in the capture matches "${signature}"`)
      lines.push(`export const ${name}: Endpoint | null = null`, '')
      continue
    }
    lines.push(
      `export const ${name}: Endpoint | null = {`,
      `  method: ${JSON.stringify(request.method)},`,
      // The masked path is the template the client substitutes into. The raw one
      // carries one run's post id and would pin the client to that draft.
      `  path: ${JSON.stringify(maskPath(request.path))},`,
      `  fixture: ${JSON.stringify(request.source === '' ? input.source : request.source)},`,
      '}',
      '',
    )
  }

  return { source: `${lines.join('\n')}`, problems }
}

/* -------------------------------------------------------------- inference */

/**
 * A TypeScript type for a set of JSON samples.
 *
 * More than one sample matters: the field that is `null` in the text-only
 * capture and an object in the image one is `T | null`, and a generator shown
 * only the first would write `null` and make the real shape a type error.
 */
export function inferType(samples: readonly unknown[], indent = ''): string {
  const present = samples.filter((sample) => sample !== undefined)
  if (present.length === 0) return 'unknown'

  const primitives = new Set<string>()
  const objects: Record<string, unknown>[] = []
  const arrays: unknown[][] = []

  for (const sample of present) {
    if (sample === null) primitives.add('null')
    else if (Array.isArray(sample)) arrays.push(sample)
    else if (typeof sample === 'object') objects.push(sample as Record<string, unknown>)
    else primitives.add(typeof sample)
  }

  const parts = [...primitives]
  if (arrays.length > 0) parts.push(`${inferType(arrays.flat(), indent)}[]`)
  if (objects.length > 0) {
    const keys = [...new Set(objects.flatMap((object) => Object.keys(object)))].sort()
    const inner = keys
      .map((key) => {
        const values = objects.map((object) => object[key])
        const optional = objects.some((object) => !(key in object)) ? '?' : ''
        return `${indent}  ${propertyName(key)}${optional}: ${inferType(values, `${indent}  `)}`
      })
      .join('\n')
    parts.push(`{\n${inner}\n${indent}}`)
  }

  return parts.length === 1 ? (parts[0] as string) : parts.join(' | ')
}

const PLAIN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function propertyName(key: string): string {
  return PLAIN.test(key) ? key : JSON.stringify(key)
}

/** One exported type alias per named call, ready to paste into a `.generated.ts`. */
export function generateTypes(named: Readonly<Record<string, readonly unknown[]>>): string {
  return Object.entries(named)
    .map(([name, samples]) => `export type ${name} = ${inferType(samples)}\n`)
    .join('\n')
}
