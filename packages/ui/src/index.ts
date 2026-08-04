/**
 * @luma/ui — the app-agnostic parts of the interface.
 *
 * Nothing here imports Tauri, the native seam, or anything from `apps/web`.
 * That boundary is what keeps the kit testable in a plain jsdom environment and
 * keeps the app's own components honest about where native access happens.
 *
 * Export only what the app actually consumes; internal helpers stay in their
 * modules.
 */

export { cn } from './cn.ts'
export { Button } from './button.tsx'
export { Pill } from './pill.tsx'
export { ProgressBar } from './progress-bar.tsx'
export { Spinner } from './spinner.tsx'
export { EmptyState } from './empty-state.tsx'
export { Dialog } from './dialog.tsx'
