import type { RemoteStatus, ShareStatus } from '@luma/core'
import { useCallback, useEffect, useState } from 'react'
import * as native from './native.ts'

export interface Remote {
  /** Null until the first read comes back. */
  status: RemoteStatus | null
  share: ShareStatus | null
  /** What is in flight, for a button that should say so. */
  busy: string | null
  error: string | null
  connect: (address: string, passphrase: string) => void
  disconnect: () => void
  setSharing: (enabled: boolean, passphrase: string | null) => void
  clearError: () => void
}

/**
 * Which library this window is showing, and whether it lends its own out.
 *
 * Connecting and disconnecting **reload the page**, deliberately. Every piece of
 * state above this hook — folders, the grid, its paging, the timeline's buckets,
 * the character leaderboard, the progress subscription — describes one library,
 * and a session swaps all of it at once. Reconciling each part would be a long
 * list of things to get right and a longer list of ways to end up showing two
 * libraries mixed together; a reload is one line and cannot be half-done. In a
 * webview it costs a few hundred milliseconds, and the backend keeps the
 * session, so the page comes back already pointed at the other machine.
 */
export function useRemote(): Remote {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [share, setShare] = useState<ShareStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [nextStatus, nextShare] = await Promise.all([native.remoteStatus(), native.shareStatus()])
    setStatus(nextStatus)
    setShare(nextShare)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connect = useCallback((address: string, passphrase: string) => {
    setError(null)
    setBusy('Connecting…')
    void native.remoteConnect(address, passphrase).then(
      () => globalThis.location?.reload(),
      (reason: unknown) => {
        setError(String(reason))
        setBusy(null)
      },
    )
  }, [])

  const disconnect = useCallback(() => {
    setError(null)
    setBusy('Disconnecting…')
    void native.remoteDisconnect().then(
      () => globalThis.location?.reload(),
      (reason: unknown) => {
        setError(String(reason))
        setBusy(null)
      },
    )
  }, [])

  const setSharing = useCallback(
    (enabled: boolean, passphrase: string | null) => {
      setError(null)
      setBusy(enabled ? 'Starting…' : 'Stopping…')
      void native.setShare(enabled, passphrase).then(
        (next) => {
          setShare(next)
          setBusy(null)
        },
        (reason: unknown) => {
          setError(String(reason))
          setBusy(null)
        },
      )
    },
    [],
  )

  return {
    status,
    share,
    busy,
    error,
    connect,
    disconnect,
    setSharing,
    clearError: useCallback(() => setError(null), []),
  }
}
