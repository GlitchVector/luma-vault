/**
 * `claude -p` as a writer.
 *
 * Run with every tool off, no settings sources and no session persistence,
 * so it neither reads this repo's CLAUDE.md into the story nor leaves a
 * session behind. `--json-schema` makes the CLI hand back a parsed object in
 * `structured_output`; the prose goes in on stdin so a long story never hits
 * the command-line length limit.
 */

import { spawn } from 'node:child_process'
import type { Writer, WriterInput } from './writer.ts'

export class ClaudeCliWriter implements Writer {
  readonly name = 'claude-cli'
  private readonly executable: string

  constructor(executable = process.platform === 'win32' ? 'claude.exe' : 'claude') {
    this.executable = executable
  }

  async write(input: WriterInput): Promise<unknown> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(input.schema),
      '--system-prompt',
      input.system,
      '--tools',
      '',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--model',
      input.model,
    ]
    const { stdout, stderr, code } = await run(this.executable, args, input.prompt)
    if (code !== 0) {
      throw new Error(`claude exited with ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`)
    }
    let reply: { structured_output?: unknown; result?: string; is_error?: boolean; subtype?: string }
    try {
      reply = JSON.parse(stdout)
    } catch {
      throw new Error(`claude returned something that is not JSON: ${stdout.slice(0, 200)}`)
    }
    if (reply.is_error) throw new Error(`claude reported an error: ${reply.result ?? reply.subtype ?? 'unknown'}`)
    if (reply.structured_output !== undefined) return reply.structured_output
    if (typeof reply.result === 'string') return JSON.parse(reply.result)
    throw new Error('claude returned neither structured output nor a result')
  }
}

function run(command: string, args: string[], stdin: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // A temp-free neutral cwd: the CLI reads project settings from the
      // directory it runs in, and `--setting-sources ""` is belt and braces.
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
