/**
 * The seam in front of the story model.
 *
 * Chat-shaped, because character and story work is a conversation with
 * context in front of it. Two backends: any OpenAI-compatible server (Ollama,
 * LM Studio, llama.cpp — the local, uncensored models the plan wants) and
 * the claude CLI as the fallback on a machine without one. The model's
 * memory is never the source of truth; every call is built from files.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionOptions {
  /** Ask for a JSON object satisfying this schema; the reply is parsed. */
  json?: Record<string, unknown>
  temperature?: number
}

export interface StoryModel {
  readonly name: string
  complete(messages: Message[], options?: CompletionOptions): Promise<string>
}

/** The first balanced `{...}` in a reply, for a backend that cannot promise bare JSON. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  if (start < 0) throw new Error(`the model returned no JSON object:\n${text.slice(0, 400)}`)
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
  throw new Error('the model returned an unterminated JSON object')
}

/** A model that answers from a list, for tests and dry runs. */
export class ScriptedModel implements StoryModel {
  readonly name = 'scripted'
  readonly calls: Message[][] = []
  private readonly answers: string[]

  constructor(answers: string[]) {
    this.answers = [...answers]
  }

  async complete(messages: Message[]): Promise<string> {
    this.calls.push(messages)
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error('the scripted model has no answer left')
    return answer
  }
}
