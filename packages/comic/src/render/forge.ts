/**
 * Stable Diffusion WebUI Forge over its A1111-compatible API.
 *
 * Everything this sends was measured against the Forge build in this house:
 * `override_settings` selects the checkpoint per request (so a batch is never
 * disturbed by a global switch), `override_settings_restore_afterwards: false`
 * keeps it loaded for the next panel, and the LoRA rides in the prompt as
 * `<lora:name:weight>` — which is why `prepare` reads `/sdapi/v1/loras` first:
 * a misspelt LoRA name is not an error to Forge, it is a render without her.
 */

import type { RenderRequest } from '../cache.ts'
import type { ForgeConfig } from '../schema.ts'
import type { InpaintRequest, Needs, Prepared, Progress, RenderResult, Renderer } from './renderer.ts'

interface SdModel {
  title: string
  model_name: string
  filename?: string
}

interface LoraEntry {
  name: string
  alias?: string
}

export class ForgeRenderer implements Renderer {
  readonly name = 'forge'
  private readonly config: ForgeConfig

  constructor(config: ForgeConfig) {
    this.config = config
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(this.config.url + path, init)
    } catch (error) {
      throw new Error(
        `Forge is not answering at ${this.config.url} (${(error as Error).message}). ` +
          'Start it with --api, or point forge.url at where it runs.',
        { cause: error },
      )
    }
    if (!response.ok) {
      // The body, not only the status: a failed generation is a 500 whose
      // payload names the actual exception.
      let detail = ''
      try {
        const body = await response.text()
        const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown }
        detail = String(parsed.detail ?? parsed.error ?? body)
      } catch {
        detail = ''
      }
      throw new Error(`${path} returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ''}`)
    }
    return (await response.json()) as T
  }

  async prepare(needs: Needs): Promise<Prepared> {
    const models = await this.call<SdModel[]>('/sdapi/v1/sd-models')
    const checkpoint = resolveCheckpoint(models, needs.checkpoint)

    const installed = await this.call<LoraEntry[]>('/sdapi/v1/loras')
    const names = new Set(installed.flatMap((entry) => [entry.name, entry.alias].filter((n): n is string => !!n)))
    const missing = needs.loras.filter((lora) => !names.has(lora))
    if (missing.length > 0) {
      throw new Error(
        `LoRA${missing.length > 1 ? 's' : ''} not installed in Forge: ${missing.join(', ')}.\n` +
          `  Installed: ${[...names].sort().join(', ')}`,
      )
    }
    return { checkpoint }
  }

  async render(request: RenderRequest, onProgress?: Progress): Promise<RenderResult> {
    return this.generate('/sdapi/v1/txt2img', toPayload(request, this.config), onProgress)
  }

  async inpaint(request: InpaintRequest, onProgress?: Progress): Promise<RenderResult> {
    return this.generate('/sdapi/v1/img2img', toInpaintPayload(request, this.config), onProgress)
  }

  private async generate(path: string, payload: Record<string, unknown>, onProgress?: Progress): Promise<RenderResult> {
    const stop = new AbortController()
    const poll = onProgress ? this.watchProgress(onProgress, stop.signal) : Promise.resolve()
    try {
      const answer = await this.call<{ images?: string[]; info?: string }>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeout_s * 1000),
      })
      const image = answer.images?.[0]
      if (!image) throw new Error(`Forge accepted the ${path} request but returned no image`)
      // The data URI prefix is present on some builds and absent on others.
      const png = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      let info: unknown
      try {
        info = answer.info ? JSON.parse(answer.info) : undefined
      } catch {
        info = answer.info
      }
      return { png, info }
    } finally {
      stop.abort()
      await poll
    }
  }

  /**
   * Forge's extras endpoint, which runs an ESRGAN-family model rather than
   * the sampler: no seed, no prompt, no chance of it inventing a second
   * head the way a high-resolution re-sample can.
   */
  async upscale(png: Buffer, scale: number, model: string): Promise<Buffer> {
    const answer = await this.call<{ image?: string }>('/sdapi/v1/extra-single-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: png.toString('base64'),
        resize_mode: 0,
        upscaling_resize: scale,
        upscaler_1: model,
        upscale_first: false,
      }),
      signal: AbortSignal.timeout(this.config.timeout_s * 1000),
    })
    if (!answer.image) throw new Error(`Forge's upscaler "${model}" returned no image`)
    return Buffer.from(answer.image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  }

  private async watchProgress(onProgress: Progress, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (signal.aborted) return
      try {
        // eslint-disable-next-line no-await-in-loop
        const progress = await this.call<{ progress?: number; eta_relative?: number }>(
          '/sdapi/v1/progress?skip_current_image=true',
        )
        onProgress(Number(progress.progress ?? 0), progress.eta_relative)
      } catch {
        // Progress is decoration. The render call reports the real failure.
      }
    }
  }
}

/**
 * The checkpoint whose name contains `wanted`.
 *
 * An exact `model_name` wins; otherwise the substring must be unique, because
 * `noob` is inside `delnoob` as well as `noobaiXL…` and picking silently is
 * how a page comes out in the wrong style with nothing saying so.
 */
export function resolveCheckpoint(models: SdModel[], wanted: string): string {
  const needle = wanted.toLowerCase()
  const exact = models.find((m) => m.model_name.toLowerCase() === needle || m.title.toLowerCase() === needle)
  if (exact) return exact.title
  const matches = models.filter((m) => m.model_name.toLowerCase().includes(needle) || m.title.toLowerCase().includes(needle))
  if (matches.length === 1) return matches[0]!.title
  if (matches.length === 0) {
    throw new Error(
      `no checkpoint matches "${wanted}". Installed: ${models.map((m) => m.model_name).join(', ')}`,
    )
  }
  throw new Error(
    `"${wanted}" matches ${matches.length} checkpoints (${matches.map((m) => m.model_name).join(', ')}); name one exactly`,
  )
}

export function toPayload(request: RenderRequest, config: Pick<ForgeConfig, 'save_to_forge'>): Record<string, unknown> {
  const overrides: Record<string, unknown> = { sd_model_checkpoint: request.checkpoint }
  if (request.clip_skip !== undefined) overrides['CLIP_stop_at_last_layers'] = request.clip_skip
  return {
    prompt: request.prompt,
    negative_prompt: request.negative,
    seed: request.seed,
    subseed_strength: 0,
    steps: request.steps,
    cfg_scale: request.cfg,
    sampler_name: request.sampler,
    scheduler: request.scheduler,
    width: request.width,
    height: request.height,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: config.save_to_forge,
    override_settings: overrides,
    override_settings_restore_afterwards: false,
  }
}

/**
 * The inpaint call: the plate as the init image, the stand-in's mask as the
 * mask, painted at high strength. `inpaint_full_res` renders the masked
 * region at full resolution and pastes it back, which is what keeps a face
 * sharp inside a wide plate; `inpainting_fill: 1` starts from the original
 * pixels, so the mannequin's silhouette guides the pose.
 */
export function toInpaintPayload(request: InpaintRequest, config: Pick<ForgeConfig, 'save_to_forge'>): Record<string, unknown> {
  return {
    ...toPayload(request, config),
    init_images: [request.init.toString('base64')],
    mask: request.mask.toString('base64'),
    denoising_strength: request.denoise,
    mask_blur: request.mask_blur,
    inpainting_fill: 1,
    inpaint_full_res: true,
    inpaint_full_res_padding: request.padding,
    inpainting_mask_invert: 0,
    resize_mode: 0,
    image_cfg_scale: request.cfg,
  }
}
