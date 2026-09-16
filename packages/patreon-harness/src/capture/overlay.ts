/**
 * The checklist panel that rides along in the captured browser.
 *
 * It exists because a capture is only useful if the operator did the exact
 * thing the fixture is named after, and remembering "same body text as the
 * baseline, reorder once, delete the draft afterwards" from a terminal window
 * behind the browser does not survive contact with a real session.
 *
 * It adds one `<div>` and nothing else. In particular it does **not** patch
 * `fetch` or `XMLHttpRequest` to count calls: the HAR already has every request,
 * a patched `fetch` is exactly the sort of thing bot detection looks at, and
 * this runs on a live creator account. The live counter is filled in from Node
 * by writing into the element below.
 *
 * It sits bottom-LEFT and collapses. The first version was bottom-right and
 * pinned over Patreon's Settings sidebar — which is where the audience and the
 * adult flag live, so the two fixtures that exist to capture those settings were
 * the two it made impossible. Collapsed state is remembered in sessionStorage so
 * it survives the editor's navigations within one capture.
 */

export const COUNT_ID = 'luma-capture-count'
export const PANEL_ID = 'luma-capture-panel'
export const BODY_ID = 'luma-capture-body'

export interface OverlayData {
  readonly title: string
  readonly varies: string
  readonly steps: readonly string[]
}

interface Element {
  id: string
  innerHTML: string
  hidden: boolean
  style: { cssText: string }
  appendChild(child: unknown): void
  addEventListener(event: string, handler: () => void): void
}

/**
 * Serialised into the page by `addInitScript`, so it can close over nothing.
 * Everything it needs arrives in `data`.
 */
export function installOverlay(
  data: OverlayData & { panelId: string; bodyId: string; countId: string },
): void {
  const page = globalThis as unknown as {
    document: {
      readyState: string
      getElementById(id: string): Element | null
      createElement(tag: string): Element
      body: { appendChild(node: unknown): void } | null
      addEventListener(event: string, handler: () => void): void
    }
    sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  }

  const STORE = 'luma-capture-collapsed'

  const build = (): void => {
    const document = page.document
    if (document.body === null || document.getElementById(data.panelId) !== null) return

    const panel = document.createElement('div')
    panel.id = data.panelId
    panel.style.cssText = [
      'position:fixed',
      // Left, not right: the right is where Patreon keeps Settings, and that is
      // what half the fixtures need to reach.
      'left:16px',
      'bottom:16px',
      'z-index:2147483647',
      'width:320px',
      'max-height:70vh',
      'overflow:auto',
      'background:#141418',
      'color:#e8e8ea',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace',
      'border:1px solid #3a3a44',
      'border-radius:8px',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)',
    ].join(';')

    const header = document.createElement('div')
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:8px',
      'padding:10px 12px',
      'cursor:pointer',
      'user-select:none',
    ].join(';')
    header.innerHTML =
      `<span style="font-weight:700;letter-spacing:.04em">CAPTURING · ${data.title}</span>` +
      `<span style="opacity:.6">hide ▾</span>`

    const body = document.createElement('div')
    body.id = data.bodyId
    body.style.cssText = 'padding:0 12px 12px'
    const steps = data.steps.map((step, at) => `<li style="margin:4px 0">${at + 1}. ${step}</li>`).join('')
    body.innerHTML =
      `<div style="opacity:.7;margin:0 0 8px">${data.varies}</div>` +
      `<ol style="list-style:none;padding:0;margin:0">${steps}</ol>` +
      `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #3a3a44">` +
      `api calls recorded: <b id="${data.countId}">0</b></div>` +
      `<div style="margin-top:6px;color:#ffb4b4">draft only — do not publish</div>`

    const apply = (collapsed: boolean): void => {
      body.hidden = collapsed
      header.innerHTML =
        `<span style="font-weight:700;letter-spacing:.04em">CAPTURING · ${data.title}</span>` +
        `<span style="opacity:.6">${collapsed ? 'show ▴' : 'hide ▾'}</span>`
    }

    let collapsed = page.sessionStorage?.getItem(STORE) === '1'
    header.addEventListener('click', () => {
      collapsed = !collapsed
      apply(collapsed)
      try {
        page.sessionStorage?.setItem(STORE, collapsed ? '1' : '0')
      } catch {
        // Private windows and blocked site data both throw here. Losing the
        // preference is not worth failing a capture over.
      }
    })

    panel.appendChild(header)
    panel.appendChild(body)
    apply(collapsed)
    document.body.appendChild(panel)
  }

  if (page.document.readyState === 'loading') page.document.addEventListener('DOMContentLoaded', build)
  else build()
}
