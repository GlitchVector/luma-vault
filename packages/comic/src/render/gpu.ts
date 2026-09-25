/**
 * The card is shared with LoRA training, and a render beside a kohya run is
 * what killed `ari_adopt_v1` (2026-09-16: VRAM full, CUDA illegal memory
 * access). On 2026-09-25 a comic render still started beside `ari_gen_v6`,
 * because the rule lived in memory and nothing checked it. So every real
 * renderer checks here before it touches the GPU, and refuses.
 */

import { spawnSync } from 'node:child_process'

const TRAINER = 'sdxl_train_network'

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

export function assertGpuFree(): void {
  if (trainingRunning()) {
    throw new Error('a LoRA training is running on this GPU; nothing renders until it has finished (see the never-render-while-training rule)')
  }
}
