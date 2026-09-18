/**
 * Any server that speaks `POST /v1/chat/completions`: Ollama, LM Studio,
 * llama.cpp's server, vLLM. That is every local model the plan has in mind,
 * behind one URL and one model name in `studio.config.json`.
 *
 * JSON answers ask for `response_format: json_object` — which the three
 * local servers honour — and are still parsed leniently, because a model
 * that wraps its object in a sentence is not worth a failed call.
 */

import type { CompletionOptions, Message, StoryModel } from './model.ts'

export class OpenAiCompatibleModel implements StoryModel {
  readonly name: string
  private readonly url: string
  private readonly model: string
  private readonly key: string | undefined
  private readonly temperature: number

  constructor(config: { url: string; model: string; api_key_env: string; temperature: number }) {
    this.url = config.url.replace(/\/+$/, '')
    this.model = config.model
    this.key = process.env[config.api_key_env]
    this.temperature = config.temperature
    this.name = `${config.model} @ ${this.url}`
  }

  async complete(messages: Message[], options: CompletionOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: options.json
        ? [
            ...messages.slice(0, -1),
            {
              ...messages.at(-1)!,
              content: `${messages.at(-1)!.content}\n\nAnswer with one JSON object and nothing else. It must satisfy this JSON Schema:\n${JSON.stringify(options.json)}`,
            },
          ]
        : messages,
      temperature: options.temperature ?? this.temperature,
      stream: false,
    }
    if (options.json) body['response_format'] = { type: 'json_object' }
    let response: Response
    try {
      response = await fetch(`${this.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      })
    } catch (error) {
      throw new Error(`no model server at ${this.url} (${(error as Error).message}) — start Ollama or LM Studio, or set model.backend to claude-cli`, { cause: error })
    }
    if (!response.ok) throw new Error(`${this.url} answered ${response.status}: ${(await response.text()).slice(0, 400)}`)
    const reply = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = reply.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('the model server answered without a message')
    return text
  }
}
