/**
 * Two HARs in, a report out. Pure: no browser, no network, no Patreon.
 *
 * This is the highest-value thing in the harness, and the reason the capture
 * plan is a matrix rather than one post. One HAR tells you what happened. Two
 * that differ in exactly one dimension — the same post with and without a tier
 * lock — tell you what each *field means*, which is the thing you actually need
 * and the thing a single capture cannot give you.
 *
 * It is also what makes re-capture cheap the week Patreon changes something:
 * capture again, diff against the last known-good HAR, read the four lines that
 * moved instead of re-reading the whole protocol.
 *
 * Three steps:
 *   1. normalise both sides (`har.ts`),
 *   2. line the two request sequences up, tolerating insertions on either side,
 *   3. deep-diff the bodies of the pairs that matched.
 */

import type { HarRequest } from './har.ts'
import { readHar, type ReadOptions } from './har.ts'

export type Change =
  | { readonly kind: 'added'; readonly path: string; readonly b: unknown; readonly volatile: boolean }
  | { readonly kind: 'removed'; readonly path: string; readonly a: unknown; readonly volatile: boolean }
  | {
      readonly kind: 'changed'
      readonly path: string
      readonly a: unknown
      readonly b: unknown
      readonly volatile: boolean
    }
  /** Same members, different order. Called out separately: for attachments, order *is* the data. */
  | { readonly kind: 'reordered'; readonly path: string; readonly a: unknown; readonly b: unknown; readonly volatile: false }

export interface PairedDiff {
  readonly signature: string
  readonly a: HarRequest
  readonly b: HarRequest
  readonly statusChanged: boolean
  readonly request: readonly Change[]
  readonly response: readonly Change[]
}

export interface DiffReport {
  readonly labelA: string
  readonly labelB: string
  readonly paired: readonly PairedDiff[]
  readonly onlyInA: readonly HarRequest[]
  readonly onlyInB: readonly HarRequest[]
}

export interface DiffOptions extends ReadOptions {
  readonly labelA?: string
  readonly labelB?: string
  /** Include changes to values that are per-run by nature. Off by default; they are most of the noise. */
  readonly includeVolatile?: boolean
}

export function diffHars(a: string | object, b: string | object, options: DiffOptions = {}): DiffReport {
  const left = readHar(a, options)
  const right = readHar(b, options)
  const { pairs, onlyInA, onlyInB } = align(left, right)

  const paired = pairs.map(([one, two]) => ({
    signature: one.signature,
    a: one,
    b: two,
    statusChanged: one.status !== two.status,
    request: filterVolatile(diffValue(one.requestBody?.json ?? null, two.requestBody?.json ?? null, ''), options),
    response: filterVolatile(diffValue(one.responseBody?.json ?? null, two.responseBody?.json ?? null, ''), options),
  }))

  return {
    labelA: options.labelA ?? 'A',
    labelB: options.labelB ?? 'B',
    paired,
    onlyInA,
    onlyInB,
  }
}

function filterVolatile(changes: Change[], options: DiffOptions): Change[] {
  return options.includeVolatile === true ? changes : changes.filter((change) => !change.volatile)
}

/* ------------------------------------------------------------------ align */

/**
 * Longest common subsequence over request signatures.
 *
 * Not a nearest-neighbour match: the sequences differ by *insertion* — a capture
 * with an image has media calls the text-only one never makes — and order is
 * itself evidence. LCS preserves order and puts the extra calls in `onlyInB`
 * where they read as "this is what adding an image costs", which is the exact
 * question the matrix was designed to answer.
 */
export function align(
  a: readonly HarRequest[],
  b: readonly HarRequest[],
): { pairs: [HarRequest, HarRequest][]; onlyInA: HarRequest[]; onlyInB: HarRequest[] } {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i]
      const next = table[i + 1]
      if (row === undefined || next === undefined) continue
      row[j] =
        a[i]?.signature === b[j]?.signature
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const pairs: [HarRequest, HarRequest][] = []
  const onlyInA: HarRequest[] = []
  const onlyInB: HarRequest[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const one = a[i]
    const two = b[j]
    if (one === undefined || two === undefined) break
    if (one.signature === two.signature) {
      pairs.push([one, two])
      i++
      j++
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      onlyInA.push(one)
      i++
    } else {
      onlyInB.push(two)
      j++
    }
  }
  onlyInA.push(...a.slice(i))
  onlyInB.push(...b.slice(j))
  return { pairs, onlyInA, onlyInB }
}

/* ------------------------------------------------------------------- diff */

/**
 * Values that differ between any two runs no matter what changed.
 *
 * Reported, but filtered out by default. A capture pair has dozens of them and
 * they bury the one field that is the actual answer. `--volatile` brings them
 * back for the day the answer *is* a token.
 */
const VOLATILE_KEY = /(^|[._-])(id|ids|uuid|token|signature|csrf|nonce|etag|expires?|expiry|url|href|src|cursor)$/i
const VOLATILE_TIME = /(^|[._-])(at|time|timestamp|created|updated|published|edited)([._-]|$)/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const OPAQUE = /^[A-Za-z0-9_-]{20,}={0,2}$/

