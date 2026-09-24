/**
 * The one seam between the panel stage and whatever draws pictures.
 *
 * Stage 2 knows prompts, seeds and sizes; it does not know HTTP, base64 or
 * checkpoints-by-title. A backend knows those and nothing about comics. Only
 * Forge is implemented; a hosted API implements the same methods and stages
 * 1 and 3 never hear about it.
 *
 * Two ways to draw: from words alone, or into a picture — the plate with a
 * stand-in — under a mask. The second is how a hosted model's place gets a
 * local model's character, and the only pass that reads the explicit words.
 */

import type { RenderRequest } from '../cache.ts'

export interface RenderResult {
  png: Buffer
  /** Whatever the backend says about what it did. Kept in the sidecar. */
  info?: unknown
}

export interface Needs {
  /** A substring of the checkpoint's name, from the config. */
  checkpoint: string
  /** A substring of a ControlNet model's name, for the sketch route. */
  control?: string
  /** LoRA names (without weights) the script's characters use. */
  loras: string[]
}

export interface Prepared {
  /** The checkpoint as the backend names it — this is what gets hashed. */
  checkpoint: string
  /** The ControlNet model as the backend names it, when one was asked for. */
  control?: string
}

export type Progress = (fraction: number, etaSeconds: number | undefined) => void

/** Redraw the white part of `mask` inside `init`, at `denoise` strength. */
export interface InpaintRequest extends RenderRequest {
  init: Buffer
  mask: Buffer
  denoise: number
  mask_blur: number
  /** Pixels of context around the mask rendered at full resolution. */
  padding: number
  /** The picture the ControlNet reads, when `control` is set. */
  controlImage?: Buffer
}

/** One character's part of a regional render: her prompt (LoRA tags included) and her figure's mask. */
export interface Region {
  prompt: string
  mask: Buffer
}

export interface Renderer {
  readonly name: string
  /**
   * Enlarge a finished picture. Optional: a backend without one simply
   * leaves the page to stretch the panel, which is what happened before
   * retina pages existed.
   */
  upscale?(png: Buffer, scale: number, model: string): Promise<Buffer>
  /** Confirm the backend can serve the script, or throw naming what it lacks. */
  prepare(needs: Needs): Promise<Prepared>
  render(request: RenderRequest, onProgress?: Progress, controlImage?: Buffer): Promise<RenderResult>
  inpaint(request: InpaintRequest, onProgress?: Progress): Promise<RenderResult>
  /** One render with each region's LoRA confined to its mask. Only backends that can (ComfyUI). */
  renderRegional?(request: RenderRequest, background: string, regions: Region[], controlImage?: Buffer, onProgress?: Progress): Promise<RenderResult>
}
