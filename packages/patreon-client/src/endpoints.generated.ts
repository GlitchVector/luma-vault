/**
 * GENERATED FILE — do not hand-edit the values.
 *
 * Written by packages/harness generate from: image-1-2026-09-10T15-18-51-996Z.scrubbed.har, cleanup-2026-09-10T15-05-29-811Z.scrubbed.har, text-only-2026-09-10T15-09-53-417Z.scrubbed.har
 * At: 2026-09-10T15:31:22.815Z
 *
 * Regenerate from a fresh capture rather than patching this by hand. A value
 * edited here is a value with no capture behind it, which is the failure mode
 * the whole project is arranged to avoid.
 */

export const CAPTURED_FROM: string | null = "image-1-2026-09-10T15-18-51-996Z.scrubbed.har, cleanup-2026-09-10T15-05-29-811Z.scrubbed.har, text-only-2026-09-10T15-09-53-417Z.scrubbed.har"

export interface Endpoint {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly fixture: string
}

export interface CsrfTicket {
  readonly path: string
  readonly field: string
  readonly header: string
}

export const CSRF: CsrfTicket | null = {"path":"/REST/auth/CSRFTicket","field":"token","header":"x-csrf-signature"}

export const MEDIA_CREATE: Endpoint | null = {
  method: "POST",
  path: "/api/media",
  fixture: "image-1",
}

export const MEDIA_GET: Endpoint | null = {
  method: "GET",
  path: "/api/media/{id}",
  fixture: "image-1",
}

export const POST_CREATE: Endpoint | null = {
  method: "GET",
  path: "/posts/new",
  fixture: "image-1",
}

export const POST_UPDATE: Endpoint | null = {
  method: "PATCH",
  path: "/api/posts/{id}",
  fixture: "image-1",
}

export const POST_DELETE: Endpoint | null = {
  method: "POST",
  path: "/api/posts/bulk/delete",
  fixture: "cleanup",
}
