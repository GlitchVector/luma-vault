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

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface StorageState {
  cookies?: { name?: string; value?: string; domain?: string }[]
}

export interface ProbeResult {
  readonly status: number
  readonly looksLikeJson: boolean
  readonly challenged: boolean
  readonly server: string | null
  readonly bodyHead: string
}

/** Rebuild a Cookie header from what the headed login dumped. */
export async function cookieHeader(statePath: string): Promise<string> {
  let text: string
  try {
    text = await readFile(resolve(statePath), 'utf8')
  } catch {
    // Named so the CLI prints it as a sentence rather than a stack trace.
    const missing = new Error(
      `no saved session at ${statePath}.
Run \`pnpm patreon auth\` first — it opens a browser for you to sign in once.`,
    )
    missing.name = 'SessionError'
    throw missing
  }
  const state = JSON.parse(text) as StorageState
  const jar = (state.cookies ?? []).filter((cookie) =>
    (cookie.domain ?? '').includes('patreon.com'),
  )
  if (jar.length === 0) {
    const empty = new Error(`${statePath} holds no patreon.com cookies — run: pnpm patreon auth`)
    empty.name = 'SessionError'
    throw empty
  }
  return jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
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
  const response = await fetch(url, {
    headers: {
      cookie: await cookieHeader(statePath),
      accept: 'application/vnd.api+json',
      // A plain, honest Node request. Spoofing a Chrome user-agent would make
      // the answer meaningless: the question is whether the *fingerprint*
      // matters, and a borrowed UA string does not change one.
      'user-agent': 'luma-vault-probe',
    },
  })
  return readProbe(response.status, response.headers.get('server'), await response.text())
}
