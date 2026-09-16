/**
 * Building HARs by hand, for the tests.
 *
 * Test-only, but it lives in `src` rather than beside one test file because
 * three suites need it and a HAR assembled slightly differently in each of them
 * would make their disagreements meaningless.
 *
 * Nothing here has ever been near patreon.com: these are synthetic captures,
 * which is exactly why the pure half of the harness can be finished and trusted
 * before anyone opens a browser.
 */

export interface FakeCall {
  readonly method?: string
  readonly url: string
  readonly status?: number
  readonly request?: unknown
  readonly response?: unknown
  readonly requestHeaders?: Record<string, string>
  readonly responseHeaders?: Record<string, string>
  readonly cookies?: Record<string, string>
  readonly mimeType?: string
}

export function makeHar(calls: readonly FakeCall[]): string {
  return JSON.stringify({
    log: {
      version: '1.2',
      entries: calls.map((call) => ({
        startedDateTime: '2026-09-10T10:00:00.000Z',
        request: {
          method: call.method ?? 'GET',
          url: call.url,
          headers: Object.entries(call.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
          cookies: Object.entries(call.cookies ?? {}).map(([name, value]) => ({ name, value })),
          queryString: [...new URL(call.url).searchParams].map(([name, value]) => ({ name, value })),
          ...(call.request === undefined
            ? {}
            : {
                postData: { mimeType: 'application/vnd.api+json', text: JSON.stringify(call.request) },
              }),
        },
        response: {
          status: call.status ?? 200,
          headers: Object.entries(call.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
          cookies: [],
          content: {
            mimeType: call.mimeType ?? 'application/vnd.api+json',
            ...(call.response === undefined ? {} : { text: JSON.stringify(call.response) }),
          },
        },
      })),
    },
  })
}
