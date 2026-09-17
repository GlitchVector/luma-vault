/**
 * The seam in front of whichever hosted model draws a plate: the place, the
 * light, and a stand-in figure per character, but never the character
 * herself. Two calls — draw a place from words, and draw a view of a place
 * you are shown — and one rule: nothing explicit goes through here.
 */

export type PlateSize = '1024x1024' | '1536x1024' | '1024x1536'

export interface PlateRequest {
  prompt: string
  size: PlateSize
  quality: 'low' | 'medium' | 'high' | 'auto'
  /** Pictures the result must stay consistent with: the location's master. */
  references?: Buffer[]
  input_fidelity?: 'low' | 'high'
}

export interface PlateResult {
  png: Buffer
  info?: unknown
}

export interface PlateBackend {
  readonly name: string
  /** Throw naming what is missing (a key, a reachable host). */
  prepare(): Promise<void>
  draw(request: PlateRequest): Promise<PlateResult>
}

/**
 * The stand-ins, in the order characters are listed on a panel. Saturated
 * primaries a photograph never contains, so the mask is a colour threshold
 * and not a detector.
 */
export const DUMMIES: ReadonlyArray<{ name: string; hex: string; rgb: readonly [number, number, number] }> = [
  { name: 'magenta', hex: '#FF00FF', rgb: [255, 0, 255] },
  { name: 'cyan', hex: '#00FFFF', rgb: [0, 255, 255] },
  { name: 'yellow', hex: '#FFFF00', rgb: [255, 255, 0] },
]

/** The plate size nearest a panel's bucket: the three the hosted model draws. */
export function plateSizeFor(width: number, height: number): PlateSize {
  const aspect = width / height
  if (aspect > 1.15) return '1536x1024'
  if (aspect < 0.87) return '1024x1536'
  return '1024x1024'
}
