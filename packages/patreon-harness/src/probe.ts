#!/usr/bin/env node
/**
 * Does Patreon actually need a real browser, or would plain Node do?
 *
 *     pnpm patreon probe
 *
 * The whole client routes its calls through `page.evaluate` inside a logged-in
 * Chrome, on the brief's claim that a Node client has a different TLS and
 * HTTP/2 fingerprint and gets challenged by Cloudflare even with correct
 * cookies. That claim was never tested here. It is inherited, plausible, and
 * load-bearing for the entire architecture — which is a bad combination.
 *
 * So: take the cookies an operator already produced with `patreon auth`, make
 * one ordinary GET from Node, and look at what comes back.
 *
 *   200 + JSON   the fingerprint claim is wrong for this account, and Chrome
 *                could be dropped from the desktop path entirely
 *   403 / HTML   challenged, exactly as the brief said, and the page-evaluate
 *                design is justified
 *   401          the stored session has expired — run `patreon auth` again;
 *                this says nothing either way about fingerprinting
 *
 * One GET, to an endpoint the editor calls on every page load. It reads and
 * changes nothing.
 */

export interface ProbeResult {
  readonly status: number
  readonly looksLikeJson: boolean
  readonly challenged: boolean
  readonly server: string | null
  readonly bodyHead: string
}

/**
 * Cloudflare's challenge is an HTML page with a 403, not a JSON error.
 * Telling them apart is the entire point of the probe.
 */
export function readProbe(status: number, server: string | null, body: string): ProbeResult {
  const trimmed = body.trimStart()
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  return {
    status,
    looksLikeJson,
    challenged:
      !looksLikeJson &&
      (status === 403 ||
        /just a moment|cf-browser-verification|challenge-platform|enable javascript/i.test(body)),
    server,
    bodyHead: trimmed.slice(0, 200),
  }
}

export async function probe(statePath: string, url: string): Promise<ProbeResult> {
  // Through the real transport, with the real identity. An earlier version sent
  // its own `luma-vault-probe` user-agent, which made it a test of something the
  // client never does — and it reported a challenge the client would not have
  // hit, and would have hidden one it did.
  const { identityFrom, cookieTransport } = await import('@luma/patreon-client')
  const transport = cookieTransport(await identityFrom(statePath))
  const response = await transport.send({
    url,
    method: 'GET',
    headers: { accept: url.includes('/api/') ? 'application/vnd.api+json' : 'text/html' },
    bodyText: null,
  })
  return readProbe(response.status, response.headers['server'] ?? null, response.text)
}
