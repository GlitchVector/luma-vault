import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fileUrl } from '#/lib/native'

/** Install the global Tauri injects for the duration of one test. */
function withInternals(convertFileSrc: (filePath: string, protocol: string) => string) {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { convertFileSrc },
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

describe('fileUrl', () => {
  it('takes its origin from Tauri rather than assuming the scheme resolves', () => {
    // What Tauri injects on Windows: WebView2 cannot register a custom URI
    // scheme, so custom protocols are served over http://<scheme>.localhost.
    // Hardcoding `luma://` there points every tile at an origin that does not
    // exist, and the whole grid renders as broken images.
    withInternals((filePath, protocol) => `http://${protocol}.localhost/${encodeURIComponent(filePath)}`)

    expect(fileUrl('D:\\vault\\holiday.jpg')).toBe(
      `http://luma.localhost/?path=${encodeURIComponent('D:\\vault\\holiday.jpg')}`,
    )
  })

  it('uses the custom scheme where the webview supports one', () => {
    withInternals((filePath, protocol) => `${protocol}://localhost/${encodeURIComponent(filePath)}`)

    expect(fileUrl('/Users/x/holiday.jpg')).toBe(
      `luma://localhost/?path=${encodeURIComponent('/Users/x/holiday.jpg')}`,
    )
  })

  it('still builds a URL in a plain browser, where Tauri has injected nothing', () => {
    expect(fileUrl('/media/loop.gif')).toBe(
      `luma://localhost/?path=${encodeURIComponent('/media/loop.gif')}`,
    )
  })

  it('encodes a path that would otherwise break out of the query parameter', () => {
    expect(fileUrl('/media/a&b=c?d.jpg')).toBe('luma://localhost/?path=%2Fmedia%2Fa%26b%3Dc%3Fd.jpg')
  })
})

/**
 * Where a call goes, which is the whole of remote mode.
 *
 * Every native call in the app funnels through one function in `native.ts`, and
 * that is the only place that knows whether this machine or another one should
 * answer it. Nothing above it has a remote variant — not a component, not the
 * forty exported wrappers. So these cases are what stand between "browsing the
 * other machine" and "quietly showing this one's library while the status bar
 * claims otherwise", which is a bug nobody notices until they delete something.
 */

const invoke = vi.fn()

/**
 * Stubbed where Tauri itself reads it, rather than by mocking its api package.
 *
 * `invoke` from `@tauri-apps/api/core` is loaded by a dynamic import at call
 * time, and a module mock plus the per-case `resetModules` below race: one case
 * in five got the real module. The injected global is the actual seam — it is
 * what the package calls and what `isTauri()` looks for — so stubbing it cannot
 * be bypassed by whichever copy of the package a case ends up with.
 */
function withTauriInvoke() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {
      convertFileSrc: (filePath: string, protocol: string) => `${protocol}://localhost/${filePath}`,
      // The third argument is Tauri's options bag, which nothing here passes.
      invoke: (command: string, args: Record<string, unknown>) => invoke(command, args),
    },
    configurable: true,
    writable: true,
  })
}

const LOCAL_SESSION = {
  connected: false,
  address: '',
  host: '',
  folders: 0,
  items: 0,
  lastAddress: '192.168.1.42:7870',
  hasPassphrase: true,
}

const LIVE_SESSION = {
  connected: true,
  address: '192.168.1.42:7870',
  host: 'DESKTOP-VAULT',
  folders: 3,
  items: 66412,
  lastAddress: '192.168.1.42:7870',
  hasPassphrase: true,
}

const STATS = { folders: 1, images: 10, videos: 0, classified: 10, pending: 0, sexy: 0, failed: 0 }
const EMPTY_PAGE = { items: [], total: 0, offset: 0 }
const NOT_SHARING = { sharing: false, port: 7870, addresses: [], hasPassphrase: false }

/**
 * A fresh copy of the module per case.
 *
 * The route is cached in module scope deliberately — asking the backend once per
 * call would be an IPC round trip per tile — so a connected case would
 * otherwise decide the answer for every case after it.
 */
async function loadNative() {
  vi.resetModules()
  return import('#/lib/native.ts')
}

function answering(session: typeof LOCAL_SESSION, answers: Record<string, unknown>) {
  invoke.mockImplementation((command: string) => {
    if (command === 'remote_status') return Promise.resolve(session)
    if (command in answers) return Promise.resolve(answers[command])
    return Promise.reject(new Error(`unexpected command ${command}`))
  })
}

const commandsCalled = () => invoke.mock.calls.map(([command]) => command as string)

