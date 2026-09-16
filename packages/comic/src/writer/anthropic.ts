/**
 * The Anthropic Messages API as a writer, for a machine without the CLI.
 *
 * Plain `fetch`, no SDK: one request, one reply. The schema is described in
 * the system prompt and the reply is asked to be bare JSON; `extractJson`
 * copes with a fenced block anyway. Needs `ANTHROPIC_API_KEY` in the
 * environment or in the repo's `.env`.
 */

import { extractJson, type Writer, type WriterInput } from './writer.ts'

export class AnthropicWriter implements Writer {
  readonly name = 'anthropic'

  async write(input: WriterInput): Promise<unknown> {
    const key = process.env['ANTHROPIC_API_KEY']
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set; use the claude-cli writer or add the key to .env')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 16000,
        system:
          `${input.system}\n\nReply with one JSON object and nothing else. It must satisfy this JSON Schema:\n` +
          JSON.stringify(input.schema),
        messages: [{ role: 'user', content: input.prompt }],
      }),
    })
    if (!response.ok) throw new Error(`Anthropic API returned ${response.status}: ${(await response.text()).slice(0, 400)}`)
    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
    return extractJson(text)
  }
}
