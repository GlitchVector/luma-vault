import { useEffect } from 'react'

/**
 * One picture at full size, over whatever page opened it.
 *
 * It exists because the obvious markup does the wrong thing here: an
 * `<a href>` to a `luma://` file NAVIGATES the webview to the image, and the
 * shell has no back button, so the app was simply gone until it was
 * restarted. Nothing in the app links straight at a file any more.
 *
 * Deliberately smaller than the library's Lightbox: no stars, no neighbours,
 * no actions - a comic page, a training image or a LoRA's render is looked at
 * and closed, and none of them is a row in the index.
 */
export function Viewer({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="presentation"
      data-testid="viewer-backdrop"
      // Only a click on the backdrop itself closes, so the picture needs no
      // handler of its own and stays an ordinary image to a screen reader.
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
    >
      <img src={src} alt={caption} className="min-h-0 max-w-full flex-1 object-contain" />
      <p className="text-xs text-zinc-400">
        {caption}
        <span className="ml-3 text-zinc-600">Esc, or click outside, to close</span>
      </p>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/20"
      >
        Close
      </button>
    </div>
  )
}
