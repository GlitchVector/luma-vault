/**
 * A rendered panel is identified by everything that went into it.
 *
 * The hash is over the request the renderer receives — not the script — so
 * an edit to a panel's scene changes it, an edit to its dialogue does not,
 * and a change to the config's steps or checkpoint re-renders every panel.
 * Keys are sorted before hashing so two equal requests written in different
 * orders never miss the cache.
 */

import { createHash } from 'node:crypto'

export interface RenderRequest {
  prompt: string
  negative: string
  seed: number
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  checkpoint: string
  clip_skip?: number
  backend: string
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function requestHash(request: RenderRequest): string {
  return createHash('sha256').update(canonical(request)).digest('hex').slice(0, 16)
}

/** What sits beside every panel PNG: enough to reproduce it, and enough to
 *  know whether the PNG on disk is still the one the script asks for. */
export interface Sidecar {
  version: 1
  panel: string
  page: number
  attempt: number
  seed: number
  hash: string
  request: RenderRequest
  rendered_at: string
  /** Whatever the backend reported about the render — Forge's `info` blob,
   *  the checkpoint hash it actually loaded. Informational, never hashed. */
  backend_info?: unknown
}
