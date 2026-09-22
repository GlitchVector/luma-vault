/**
 * Any server that speaks `POST /v1/chat/completions`: Ollama, LM Studio,
 * llama.cpp's server, vLLM — and, since they speak the same protocol, the
 * hosted ones too. xAI's Grok is `https://api.x.ai/v1` with a key in
 * `XAI_API_KEY`, and needs no code of its own.
 *
 * A hosted endpoint is treated differently in exactly two places, both about
 * failing usefully: a missing key is an error before the request rather than
 * a 401 after it, and a connection failure does not tell someone to start
 * Ollama when the URL is somebody else's server.
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
  private readonly keyEnv: string
  private readonly temperature: number

  constructor(config: { url: string; model: string; api_key_env: string; temperature: number }) {
    this.url = config.url.replace(/\/+$/, '')
    this.model = config.model
    this.keyEnv = config.api_key_env
    this.key = process.env[config.api_key_env]
    this.temperature = config.temperature
    this.name = `${config.model} @ ${this.url}`
  }

  /** Somebody else's server, rather than one on this machine. */
  get remote(): boolean {
    return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(this.url)
  }

  /** Why it cannot run, or null. Checked before the call so a missing key is
   *  a sentence rather than a 401. */
  available(): string | null {
    if (this.remote && !this.key) {
      return `${this.url} needs a key and ${this.keyEnv} is not set — put it in the repo's .env`
    }
    return null
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
    const why = this.available()
    if (why) throw new Error(why)
    let response: Response
    try {
      response = await fetch(`${this.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      })
    } catch (error) {
      throw new Error(
        this.remote
          ? `could not reach ${this.url} (${(error as Error).message}) — check the network and the service's status`
          : `no model server at ${this.url} (${(error as Error).message}) — start Ollama or LM Studio, or set model.backend to claude-cli`,
        { cause: error },
      )
    }
    if (!response.ok) throw new Error(`${this.url} answered ${response.status}: ${(await response.text()).slice(0, 400)}`)
    const reply = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = reply.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('the model server answered without a message')
    return text
  }
}
