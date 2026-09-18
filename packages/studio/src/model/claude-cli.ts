/**
 * The `claude` CLI as a story model, for a machine without a local one.
 *
 * Tools off, no settings sources, no session: it must not read this repo's
 * CLAUDE.md into a character. The conversation is flattened into one prompt
 * because print mode is single-turn; the system message rides on
 * `--system-prompt`. It will refuse explicit material — that is what the
 * local backend is for — and the refusal comes back as the model's own words.
 */

import { spawn } from 'node:child_process'
import type { CompletionOptions, Message, StoryModel } from './model.ts'

export class ClaudeCliModel implements StoryModel {
  readonly name: string
  private readonly model: string

  constructor(model: string) {
    this.model = model
    this.name = `claude-cli ${model}`
  }

  async complete(messages: Message[], options: CompletionOptions = {}): Promise<string> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const turns = messages.filter((m) => m.role !== 'system')
    const prompt =
      turns.length === 1
        ? turns[0]!.content
        : turns.map((m) => `${m.role === 'user' ? 'DIRECTOR' : 'YOU'}:\n${m.content}`).join('\n\n') + '\n\nYOU:'
    const args = ['-p', '--output-format', 'json', '--tools', '', '--setting-sources', '', '--no-session-persistence', '--model', this.model]
    if (system) args.push('--system-prompt', system)
    if (options.json) args.push('--json-schema', JSON.stringify(options.json))
    const { stdout, stderr, code } = await run(process.platform === 'win32' ? 'claude.exe' : 'claude', args, prompt)
    if (code !== 0) throw new Error(`claude exited with ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`)
    let reply: { structured_output?: unknown; result?: string; is_error?: boolean }
    try {
      reply = JSON.parse(stdout)
    } catch {
      throw new Error(`claude returned something that is not JSON: ${stdout.slice(0, 200)}`)
    }
    if (reply.is_error) throw new Error(`claude reported an error: ${reply.result ?? 'unknown'}`)
    if (options.json && reply.structured_output !== undefined) return JSON.stringify(reply.structured_output)
    if (typeof reply.result === 'string') return reply.result
    throw new Error('claude returned no result')
  }
}

function run(command: string, args: string[], stdin: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.env['TEMP'] ?? process.env['TMPDIR'] ?? process.cwd(),
      env: { ...process.env, CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }))
    child.stdin.end(stdin)
  })
}
