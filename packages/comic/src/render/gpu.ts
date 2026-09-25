/**
 * The card is shared with LoRA training, and a render beside a kohya run is
 * what killed `ari_adopt_v1` (2026-09-16: VRAM full, CUDA illegal memory
 * access). On 2026-09-25 a comic render still started beside `ari_gen_v6`,
 * because the rule lived in memory and nothing checked it. So every real
 * renderer checks here before it touches the GPU, and refuses.
 *
 * A PAUSED training is the exception: `D:\AI\lora-train\pause-training.py
 * pause` suspends the trainer, the GPU goes idle with ~11 GB free, and the
 * owner renders in that window several times a day (.ai/lora-training.md §9).
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const TRAINER = 'sdxl_train_network'
const PAUSE_SCRIPT = 'D:\\AI\\lora-train\\pause-training.py'
const KOHYA_PYTHON = 'D:\\AI\\lora-train\\venv\\Scripts\\python.exe'

/** Whether a kohya training process is running on this machine. Windows only; elsewhere, false. */
export function trainingRunning(): boolean {
  if (process.platform !== 'win32') return false
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match '${TRAINER}' } | Measure-Object).Count`],
    { encoding: 'utf8' },
  )
  return Number((result.stdout ?? '0').trim()) > 0
}

/**
 * Whether every trainer process is suspended. Anything the script cannot
 * answer counts as NOT paused: a wrong "paused" costs a training run, a wrong
 * "running" costs one retry.
 */
export function trainingPaused(): boolean {
  if (!existsSync(PAUSE_SCRIPT) || !existsSync(KOHYA_PYTHON)) return false
  const result = spawnSync(KOHYA_PYTHON, [PAUSE_SCRIPT, 'status'], { encoding: 'utf8' })
  if (result.status !== 0) return false
  return isPausedStatus(result.stdout ?? '')
}

/** `pause-training.py status` prints `<pid>  <status>  <cmdline>` per process; paused means all `stopped`. */
export function isPausedStatus(output: string): boolean {
  const states = output
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((state): state is string => !!state)
  return states.length > 0 && states.every((state) => state === 'stopped')
}

export function assertGpuFree(): void {
  if (trainingRunning() && !trainingPaused()) {
    throw new Error(
      'a LoRA training is running on this GPU; nothing renders until it has finished or is paused (pause-training.py pause) - see the never-render-while-training rule',
    )
  }
}
