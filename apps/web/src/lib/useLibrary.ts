import type { Folder, LibraryStats, MediaItem, MediaQuery, ScanProgress } from '@luma/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as native from './native.ts'

const PAGE_SIZE = 300

export const DEFAULT_QUERY: MediaQuery = {
  folderId: null,
  kind: null,
  rating: null,
  sexyOnly: false,
  search: '',
  sort: 'recent',
  limit: PAGE_SIZE,
  offset: 0,
}

const IDLE_PROGRESS: ScanProgress = {
  phase: 'idle',
  folderId: null,
  done: 0,
  total: 0,
  current: null,
  errors: [],
}

/**
 * Everything the main view needs, in one hook.
 *
 * The interesting part is how a running scan interacts with the grid. Progress
 * events arrive many times a second, and re-querying on each one would keep the
 * grid in permanent churn. Instead the scan only ever *marks* the library
 * dirty; a timer reconciles at most once every few seconds, and phase changes
 * reconcile immediately. Watching a scan therefore feels live without the list
 * reshuffling under the cursor.
 */
export function useLibrary() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [progress, setProgress] = useState<ScanProgress>(IDLE_PROGRESS)
  const [environment, setEnvironment] = useState<native.Environment | null>(null)

  const [query, setQueryState] = useState<MediaQuery>(DEFAULT_QUERY)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const dirty = useRef(false)
  // Guards against an out-of-order response overwriting a newer one: a slow
  // query for the previous filter must not clobber the current results.
  const generation = useRef(0)
  // How many rows are on screen right now. A ref rather than reading `items`,
  // so `reload` does not have to be rebuilt — and re-subscribed — on every
  // append.
  const loaded = useRef(0)

  const refreshFolders = useCallback(async () => {
    const [nextFolders, nextStats] = await Promise.all([native.listFolders(), native.libraryStats()])
    setFolders(nextFolders)
    setStats(nextStats)
  }, [])

  const runQuery = useCallback(async (next: MediaQuery, append: boolean) => {
    const ticket = ++generation.current
    if (!append) setLoading(true)

    try {
      const page = await native.queryMedia(next)
      if (ticket !== generation.current) return
      setItems((previous) => {
        const merged = append ? [...previous, ...page.items] : page.items
        loaded.current = merged.length
        return merged
      })
      setTotal(page.total)
    } catch (error) {
      if (ticket === generation.current) {
        console.error('query failed', error)
        if (!append) {
          setItems([])
          loaded.current = 0
        }
      }
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [])

  const setQuery = useCallback(
    (patch: Partial<MediaQuery>) => {
      setQueryState((previous) => {
        // Any filter change resets paging; keeping the old offset would open
        // the new result set somewhere in its middle.
        const next = { ...previous, ...patch, offset: 0 }
        void runQuery(next, false)
        return next
      })
    },
    [runQuery],
  )

  const loadMore = useCallback(() => {
    setQueryState((previous) => {
      if (items.length >= total) return previous
      const next = { ...previous, offset: previous.offset + previous.limit }
      void runQuery(next, true)
      return next
    })
  }, [items.length, total, runQuery])

  /**
   * Re-fetch what is currently on screen.
   *
   * Deliberately *not* "go back to page one". A scan publishes progress four
   * times a second, so this runs every few seconds while one is going; if it
   * truncated the grid to a single page, every tile below the fold would
   * unmount, the end-of-list sentinel would immediately re-fire, and the grid
   * would re-append page by page — remounting tiles whose `inView` starts
   * `false` and painting them as empty boxes for as long as the scan lasts.
   *
   * Refetching the whole loaded window in one query keeps the DOM stable: the
   * tiles are replaced in place, so nothing unmounts and nothing blanks.
   */
  const reload = useCallback(() => {
    setQueryState((previous) => {
      const window = Math.max(previous.limit, loaded.current)
      void runQuery({ ...previous, offset: 0, limit: window }, false)
      // Leave `offset` where the next append should continue from, which is the
      // end of the window just re-fetched — not the end of one page.
      return { ...previous, offset: Math.max(0, window - previous.limit) }
    })
    void refreshFolders()
  }, [runQuery, refreshFolders])

  // Initial load.
  useEffect(() => {
    void refreshFolders()
    void runQuery(DEFAULT_QUERY, false)
    void native.environment().then(setEnvironment)
    void native.scanProgress().then(setProgress)
  }, [refreshFolders, runQuery])

  // Live progress.
  useEffect(() => {
    let lastPhase = IDLE_PROGRESS.phase
    const unsubscribe = native.onScanProgress((next) => {
      setProgress(next)
      dirty.current = true
      // A phase boundary is the one moment worth reconciling immediately: it is
      // when a batch of new rows becomes visible all at once.
      if (next.phase !== lastPhase) {
        lastPhase = next.phase
        dirty.current = false
        reload()
      }
    })
    return unsubscribe
  }, [reload])

  // Reconcile at a human pace while a scan runs.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!dirty.current) return
      dirty.current = false
      reload()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [reload])

  const actions = useMemo(
    () => ({
      async addFolder() {
        const path = await native.pickFolder()
        if (!path) return
        try {
          await native.addFolder(path)
          await refreshFolders()
        } catch (error) {
          console.error('cannot add folder', error)
          throw error
        }
      },
      async removeFolder(id: number) {
        await native.removeFolder(id)
        await refreshFolders()
        reload()
      },
      async rescanFolder(id: number) {
        await native.rescanFolder(id)
      },
      async processPending() {
        await native.processPending()
      },
      async retryFailed(folderId: number | null = null) {
        const cleared = await native.retryFailed(folderId)
        await refreshFolders()
        return cleared
      },
    }),
    [refreshFolders, reload],
  )

  return {
    folders,
    stats,
    progress,
    environment,
    query,
    setQuery,
    items,
    total,
    loading,
    loadMore,
    reload,
    actions,
    hasMore: items.length < total,
  }
}
