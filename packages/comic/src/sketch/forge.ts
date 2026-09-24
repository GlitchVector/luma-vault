/**
 * The local sketch backend: a composing checkpoint in Forge (NoobAI by
 * default) draws the panel from its own tags with nobody's LoRA. Nothing
 * leaves the machine, so it may sketch any panel, explicit ones included,
 * and costs nothing; what it cannot do is stage from sentences — a tag model
 * places people by tags, not by "the man on the left does X".
 */

import type { PlateBackend, PlateRequest, PlateResult } from '../plates/plate.ts'
import type { ForgeRenderer } from '../render/forge.ts'
import type { ForgeConfig } from '../schema.ts'

export class ForgeSketches implements PlateBackend {
  readonly name = 'forge'
  private checkpoint: string | undefined
  private readonly renderer: ForgeRenderer
  private readonly wanted: string
  private readonly config: ForgeConfig

  constructor(renderer: ForgeRenderer, wanted: string, config: ForgeConfig) {
    this.renderer = renderer
    this.wanted = wanted
    this.config = config
  }

  async prepare(): Promise<void> {
    this.checkpoint ??= (await this.renderer.prepare({ checkpoint: this.wanted, loras: [] })).checkpoint
  }

  async draw(request: PlateRequest): Promise<PlateResult> {
    await this.prepare()
    const [width, height] = request.size.split('x').map(Number) as [number, number]
    const result = await this.renderer.render({
      prompt: request.prompt,
      negative: request.negative ?? '',
      seed: request.seed ?? 1,
      width,
      height,
      steps: this.config.steps,
      cfg: this.config.cfg,
      sampler: this.config.sampler,
      scheduler: this.config.scheduler,
      checkpoint: this.checkpoint!,
      backend: 'forge',
    })
    return { png: result.png, info: { checkpoint: this.checkpoint, forge: result.info } }
  }
}
