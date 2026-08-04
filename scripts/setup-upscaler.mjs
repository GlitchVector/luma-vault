#!/usr/bin/env node
//
// Builds the upscaler's virtualenv.  `pnpm setup:upscaler`
//
// One cross-platform script rather than the .ps1/.sh pair `setup:python` needs,
// because everything here is `python -m ...` — there is no platform-specific
// shell work beyond finding the interpreter and the venv's bin directory.
//
// torch is installed on its own line, from PyTorch's index rather than PyPI.
// The PyPI wheel is CPU-only: it installs cleanly, imports cleanly, and runs an
// upscale about fifty times slower with nothing anywhere saying why. That is the
// single most likely way this setup goes quietly wrong, which is why the check
// at the end fails loudly rather than printing a warning.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const venv = join(root, 'venv-upscaler')
const isWindows = process.platform === 'win32'
const python = join(venv, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python')

/** PyTorch build to pull. Matched to a driver new enough for a 30-series card. */
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu126'
const TORCH = ['torch==2.13.0+cu126', 'torchvision==0.28.0+cu126']

function run(command, args, options = {}) {
  const { status, error } = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (error) fail(`could not run ${command}: ${error.message}`)
  if (status !== 0) fail(`${command} ${args[0] ?? ''} exited with ${status}`)
}

function fail(message) {
  console.error(`\nerror: ${message}`)
  process.exit(1)
}

/** The newest interpreter this stack supports. 3.14 has no torch wheels yet. */
function findInterpreter() {
  const candidates = isWindows
    ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.13']], ['python', []]]
    : [['python3.12', []], ['python3.11', []], ['python3.13', []], ['python3', []]]

  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' })
    if (probe.status !== 0) continue
    const version = `${probe.stdout}${probe.stderr}`.trim()
    const [, major, minor] = /Python (\d+)\.(\d+)/.exec(version) ?? []
    if (major !== '3' || Number(minor) < 10 || Number(minor) > 13) continue
    return { command, prefix, version }
  }
  fail('no Python 3.10-3.13 found. torch has no wheels outside that range.')
}

if (!existsSync(python)) {
  const { command, prefix, version } = findInterpreter()
  console.log(`creating venv-upscaler with ${version}`)
  run(command, [...prefix, '-m', 'venv', venv])
} else {
  console.log('venv-upscaler already exists')
}

run(python, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'pip'])

console.log('\ninstalling torch (CUDA build, ~2.5GB on a cold cache)')
run(python, ['-m', 'pip', 'install', '--index-url', TORCH_INDEX, ...TORCH])

console.log('\ninstalling the rest')
run(python, ['-m', 'pip', 'install', '-r', join(root, 'sidecar', 'upscaler', 'requirements.txt')])

console.log('\nchecking')
const check = spawnSync(
  python,
  [
    '-c',
    [
      'import torch, spandrel',
      'print("torch    ", torch.__version__)',
      'print("spandrel ", spandrel.__version__)',
      'ok = torch.cuda.is_available()',
      'print("cuda     ", torch.cuda.get_device_name(0) if ok else "NOT AVAILABLE")',
      'raise SystemExit(0 if ok else 3)',
    ].join('\n'),
  ],
  { stdio: 'inherit' },
)

if (check.status === 3) {
  fail(
    'torch cannot see a GPU. An upscale will still run, on the CPU, at roughly\n' +
      '       fifty times the cost. Check the NVIDIA driver, then delete venv-upscaler\n' +
      '       and run this again.',
  )
}
if (check.status !== 0) fail('the installed packages do not import')

console.log('\nready:  pnpm upscale -- --input <dir> --output <dir> --model <model.pth>')
