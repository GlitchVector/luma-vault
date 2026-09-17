/**
 * Which panels a command is about. `--page N` narrows to a page; `--panel`
 * takes an id (`p2-3`) or, with a page, the panel's number on it.
 */

import type { Script } from '../schema.ts'

export interface PanelFilter {
  /** 1-based page number. */
  page?: number
  /** A panel id (`p2-3`) or its 1-based number within `--page`. */
  panel?: string
}

export function selectPanels(script: Script, filter: PanelFilter): Array<{ pageIndex: number; panelIndex: number }> {
  const picked: Array<{ pageIndex: number; panelIndex: number }> = []
  script.pages.forEach((page, pageIndex) => {
    if (filter.page !== undefined && filter.page !== pageIndex + 1) return
    page.panels.forEach((panel, panelIndex) => {
      if (filter.panel !== undefined) {
        const byNumber = /^\d+$/.test(filter.panel) && Number(filter.panel) === panelIndex + 1
        if (!byNumber && panel.id !== filter.panel) return
        if (byNumber && filter.page === undefined) throw new Error('--panel <number> needs --page; or give the panel id')
      }
      picked.push({ pageIndex, panelIndex })
    })
  })
  if (picked.length === 0) throw new Error('no panel matches the filter')
  return picked
}
