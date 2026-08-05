import { afterEach, describe, expect, it } from 'vitest'

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
