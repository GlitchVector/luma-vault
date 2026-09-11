import type { MediaItem } from '@luma/core'

import { fileUrl } from '#/lib/native.ts'

/**
 * What `shareOriginal` ended up doing, so the caller can word its toast.
 *
 * `shared` — the system share sheet took the file (on iOS that sheet is where
 * "Save Image" lives). `opened` — no file sharing on this browser, so the bare
 * original was opened in a new tab, where a long-press saves it cleanly.
 * `cancelled` — the sheet was dismissed; nothing to say.
 */
export type ShareOutcome = 'shared' | 'opened' | 'cancelled'

/**
 * Hand the original file to the phone's share sheet.
 *
 * A long-press on the lightbox picture is not a reliable way to save it: the
 * `<img>` is sized to the stage and clipped, so iOS previews a half-blank
 * frame and offers to save *that*. The Web Share API with a `File` is the one
 * path that reliably reaches "Save Image" on iOS Safari and the Android share
 * targets — but only with a real File, so the original is fetched as a blob
 * first. Where files cannot be shared (desktop browsers, older Android) the
 * original opens by itself in a new tab, which is the next best thing: a bare
 * image the browser's own long-press handles correctly.
 *
 * The blob's own MIME type wins; the extension is only the fallback for a
 * server that answered without one.
 */
export async function shareOriginal(item: Pick<MediaItem, 'path' | 'name'>): Promise<ShareOutcome> {
  const url = fileUrl(item.path)
  const nav = navigator as Navigator & {
    share?: (data: { files?: File[]; title?: string }) => Promise<void>
    canShare?: (data: { files?: File[] }) => boolean
  }
  if (typeof nav.share === 'function') {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetching the original failed: ${response.status}`)
    const blob = await response.blob()
    const file = new File([blob], item.name, { type: blob.type || mimeFor(item.name) })
    if (nav.canShare?.({ files: [file] }) ?? true) {
      try {
        await nav.share({ files: [file], title: item.name })
        return 'shared'
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return 'cancelled'
        // A share that fails for any other reason (a target that refused the
        // type, say) still leaves the tab fallback, so fall through.
      }
    }
  }
  window.open(url, '_blank', 'noopener')
  return 'opened'
}

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    default:
      return 'application/octet-stream'
  }
}
