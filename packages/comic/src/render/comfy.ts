/**
 * ComfyUI over its HTTP API, as the second renderer beside Forge.
 *
 * What it has that Forge does not: a LoRA confined to a mask inside ONE render
 * (a hook LoRA on a masked conditioning). A character is drawn with her LoRA
 * only inside her figure while the place is drawn with none and without her
 * colours, so there is no seam and no teal cast over the room (2026-09-24,
 * owner: "crazy good").
 *
 * Every picture is a graph posted to `/prompt` and polled on `/history`;
 * images go up through `/upload/image`. LoRAs are not prompt syntax here, so
 * `<lora:name:w>` tags are lifted out of the prompt into loader nodes.
 */

import type { RenderRequest } from '../cache.ts'
import type { ForgeConfig } from '../schema.ts'
import { resolveCheckpoint, resolveControl } from './forge.ts'
import type { InpaintRequest, Needs, Prepared, Progress, Region, RenderResult, Renderer } from './renderer.ts'

/** Forge's sampler names to ComfyUI's. */
const SAMPLERS: Record<string, string> = {
  'DPM++ 2M SDE': 'dpmpp_2m_sde',
  'DPM++ 2M': 'dpmpp_2m',
  'DPM++ SDE': 'dpmpp_sde',
  'DPM++ 3M SDE': 'dpmpp_3m_sde',
  'Euler a': 'euler_ancestral',
  Euler: 'euler',
}

export function comfySampler(name: string): string {
  return SAMPLERS[name] ?? name.toLowerCase().replace(/\+\+/g, 'pp').replace(/[\s-]+/g, '_')
}

