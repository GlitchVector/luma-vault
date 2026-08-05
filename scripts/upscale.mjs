#!/usr/bin/env node
//
// Runs the upscaler in its venv.  `pnpm upscale -- --input <dir> ...`
//
// A wrapper so nobody has to remember that the interpreter is under Scripts on
// Windows and bin everywhere else, and so a missing venv says what to do rather
// than "file not found".
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const isWindows = process.platform === 'win32'
const python = join(root, 'venv-upscaler', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python')

if (!existsSync(python)) {
  console.error('error: venv-upscaler is missing. Run `pnpm setup:upscaler` first.')
  process.exit(1)
}

// pnpm forwards the `--` separator itself, so `pnpm upscale -- --input x`
// arrives here with a literal `--` in front of the real flags and argparse
// rejects the lot. Dropping a leading one costs nothing: it is a separator, and
// no argument of ours is spelled that way.
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()

const { status, error } = spawnSync(
  python,
  [join(root, 'sidecar', 'upscaler', 'upscale.py'), ...args],
  { stdio: 'inherit' },
)

if (error) {
  console.error(`error: could not run the upscaler: ${error.message}`)
  process.exit(1)
}
process.exit(status ?? 1)