describe('where a native call goes', () => {
  beforeEach(() => {
    invoke.mockReset()
    withTauriInvoke()
  })

  it('reaches this machine directly when there is no session', async () => {
    answering(LOCAL_SESSION, { library_stats: STATS })
    const native = await loadNative()

    expect(await native.libraryStats()).toEqual(STATS)
    expect(invoke).toHaveBeenCalledWith('library_stats', {})
    expect(commandsCalled()).not.toContain('remote_call')
  })

  it('goes to the peer under the very same name while a session is live', async () => {
    answering(LIVE_SESSION, { remote_call: EMPTY_PAGE })
    const native = await loadNative()

    const query = { limit: 300, offset: 0 } as unknown as Parameters<typeof native.queryMedia>[0]
    expect(await native.queryMedia(query)).toEqual(EMPTY_PAGE)

    // Name and arguments are the local ones, untouched: the peer runs the same
    // operation, so there is nothing to translate at either end.
    expect(invoke).toHaveBeenCalledWith('remote_call', { name: 'query_media', args: { query } })
    expect(commandsCalled()).not.toContain('query_media')
  })

  it('asks where it is only once, however many calls follow', async () => {
    answering(LIVE_SESSION, { remote_call: STATS })
    const native = await loadNative()

    await Promise.all([native.libraryStats(), native.libraryStats(), native.libraryStats()])
    // Three calls, one probe — including when they race, which they do on the
    // first render: folders, the grid and the stats all go out together.
    expect(commandsCalled().filter((command) => command === 'remote_status')).toHaveLength(1)
  })

  it('never wraps the commands that decide where calls go', async () => {
    answering(LIVE_SESSION, { remote_disconnect: LOCAL_SESSION, share_status: NOT_SHARING })
    const native = await loadNative()

    // Asking the peer whether we are connected to it would be circular, and
    // asking it to disconnect us from itself more so.
    await native.remoteDisconnect()
    await native.shareStatus()
    expect(invoke).toHaveBeenCalledWith('remote_disconnect', {})
    expect(invoke).toHaveBeenCalledWith('share_status', {})
    expect(commandsCalled()).not.toContain('remote_call')
  })

  it('keeps the two actions that act on a screen here', async () => {
    answering(LIVE_SESSION, { reveal_item: null, open_external: null })
    const native = await loadNative()

    // A browser tab belongs where the person is. A file-manager window on the
    // machine they are *not* at is worse than the local command's refusal,
    // which at least says which machine the file is on.
    await native.revealInFileManager(String.raw`D:\pics\a.png`)
    await native.openExternal('https://example.com/x')
    expect(invoke).toHaveBeenCalledWith('reveal_item', { path: String.raw`D:\pics\a.png` })
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://example.com/x' })
    expect(commandsCalled()).not.toContain('remote_call')
  })

  it('switches route on connecting, without going back to ask', async () => {
    answering(LOCAL_SESSION, { remote_connect: LIVE_SESSION, remote_call: STATS })
    const native = await loadNative()

    await native.remoteConnect('192.168.1.42', 'open sesame')
    invoke.mockClear()

    await native.libraryStats()
    // The answer it just got IS the route, so there is no second probe and no
    // window in which the page thinks it is remote while calls go local.
    expect(commandsCalled()).toEqual(['remote_call'])
  })

  it('treats a backend that cannot answer as this machine', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'remote_status') return Promise.reject(new Error('no such command'))
      if (command === 'library_stats') return Promise.resolve(STATS)
      return Promise.reject(new Error(`unexpected command ${command}`))
    })
    const native = await loadNative()

    // Guessing "remote" on a failed probe would break every call rather than
    // the one that failed.
    expect(await native.libraryStats()).toEqual(STATS)
  })

  it('keeps one machine’s tiles out of the other machine’s cache', async () => {
    answering(LIVE_SESSION, { remote_call: STATS })
    const native = await loadNative()
    await native.libraryStats()

    // A thumbnail is addressed by a hash of its absolute source path, so two
    // machines with the same folder layout produce the identical URL for
    // different pictures — and these responses are cached as immutable. Without
    // the peer in the URL the grid would show one machine's picture for the
    // other's file, which looks like a wrong thumbnail rather than a cache bug.
    const url = native.fileUrl(String.raw`D:\AI\out\00123.png`)
    expect(url).toContain(`from=${encodeURIComponent('192.168.1.42:7870')}`)
    // The path is still the first parameter, because the backend reads up to the
    // first `&` and nothing else about this URL may change.
    expect(url).toContain(`?path=${encodeURIComponent(String.raw`D:\AI\out\00123.png`)}`)
  })
})
