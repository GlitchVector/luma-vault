import { Button } from '@luma/ui'
import { useState } from 'react'
import { httpLogin } from '#/lib/native.ts'

/**
 * The passphrase screen a browser lands on when a sharing host served it this
 * page but holds no session for it yet — a phone, most of the time.
 *
 * A successful login **reloads the page**, the same move connecting makes on
 * the desktop and for the same reason: everything above the native seam
 * describes one library, and the reload swaps all of it at once. The session
 * cookie survives the reload; the redetect finds it and comes up authorized.
 *
 * A form rather than a div with a button so the phone keyboard's "go" key
 * submits — on a screen with no other controls, that is how it will be used.
 */
export function HostLogin() {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (busy || passphrase.trim() === '') return
    setBusy(true)
    setError(null)
    void httpLogin(passphrase).then(
      () => globalThis.location?.reload(),
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setBusy(false)
      },
    )
  }

  return (
    <div className="grid h-dvh place-items-center bg-zinc-950 p-6 text-zinc-200">
      <form
        className="flex w-full max-w-xs flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <h1 className="text-lg font-medium text-zinc-100">Luma Vault</h1>
        <p className="text-sm text-zinc-400">
          This machine shares its library with a passphrase. Type the one it is sharing with.
        </p>
        <input
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          type="password"
          autoFocus
          aria-label="Passphrase"
          // text-base rather than the panel's text-sm: iOS Safari zooms the
          // whole page into any focused input under 16px, and never zooms back.
          className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-base text-zinc-200 outline-none focus:border-indigo-400/60"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || passphrase.trim() === ''}
          className="justify-center"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        {error ? (
          <p className="rounded-md bg-red-500/10 px-2 py-1.5 text-sm text-red-300" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  )
}