function isVolatile(path: string, a: unknown, b: unknown): boolean {
  const key = path.split('.').pop() ?? ''
  if (VOLATILE_KEY.test(key) || VOLATILE_TIME.test(key)) return true
  for (const value of [a, b]) {
    if (typeof value === 'string' && (ISO_DATE.test(value) || OPAQUE.test(value))) return true
  }
  return false
}

/** JSON:API members are `{ type, id }`; keying arrays by that is what turns "reordered" into a distinguishable answer. */
function identityOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = record['id']
  if (typeof id !== 'string' && typeof id !== 'number') return null
  const type = record['type']
  return typeof type === 'string' ? `${type}:${id}` : String(id)
}

export function diffValue(a: unknown, b: unknown, path: string): Change[] {
  if (a === undefined && b === undefined) return []
  if (a === undefined) return [{ kind: 'added', path, b, volatile: isVolatile(path, a, b) }]
  if (b === undefined) return [{ kind: 'removed', path, a, volatile: isVolatile(path, a, b) }]

  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b, path)

  if (isObject(a) && isObject(b)) {
    const changes: Change[] = []
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      changes.push(...diffValue(a[key], b[key], path === '' ? key : `${path}.${key}`))
    }
    return changes
  }

  if (a === b) return []
  return [{ kind: 'changed', path, a, b, volatile: isVolatile(path, a, b) }]
}

function diffArray(a: readonly unknown[], b: readonly unknown[], path: string): Change[] {
  const keysA = a.map(identityOf)
  const keysB = b.map(identityOf)
  const keyed = keysA.every((key) => key !== null) && keysB.every((key) => key !== null)

  if (keyed) {
    const setA = keysA as string[]
    const setB = keysB as string[]
    const changes: Change[] = []
    for (const [at, key] of setA.entries()) {
      const other = setB.indexOf(key)
      if (other === -1) changes.push({ kind: 'removed', path: `${path}[${key}]`, a: a[at], volatile: false })
      else changes.push(...diffValue(a[at], b[other], `${path}[${key}]`))
    }
    for (const [at, key] of setB.entries()) {
      if (!setA.includes(key)) changes.push({ kind: 'added', path: `${path}[${key}]`, b: b[at], volatile: false })
    }
    // Membership identical but sequence not: for an attachment list that is the
    // whole finding, and a per-index diff would have hidden it as six changes.
    if (setA.length === setB.length && setA.join() !== setB.join() && setA.every((key) => setB.includes(key))) {
      changes.push({ kind: 'reordered', path, a: setA, b: setB, volatile: false })
    }
    return changes
  }

  const changes: Change[] = []
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    changes.push(...diffValue(a[at], b[at], `${path}[${at}]`))
  }
  return changes
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ----------------------------------------------------------------- render */

/** Markdown, because the output of this gets pasted into a notes file and read weeks later. */
export function renderReport(report: DiffReport): string {
  const lines: string[] = [`# ${report.labelA} -> ${report.labelB}`, '']

  const interesting = report.paired.filter(
    (pair) => pair.statusChanged || pair.request.length > 0 || pair.response.length > 0,
  )

  lines.push(
    `${report.paired.length} calls in both (${interesting.length} differ), ` +
      `${report.onlyInA.length} only in ${report.labelA}, ${report.onlyInB.length} only in ${report.labelB}.`,
    '',
  )

  if (report.onlyInB.length > 0) {
    lines.push(`## Only in ${report.labelB}`, '', 'What the varied dimension *costs* — the new calls it introduces.', '')
    for (const request of report.onlyInB) lines.push(`- \`${request.signature}\` -> ${request.status}`)
    lines.push('')
  }

  if (report.onlyInA.length > 0) {
    lines.push(`## Only in ${report.labelA}`, '')
    for (const request of report.onlyInA) lines.push(`- \`${request.signature}\` -> ${request.status}`)
    lines.push('')
  }

  if (interesting.length > 0) {
    lines.push('## Fields that differ', '')
    for (const pair of interesting) {
      lines.push(`### \`${pair.signature}\``, '')
      if (pair.statusChanged) lines.push(`- status: ${pair.a.status} -> ${pair.b.status}`)
      for (const change of pair.request) lines.push(`- request ${describe(change)}`)
      for (const change of pair.response) lines.push(`- response ${describe(change)}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}

function describe(change: Change): string {
  const at = change.path === '' ? '(body)' : `\`${change.path}\``
  switch (change.kind) {
    case 'added':
      return `${at} added: ${short(change.b)}`
    case 'removed':
      return `${at} removed (was ${short(change.a)})`
    case 'reordered':
      return `${at} reordered: ${short(change.a)} -> ${short(change.b)}`
    case 'changed':
      return `${at}: ${short(change.a)} -> ${short(change.b)}`
  }
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}
