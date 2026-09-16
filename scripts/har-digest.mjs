#!/usr/bin/env node
/**
 * Digest a browser HAR capture of patreon.com into the request sequence the
 * page actually made, so the backend can replay it.
 *
 * Reads the HAR, keeps every request to an API-looking origin, and prints one
 * block per request: method, URL, the headers that carry authentication or
 * anti-CSRF state (values redacted unless --secrets), the JSON request body,
 * and the JSON response with long strings shortened. Static assets, analytics
 * and images are dropped — they are most of a HAR and none of the protocol.
 *
 *   node scripts/har-digest.mjs capture.har [--host patreon.com] [--secrets] [--out digest.md]
 */

import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--'))
if (!file) {
  console.error('usage: node scripts/har-digest.mjs capture.har [--host patreon.com] [--secrets] [--out digest.md]')
  process.exit(2)
}
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const host = option('--host') ?? 'patreon.com'
const showSecrets = args.includes('--secrets')
const out = option('--out')

/** Headers worth showing: auth, anti-CSRF, content negotiation. */
const INTERESTING_HEADERS = /^(cookie|set-cookie|x-csrf-signature|x-csrf-token|x-xsrf-token|authorization|content-type|accept|x-requested-with|x-.*)$/i
/** Header values that are credentials. Shown as their length unless --secrets. */
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|x-csrf-signature|x-csrf-token|x-xsrf-token)$/i
/** Noise: everything that is not the protocol. */
const NOISE = /\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ico|mp4|webm|map)(\?|$)|google|facebook|doubleclick|segment|sentry|datadog|amplitude|braze|cloudfront.*\.(png|jpg)|fonts\./i

const har = JSON.parse(readFileSync(file, 'utf8'))
const entries = har.log?.entries ?? []

function shorten(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 120)}… (${value.length} chars)` : value
  }
  if (Array.isArray(value)) {
    if (depth > 6) return `[array of ${value.length}]`
    return value.length > 12
      ? [...value.slice(0, 12).map((entry) => shorten(entry, depth + 1)), `… ${value.length - 12} more`]
      : value.map((entry) => shorten(entry, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (depth > 6) return '{…}'
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry, depth + 1)]))
  }
  return value
}

function body(text, mime) {
  if (!text) return null
  if (/json/i.test(mime ?? '')) {
    try {
      return JSON.stringify(shorten(JSON.parse(text)), null, 2)
    } catch {
      return text.slice(0, 2000)
    }
  }
  if (/x-www-form-urlencoded/i.test(mime ?? '')) {
    return [...new URLSearchParams(text)].map(([key, value]) => `${key}=${shorten(value)}`).join('\n')
  }
  if (/multipart/i.test(mime ?? '')) {
    // The part headers are the protocol; the file bytes are not.
    return text
      .split('\n')
      .filter((line) => /^--|content-disposition|content-type/i.test(line))
      .slice(0, 40)
      .join('\n')
  }
  return text.length > 400 ? `${text.slice(0, 400)}… (${text.length} chars)` : text
}

const lines = []
let index = 0
for (const entry of entries) {
  const { request, response } = entry
  if (!request.url.includes(host) && !/amazonaws|s3\.|cloudfront/i.test(request.url)) continue
  if (NOISE.test(request.url)) continue
  index += 1
  lines.push(`## ${index}. ${request.method} ${request.url}`)
  lines.push(`started ${entry.startedDateTime}  →  HTTP ${response.status} ${response.statusText}  (${entry.time | 0} ms)`)

  const headers = request.headers.filter((header) => INTERESTING_HEADERS.test(header.name))
  if (headers.length > 0) {
    lines.push('', 'request headers:')
    for (const header of headers) {
      const secret = SECRET_HEADERS.test(header.name) && !showSecrets
      if (secret && /^cookie$/i.test(header.name)) {
        const names = header.value.split(';').map((pair) => pair.trim().split('=')[0]).filter(Boolean)
        lines.push(`  ${header.name}: [${names.join(', ')}]`)
      } else {
        lines.push(`  ${header.name}: ${secret ? `<${header.value.length} chars>` : header.value}`)
      }
    }
  }
  const requestBody = body(request.postData?.text, request.postData?.mimeType)
  if (requestBody) lines.push('', 'request body:', requestBody)

  const responseHeaders = response.headers.filter((header) => INTERESTING_HEADERS.test(header.name))
  if (responseHeaders.length > 0) {
    lines.push('', 'response headers:')
    for (const header of responseHeaders) {
      const secret = SECRET_HEADERS.test(header.name) && !showSecrets
      lines.push(`  ${header.name}: ${secret ? `<${header.value.length} chars>` : header.value}`)
    }
  }
  const responseBody = body(response.content?.text, response.content?.mimeType)
  if (responseBody) lines.push('', 'response body:', responseBody)
  lines.push('')
}

const digest = `# ${file}\n${index} requests to ${host}\n\n${lines.join('\n')}`
if (out) {
  writeFileSync(out, digest)
  console.log(`wrote ${out} (${index} requests)`)
} else {
  console.log(digest)
}
