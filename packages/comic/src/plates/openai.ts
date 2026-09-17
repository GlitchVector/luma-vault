/**
 * OpenAI's image models as the plate backend.
 *
 * `POST /v1/images/generations` draws a place from words; `POST
 * /v1/images/edits` (multipart, one or more `image[]` files) draws a new
 * view of a place it is shown, which is what keeps every panel set in one
 * location on the same rooftop. GPT image models answer with `b64_json`.
 *
 * A refusal comes back as a 400 whose body names the policy; it is thrown
 * with the prompt so the person can see which words to move from `setting`
 * to `scene`. Nothing explicit is meant to reach here in the first place.
 */

import type { PlateBackend, PlateRequest, PlateResult } from './plate.ts'

const API = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'

export class OpenAiPlates implements PlateBackend {
  readonly name = 'openai'
  private readonly model: string
  private readonly key: string | undefined

  constructor(model: string, key = process.env['OPENAI_API_KEY']) {
    this.model = model
    this.key = key
  }

  async prepare(): Promise<void> {
    if (!this.key) {
      throw new Error('OPENAI_API_KEY is not set — add it to .env, or set plates.backend to "none" in comic.config.json')
    }
  }

  async draw(request: PlateRequest): Promise<PlateResult> {
    await this.prepare()
    const references = request.references ?? []
    const init: RequestInit =
      references.length > 0
        ? { method: 'POST', body: editForm(this.model, request) }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(generateBody(this.model, request)),
          }
    const path = references.length > 0 ? '/images/edits' : '/images/generations'
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(180_000),
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = text
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } }
        detail = `${parsed.error?.code ?? response.status}: ${parsed.error?.message ?? text}`
      } catch {
        // The body was not JSON; the raw text says enough.
      }
      throw new Error(`OpenAI ${path} refused (${detail.slice(0, 400)})\n  prompt: ${request.prompt.slice(0, 300)}`)
    }
    const body = JSON.parse(text) as { data?: Array<{ b64_json?: string }>; usage?: unknown }
    const b64 = body.data?.[0]?.b64_json
    if (!b64) throw new Error('OpenAI answered without an image')
    return { png: Buffer.from(b64, 'base64'), info: { model: this.model, usage: body.usage } }
  }
}

export function generateBody(model: string, request: PlateRequest): Record<string, unknown> {
  return {
    model,
    prompt: request.prompt,
    n: 1,
    size: request.size,
    quality: request.quality,
    output_format: 'png',
    moderation: 'low',
  }
}

/** The edit call is multipart: every reference as `image[]`, the rest as fields. */
export function editForm(model: string, request: PlateRequest): FormData {
  const form = new FormData()
  form.set('model', model)
  form.set('prompt', request.prompt)
  form.set('n', '1')
  form.set('size', request.size)
  form.set('quality', request.quality)
  form.set('output_format', 'png')
  if (request.input_fidelity) form.set('input_fidelity', request.input_fidelity)
  for (const [index, reference] of (request.references ?? []).entries()) {
    form.append('image[]', new Blob([new Uint8Array(reference)], { type: 'image/png' }), `reference-${index}.png`)
  }
  return form
}
