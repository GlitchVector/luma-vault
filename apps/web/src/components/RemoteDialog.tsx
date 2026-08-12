import { Button } from '@luma/ui'
import { useEffect, useState } from 'react'
import { isHttpSession } from '#/lib/native.ts'
import type { Remote } from '#/lib/useRemote.ts'

interface RemoteDialogProps {
  remote: Remote
  onClose: () => void
}

/**
 * Browsing another machine's library, and lending this one out.
 *
 * Two halves because it takes two machines, and whoever is setting this up for
 * the first time is standing at both of them in turn: the bottom half is what
 * you switch on over there and read the address off, the top half is what you
 * type over here. Putting them in one panel means one thing to find.
 *
 * The passphrase is not optional and not generated. Not optional because the
 * port answers everything on the network otherwise, and a session can delete
 * files; not generated because it has to be carried to the other machine by a
 * person, and a phrase somebody chose is one they can retype without reading it
 * off a screen.
 */
export function RemoteDialog({ remote, onClose }: RemoteDialogProps) {
  const { status, share, busy, error } = remote

  const [address, setAddress] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [sharePassphrase, setSharePassphrase] = useState('')

  // The last address is prefilled once it arrives, which is usually a tick after
  // the panel opens. Not overwritten afterwards, so it cannot take back what
  // somebody has started typing.
  const [prefilled, setPrefilled] = useState(false)
  useEffect(() => {
    if (prefilled || !status?.lastAddress) return
    setPrefilled(true)
    setAddress(status.lastAddress)
  }, [prefilled, status?.lastAddress])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const connected = status?.connected === true
  const remembered = status?.hasPassphrase === true
  // This page *is* the remote end — a phone browsing a host. There is no
  // machine behind it to go back to and no library of its own to lend out, so
  // the share half disappears and disconnecting is a logout.
  const guest = isHttpSession()

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Remote mode"
        className="flex w-full max-w-lg flex-col gap-5 rounded-xl border border-white/10 bg-zinc-900 p-5 text-sm shadow-2xl"
      >
        <section className="flex flex-col gap-2">
          <h2 className="font-medium text-zinc-100">Browse another machine</h2>

          {connected ? (
            <>
              <p className="text-zinc-400">
                Showing{' '}
                <span className="font-medium text-indigo-300">
                  {status?.host || status?.address}
                </span>
                {status?.host ? <span className="text-zinc-500"> ({status.address})</span> : null} —{' '}
                {status?.items.toLocaleString()} files in {status?.folders.toLocaleString()}{' '}
                {status?.folders === 1 ? 'folder' : 'folders'}. Ratings, deletions and upscales all
                happen over there.
              </p>
              <Button
                size="sm"
                className="self-start"
                disabled={busy !== null}
                onClick={remote.disconnect}
              >
                {busy ?? (guest ? 'Log out' : 'Back to this machine')}
              </Button>
            </>
          ) : (
            <>
              <p className="text-zinc-400">
                Type the address the other machine shows below, and the passphrase it is sharing
                with. Local network only.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-40 flex-1">
                  <span className="mb-1 block text-zinc-500">Address</span>
                  <input
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="192.168.1.42"
                    spellCheck={false}
                    aria-label="Address"
                    className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-400/60"
                  />
                </label>
                <label className="min-w-40 flex-1">
                  <span className="mb-1 block text-zinc-500">
                    Passphrase{remembered ? ' — remembered' : ''}
                  </span>
                  <input
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    type="password"
                    placeholder={remembered ? '••••••••' : ''}
                    aria-label="Passphrase"
                    className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-400/60"
                  />
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null || address.trim() === ''}
                  onClick={() => remote.connect(address, passphrase)}
                >
                  {busy ?? 'Connect'}
                </Button>
              </div>
            </>
          )}

          {error ? (
            <p className="rounded-md bg-red-500/10 px-2 py-1.5 text-red-300" role="alert">
              {error}
            </p>
          ) : null}
        </section>

        {guest ? null : (
        <section className="flex flex-col gap-2 border-t border-white/5 pt-4">
          <h2 className="font-medium text-zinc-100">Share this library</h2>
          <p className="text-zinc-400">
            Lets another machine on this network browse everything here — and rate, delete and
            upscale it. Off until you switch it on, and the passphrase is the only thing guarding
            it.
          </p>

          {share?.sharing ? (
            <>
              <p className="text-zinc-300">
                Answering on{' '}
                {share.addresses.length > 0 ? (
                  share.addresses.map((entry) => (
                    <span key={entry} className="font-mono text-indigo-300">
                      {entry}
                    </span>
                  ))
                ) : (
                  // Better than printing a guess: the routing table could not be
                  // asked, so the port is right and the address is not ours to
                  // state.
                  <span className="text-amber-300">
                    port {share.port} — find this machine&apos;s address in your network settings
                  </span>
                )}
              </p>
              <Button
                size="sm"
                className="self-start"
                disabled={busy !== null}
                onClick={() => remote.setSharing(false, null)}
              >
                {busy ?? 'Stop sharing'}
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-1">
                <span className="mb-1 block text-zinc-500">
                  Passphrase{share?.hasPassphrase ? ' — one is set, type to change it' : ''}
                </span>
                <input
                  value={sharePassphrase}
                  onChange={(event) => setSharePassphrase(event.target.value)}
                  type="password"
                  placeholder={share?.hasPassphrase ? '••••••••' : 'something you can type again'}
                  aria-label="Sharing passphrase"
                  className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-400/60"
                />
              </label>
              <Button
                size="sm"
                disabled={
                  busy !== null || (sharePassphrase.trim() === '' && share?.hasPassphrase !== true)
                }
                onClick={() => remote.setSharing(true, sharePassphrase.trim() || null)}
              >
                {busy ?? 'Start sharing'}
              </Button>
            </div>
          )}
        </section>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
