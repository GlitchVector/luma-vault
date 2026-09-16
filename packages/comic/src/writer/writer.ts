/**
 * The seam in front of whichever language model turns prose into a script.
 *
 * Two backends: the `claude` CLI already on this machine (uses the same login
 * as the terminal, no key to manage, structured output enforced by
 * `--json-schema`) and the Anthropic API for a machine without it. Both take
 * the same three things and give back one parsed JSON value; validation
 * against the script schema happens in the stage, not here.
 */

export interface WriterInput {
  system: string
  prompt: string
  /** A JSON Schema the answer must satisfy. */
  schema: Record<string, unknown>
  model: string
}

export interface Writer {
  readonly name: string
  write(input: WriterInput): Promise<unknown>
}

/** The first balanced `{...}` in a reply, for a backend that cannot promise
 *  bare JSON. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  if (start < 0) throw new Error('the writer returned no JSON object')
  let depth = 0
  let inString = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1))
    }
  }
  throw new Error('the writer returned an unterminated JSON object')
}
