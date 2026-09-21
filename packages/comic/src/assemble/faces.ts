/**
 * Where the faces are in each panel, so the letterer can stay off them.
 *
 * This exists because three cheaper answers were tried and each was wrong:
 *
 * - The ENERGY MAP cannot see her. A head against a bright sky has no
 *   gradient, so the quietest place on the panel is often her face, which is
 *   how the owner's first page came back with a caption across it.
 * - HER FRAMING only says roughly how far down a head reaches, so acting on
 *   it swept every caption on every people panel to the bottom of the frame,
 *   including the ones that were already fine.
 * - A SKIN-TONE guess invents a face in a lit window and spans half the
 *   panel on a close-up.
 *
 * So the letterer asks the same detector ADetailer repaints with,
 * `face_yolov8s`, exported to ONNX so it runs on the classifier venv's
 * onnxruntime rather than needing torch. The answer is a box per face, which
 * is what the owner asked for: a caption over her hair is fine, over her
 * face is not.
 *
 * Boxes are cached in the project's build folder against each panel's mtime,
 * because re-lettering a page is something a person does over and over and
 * it should not pay for detection every time.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PACKAGE_DIR, REPO_ROOT } from '../project.ts'

/** A face as fractions of the panel: left, top, right, bottom. */
export type FaceBox = [number, number, number, number]

/** What a panel holds: her face, and where her body is. */
export interface Figures {
  faces: FaceBox[]
  /** `cols,rows,digits` — how much of each cell a person covers, 0 to 9.
   *  A MASK, not a box: a standing figure's box is most of the panel while
   *  the figure is a column down the middle, and the whole point is to find
   *  the wall beside her. */
  figure: string
}

export interface FigureFinder {
  find(paths: string[]): Promise<Map<string, Figures>>
}

interface Cached extends Figures {
  mtimeMs: number
}

export const FACE_MODEL = join('models', 'face-detector', 'face_yolov8s.onnx')
export const PERSON_MODEL = join('models', 'face-detector', 'person_yolov8s-seg.onnx')

export class PythonFigureFinder implements FigureFinder {
  private readonly python: string
  private readonly faceModel: string
  private readonly personModel: string
  private readonly cachePath: string

  constructor(options: { python: string; faceModel?: string; personModel?: string; cachePath: string }) {
    this.python = resolve(REPO_ROOT, options.python)
    this.faceModel = resolve(REPO_ROOT, options.faceModel ?? FACE_MODEL)
    this.personModel = resolve(REPO_ROOT, options.personModel ?? PERSON_MODEL)
    this.cachePath = options.cachePath
  }

  /** Why it cannot run, or null. Missing is not fatal anywhere: without it
   *  the letterer falls back to the energy map alone, as it always did. */
  available(): string | null {
    if (!existsSync(this.python)) return `${this.python} does not exist (run pnpm setup:python)`
    if (!existsSync(this.faceModel)) return `${this.faceModel} does not exist`
    if (!existsSync(this.personModel)) return `${this.personModel} does not exist`
    return null
  }

  private readCache(): Record<string, Cached> {
    try {
      return JSON.parse(readFileSync(this.cachePath, 'utf8')) as Record<string, Cached>
    } catch {
      return {}
    }
  }

  async find(paths: string[]): Promise<Map<string, Figures>> {
    const result = new Map<string, Figures>()
    if (paths.length === 0) return result
    if (this.available()) return result

    const cache = this.readCache()
    const stale: string[] = []
    for (const path of paths) {
      let mtimeMs = 0
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {
        continue
      }
      const hit = cache[path]
      // A panel re-rendered since it was last looked at has a new face.
      if (hit && hit.mtimeMs === mtimeMs) result.set(path, { faces: hit.faces, figure: hit.figure })
      else stale.push(path)
    }
    if (stale.length === 0) return result

    const script = join(PACKAGE_DIR, 'python', 'figures.py')
    const { stdout, code, stderr } = await run(this.python, [script, this.faceModel, this.personModel, ...stale])
    if (code !== 0) throw new Error(`the figure detector exited with ${code}: ${stderr.trim().slice(-600)}`)
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as { path: string; faces: FaceBox[]; figure: string }
      const found = { faces: row.faces ?? [], figure: row.figure ?? '' }
      result.set(row.path, found)
      try {
        cache[row.path] = { mtimeMs: statSync(row.path).mtimeMs, ...found }
      } catch {
        // The panel vanished between detecting and recording it. Nothing to cache.
      }
    }
    mkdirSync(dirname(this.cachePath), { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify(cache, null, 2))
    return result
  }
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ stdout, stderr, code: code ?? -1 }))
  })
}

/** `x0,y0,x1,y1;x0,y0,x1,y1` — small enough to ride on an attribute. */
export function encodeFaces(faces: FaceBox[]): string {
  return faces.map((face) => face.map((n) => n.toFixed(3)).join(',')).join(';')
}
