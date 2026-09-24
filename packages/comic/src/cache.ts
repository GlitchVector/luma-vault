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
  /**
   * The second pass that brings the panel up to its cell's size. Hashed
   * like everything else, so a page rendered at another `page.scale` is
   * another picture rather than the same one stretched.
   */
  hires?: { width: number; height: number; upscaler: string; denoise: number; steps: number }
  /** The face pass, when the panel gets one. Hashed like everything else:
   *  a panel drawn before the pass existed is not this picture. */
  face?: {
    prompt: string
    negative: string
    model: string
    confidence: number
    max_area: number
    denoise: number
    size: number
    padding: number
    mask_blur: number
    steps: number
    cfg: number
    checkpoint: string
  }
  /** Set when the panel is painted into a plate: the plate's hash and the
   *  inpaint settings, so a new plate or a new strength is a new picture. */
  plate?: { hash: string; denoise: number; mask_grow: number; mask_tolerance: number; mask_blur: number; padding: number }
  /** Set on the sketch route: which sketch the ControlNet read, and how. The
   *  picture itself travels beside the request, never inside it. */
  control?: { sketch: string; module: string; model: string; weight: number; end: number }
  /** Set on the sketch route: the per-character repaint that follows the first pass. */
  repaint?: {
    denoise: number
    mask_blur: number
    padding: number
    /** Mask margin as a share of each figure's height. */
    grow: number
    /** One entry per cast member, in panel order. */
    cast: Array<{ id: string; prompt: string; negative: string; hair?: string[] }>
  }
  /** Set on the sketch route: the light pass over the whole finished panel. */
  unify?: { prompt: string; denoise: number; control_weight: number; face?: RenderRequest['face'] }
  /** Set on a regional render: the place's prompt, and each cast member's, masked to her figure. */
  regional?: { background: string; cast: Array<{ id: string; prompt: string; hair?: string[] }>; grow: number }
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
