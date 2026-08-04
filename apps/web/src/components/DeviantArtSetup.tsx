import { Button } from '@luma/ui'
import type { DeviantArtAccount } from '@luma/core'
import { useState } from 'react'
import {
  DEVIANTART_APPS_URL,
  deviantArtConfigure,
  deviantArtConnect,
  deviantArtDisconnect,
  deviantArtSetRedirect,
  openExternal,
} from '#/lib/native.ts'

interface DeviantArtSetupProps {
  account: DeviantArtAccount
  onChange: (account: DeviantArtAccount) => void
}

/**
 * Connecting the app to a DeviantArt account.
 *
 * **No password is asked for anywhere here, and that is the point.** The login
 * happens in the browser, where two-factor auth already works, and what comes
 * back is a token scoped to uploading. Anything that asked for a password in
 * this window would be asking someone to weaken their account to use a
 * feature — and would then have to store it.
 *
 * The redirect URI is shown rather than hidden because it has to be pasted into
 * the application's whitelist on DeviantArt character for character. A mismatch
 * there is the single most likely reason a first connection fails, and it fails
 * silently — the browser lands on an error page and this app just waits.
 */
export function DeviantArtSetup({ account, onChange }: DeviantArtSetupProps) {
  const [clientId, setClientId] = useState(account.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [redirect, setRedirect] = useState(account.redirectUri)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const save = () => {
    setError(null)
    setBusy('Saving…')
    void deviantArtSetRedirect(redirect)
      .then(() => deviantArtConfigure(clientId, clientSecret || null))
      .then(onChange, (reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(null))
  }

  const connect = () => {
    setError(null)
    setBusy('Waiting for the browser…')
    void deviantArtConnect()
      .then(onChange, (reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(null))
  }

  const disconnect = () => {
    setBusy('Disconnecting…')
    void deviantArtDisconnect()
      .then(() => onChange({ ...account, connected: false, username: null, scopes: [], canPublish: false }))
      .finally(() => setBusy(null))
  }

  if (account.connected) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/5 px-4 py-2.5 text-sm">
        <span className="text-zinc-300">
          Connected as <span className="font-medium text-indigo-300">{account.username ?? '—'}</span>
        </span>
        {account.canPublish ? (
          <span className="text-zinc-500" title={`Scopes granted: ${account.scopes.join(', ')}`}>
            can upload and post
          </span>
        ) : (
          // The one failure that is not obvious from anywhere else. An app can
          // be perfectly connected and still unable to post, and finding that
          // out here beats finding it out after twenty uploads.
          <span
            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300"
            title={`Scopes granted: ${account.scopes.join(', ') || 'none'}. Posting needs "publish".`}
          >
            upload only — DeviantArt did not grant the publish scope
          </span>
        )}
        <Button size="sm" className="ml-auto" onClick={disconnect} disabled={busy !== null}>
          {busy ?? 'Disconnect'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 border-b border-white/5 px-4 py-3 text-sm">
      <p className="text-zinc-400">
        Register an application on DeviantArt to get a client id.{' '}
        <button
          type="button"
          onClick={() => void openExternal(DEVIANTART_APPS_URL)}
          className="text-indigo-300 underline decoration-dotted underline-offset-2 hover:text-indigo-100"
        >
          Open the developer page
        </button>
        . Your password never comes near this app — you log in in the browser, with 2FA as
        normal, and DeviantArt hands back a token that can only upload.
      </p>

      <label className="block">
        <span className="mb-1 block text-zinc-500">
          Paste this into the application&apos;s <em>OAuth2 Redirect URI Whitelist</em>, exactly
        </span>
        <span className="flex gap-2">
          <input
            value={redirect}
            onChange={(event) => setRedirect(event.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-400/60"
          />
          <Button
            size="sm"
            onClick={() => {
              // Optional-chained *and* guarded: `clipboard?.writeText()` yields
              // undefined where the API is absent, and `.then` on that throws.
              const written = navigator.clipboard?.writeText(redirect)
              if (!written) return
              void written.then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="min-w-48 flex-1">
          <span className="mb-1 block text-zinc-500">Client ID</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            spellCheck={false}
            placeholder="12345"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-400/60"
          />
        </label>
        <label className="min-w-48 flex-1">
          <span className="mb-1 block text-zinc-500">
            Client Secret <span className="text-zinc-600">— only if registered as confidential</span>
          </span>
          <input
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            type="password"
            spellCheck={false}
            placeholder="leave empty for a public app"
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-indigo-400/60"
          />
        </label>
      </div>

      <p className="text-zinc-500">
        The secret and the token are kept in the Windows Credential Manager, not in the library
        index — that file gets copied around with backups.
      </p>

      {error ? (
        <p className="rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-red-200">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={busy !== null || clientId.trim().length === 0}>
          Save
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={connect}
          disabled={busy !== null || !account.configured}
          title={
            account.configured
              ? 'Opens DeviantArt in your browser to authorize this app'
              : 'Save a client id first'
          }
        >
          {busy ?? 'Connect'}
        </Button>
      </div>
    </div>
  )
}
