/**
 * The one seam between the panel stage and whatever draws pictures.
 *
 * Stage 2 knows prompts, seeds and sizes; it does not know HTTP, base64 or
 * checkpoints-by-title. A backend knows those and nothing about comics. Only
 * Forge is implemented; a hosted API implements the same two methods and
 * stages 1 and 3 never hear about it.
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
  /** LoRA names (without weights) the script's characters use. */
  loras: string[]
}

export interface Prepared {
  /** The checkpoint as the backend names it — this is what gets hashed. */
  checkpoint: string
}

export type Progress = (fraction: number, etaSeconds: number | undefined) => void

export interface Renderer {
  readonly name: string
  /** Confirm the backend can serve the script, or throw naming what it lacks. */
  prepare(needs: Needs): Promise<Prepared>
  render(request: RenderRequest, onProgress?: Progress): Promise<RenderResult>
}