/** `<lora:name:weight>` tags out of a prompt, the rest of the prompt kept. */
export function liftLoras(prompt: string): { text: string; loras: Array<{ name: string; weight: number }> } {
  const loras: Array<{ name: string; weight: number }> = []
  const text = prompt
    .replace(/<lora:([^:>]+):([\d.]+)>/g, (_, name: string, weight: string) => {
      loras.push({ name, weight: Number(weight) })
      return ''
    })
    .replace(/\s*,\s*(,\s*)+/g, ', ')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
  return { text, loras }
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export class ComfyRenderer implements Renderer {
  readonly name = 'comfy'
  private readonly url: string
  private readonly timeoutS: number
  private loraFiles: string[] = []

  constructor(config: { url: string; timeout_s: number }, _forge?: ForgeConfig) {
    this.url = config.url.replace(/\/$/, '')
    this.timeoutS = config.timeout_s
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(this.url + path, init)
    } catch (error) {
      throw new Error(`ComfyUI is not answering at ${this.url} (${(error as Error).message}). Start it (run_nvidia_gpu.bat), or point comfy.url at where it runs.`, { cause: error })
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`ComfyUI ${path} returned ${response.status}: ${text.slice(0, 600)}`)
    return JSON.parse(text) as T
  }

  private async options(node: string, input: string): Promise<string[]> {
    const info = await this.call<Record<string, { input: { required: Record<string, [string[]]> } }>>(`/object_info/${node}`)
    return info[node]?.input.required[input]?.[0] ?? []
  }

  async prepare(needs: Needs): Promise<Prepared> {
    const files = await this.options('CheckpointLoaderSimple', 'ckpt_name')
    const checkpoint = resolveCheckpoint(
      files.map((f) => ({ title: f, model_name: f.replace(/\.(safetensors|ckpt)$/, '') })),
      needs.checkpoint,
    )
    this.loraFiles = await this.options('LoraLoader', 'lora_name')
    const names = new Set(this.loraFiles.map((f) => f.replace(/\.safetensors$/, '')))
    const missing = needs.loras.filter((lora) => !names.has(lora))
    if (missing.length > 0) throw new Error(`LoRA${missing.length > 1 ? 's' : ''} not found by ComfyUI: ${missing.join(', ')}`)
    if (!needs.control) return { checkpoint }
    const controls = await this.options('ControlNetLoader', 'control_net_name')
    return { checkpoint, control: resolveControl(controls, needs.control) }
  }

  private loraFile(name: string): string {
    return this.loraFiles.find((f) => f.replace(/\.safetensors$/, '') === name) ?? `${name}.safetensors`
  }

  private async upload(png: Buffer, name: string): Promise<string> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name)
    form.append('overwrite', 'true')
    return (await this.call<{ name: string }>('/upload/image', { method: 'POST', body: form })).name
  }

  /** Sampling, the optional hires pass, decode and save: the tail every graph shares. */
  private tail(graph: Graph, request: RenderRequest, model: [string, number], positive: [string, number], negative: [string, number]): void {
    const sampler = comfySampler(request.sampler)
    const scheduler = request.scheduler.toLowerCase()
    graph['latent'] = { class_type: 'EmptyLatentImage', inputs: { width: request.width, height: request.height, batch_size: 1 } }
    graph['k1'] = {
      class_type: 'KSampler',
      inputs: { model, seed: request.seed, steps: request.steps, cfg: request.cfg, sampler_name: sampler, scheduler, positive, negative, latent_image: ['latent', 0], denoise: 1 },
    }
    let last: [string, number] = ['k1', 0]
    if (request.hires) {
      graph['up'] = { class_type: 'LatentUpscale', inputs: { samples: last, upscale_method: 'bislerp', width: request.hires.width, height: request.hires.height, crop: 'disabled' } }
      graph['k2'] = {
        class_type: 'KSampler',
        inputs: { model, seed: request.seed, steps: request.hires.steps, cfg: request.cfg, sampler_name: sampler, scheduler, positive, negative, latent_image: ['up', 0], denoise: request.hires.denoise },
      }
      last = ['k2', 0]
    }
    graph['dec'] = { class_type: 'VAEDecode', inputs: { samples: last, vae: ['ckpt', 2] } }
    graph['save'] = { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: 'comic' } }
  }

  /** The ControlNet reading the sketch, when the request asks for one. */
  private async control(graph: Graph, request: RenderRequest, controlImage: Buffer | undefined, positive: [string, number], negative: [string, number]): Promise<[[string, number], [string, number]]> {
    if (!request.control || !controlImage) return [positive, negative]
    graph['sketch'] = { class_type: 'LoadImage', inputs: { image: await this.upload(controlImage, `sketch-${request.seed}.png`) } }
    graph['lines'] = { class_type: 'AnimeLineArtPreprocessor', inputs: { image: ['sketch', 0], resolution: 1024 } }
    graph['cn'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: request.control.model } }
    graph['cnapply'] = {
      class_type: 'ControlNetApplyAdvanced',
      inputs: { positive, negative, control_net: ['cn', 0], image: ['lines', 0], strength: request.control.weight, start_percent: 0, end_percent: request.control.end },
    }
    return [['cnapply', 0], ['cnapply', 1]]
  }

  async render(request: RenderRequest, onProgress?: Progress, controlImage?: Buffer): Promise<RenderResult> {
    const graph: Graph = { ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: request.checkpoint } } }
    const { text, loras } = liftLoras(request.prompt)
    let model: [string, number] = ['ckpt', 0]
    let clip: [string, number] = ['ckpt', 1]
    for (const [i, lora] of loras.entries()) {
      graph[`lora${i}`] = { class_type: 'LoraLoader', inputs: { model, clip, lora_name: this.loraFile(lora.name), strength_model: lora.weight, strength_clip: lora.weight } }
      model = [`lora${i}`, 0]
      clip = [`lora${i}`, 1]
    }
    graph['pos'] = { class_type: 'CLIPTextEncode', inputs: { clip, text } }
    graph['neg'] = { class_type: 'CLIPTextEncode', inputs: { clip, text: request.negative } }
    const [positive, negative] = await this.control(graph, request, controlImage, ['pos', 0], ['neg', 0])
    this.tail(graph, request, model, positive, negative)
    return this.run(graph, onProgress)
  }

  /**
   * One render, each character's LoRA confined to her mask: the background
   * prompt over the whole picture with no LoRA, each region's prompt with its
   * hook LoRA inside its mask, all combined into one positive.
   */
  async renderRegional(request: RenderRequest, background: string, regions: Region[], controlImage?: Buffer, onProgress?: Progress, fade?: { from: number; to_strength: number }): Promise<RenderResult> {
    const graph: Graph = { ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: request.checkpoint } } }
    graph['bg'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['ckpt', 1], text: background } }
    let positive: [string, number] = ['bg', 0]
    const uploaded = await Promise.all(regions.map((region, i) => this.upload(region.mask, `mask-${request.seed}-${i}.png`)))
    for (const [i, region] of regions.entries()) {
      const { text, loras } = liftLoras(region.prompt)
      graph[`r${i}txt`] = { class_type: 'CLIPTextEncode', inputs: { clip: ['ckpt', 1], text } }
      graph[`r${i}img`] = { class_type: 'LoadImage', inputs: { image: uploaded[i]! } }
      graph[`r${i}mask`] = { class_type: 'ImageToMask', inputs: { image: [`r${i}img`, 0], channel: 'red' } }
      let hooks: [string, number] | undefined
      for (const [j, lora] of loras.entries()) {
        const id = `r${i}hook${j}`
        graph[id] = { class_type: 'CreateHookLora', inputs: { lora_name: this.loraFile(lora.name), strength_model: lora.weight, strength_clip: lora.weight, ...(hooks ? { prev_hooks: hooks } : {}) } }
        hooks = [id, 0]
      }
      if (hooks && fade && fade.from < 1) {
        // Full strength while her shape and face are decided, easing off for
        // the last steps, where the picture's light is settled.
        graph[`r${i}kf`] = {
          class_type: 'CreateHookKeyframesInterpolated',
          inputs: { strength_start: 1, strength_end: fade.to_strength, interpolation: 'ease_in', start_percent: fade.from, end_percent: 1, keyframes_count: 5, print_keyframes: false },
        }
        graph[`r${i}hkf`] = { class_type: 'SetHookKeyframes', inputs: { hooks, hook_kf: [`r${i}kf`, 0] } }
        hooks = [`r${i}hkf`, 0]
      }
      graph[`r${i}`] = {
        class_type: 'ConditioningSetProperties',
        inputs: { cond_NEW: [`r${i}txt`, 0], strength: 1, set_cond_area: 'default', mask: [`r${i}mask`, 0], ...(hooks ? { hooks } : {}) },
      }
      graph[`comb${i}`] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: positive, conditioning_2: [`r${i}`, 0] } }
      positive = [`comb${i}`, 0]
    }
    graph['neg'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['ckpt', 1], text: request.negative } }
    const [pos, neg] = await this.control(graph, request, controlImage, positive, ['neg', 0])
    this.tail(graph, request, ['ckpt', 0], pos, neg)
    return this.run(graph, onProgress)
  }

  async inpaint(_request: InpaintRequest): Promise<RenderResult> {
    throw new Error('the ComfyUI renderer draws every character in one regional pass and has no inpaint step; plates and the Forge repaint route need renderer "forge"')
  }

  private async run(graph: Graph, onProgress?: Progress): Promise<RenderResult> {
    const { prompt_id: id } = await this.call<{ prompt_id: string }>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph }),
    })
    const deadline = Date.now() + this.timeoutS * 1000
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1500))
      // eslint-disable-next-line no-await-in-loop
      const history = await this.call<Record<string, { status?: { status_str?: string; messages?: unknown }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }>>(`/history/${id}`)
      const entry = history[id]
      if (!entry) continue
      if (entry.status?.status_str === 'error') throw new Error(`ComfyUI failed the graph: ${JSON.stringify(entry.status.messages).slice(0, 800)}`)
      const image = entry.outputs?.['save']?.images?.[0]
      if (!image) continue
      onProgress?.(1, 0)
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`${this.url}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${image.type}`)
      // eslint-disable-next-line no-await-in-loop
      return { png: Buffer.from(await response.arrayBuffer()), info: { comfy_prompt_id: id } }
    }
    throw new Error(`ComfyUI did not finish within ${this.timeoutS}s`)
  }
}
