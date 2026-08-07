import type {
  CharacterCount,
  Folder,
  LibraryStats,
  MediaItem,
  MediaQuery,
  ScanProgress,
  ThrottleLevel,
} from '@luma/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as native from './native.ts'

const PAGE_SIZE = 300

export const DEFAULT_QUERY: MediaQuery = {
  folderId: null,
  kind: null,
  rating: null,
  sexyOnly: false,
  search: '',
  searchPaths: false,
  tag: null,
  minStars: null,
  maxStars: null,
  unstarred: false,
  hasPrompt: null,
  img2img: null,
  extras: null,
  label: null,
  animated: null,
  greyscale: null,
  minLongestEdge: null,
  duplicatesOnly: false,
  modifiedAfter: null,
  modifiedBefore: null,
  // Nothing hidden by default. Documents are the reason this exists, but a
  // grid that silently omits files on first run is a bug report waiting to
  // happen — the "No Docs" pill is one click away.
  hideTags: [],
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

/** Cheap enough to run on a timer, and the fields the status bar actually draws. */
function sameProgress(a: ScanProgress, b: ScanProgress): boolean {
  return (
    a.phase === b.phase &&
    a.done === b.done &&
    a.total === b.total &&
    a.current === b.current &&
    a.folderId === b.folderId &&
    a.errors.length === b.errors.length
  )
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
  const [exclusions, setExclusions] = useState<string[]>([])
  const [characters, setCharacters] = useState<CharacterCount[]>([])

  const [query, setQueryState] = useState<MediaQuery>(DEFAULT_QUERY)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  // The same number, readable without a render. `loadMore` runs in bursts and
  // has to know where the results end without waiting for one.
  const totalRef = useRef(0)
  const [loading, setLoading] = useState(true)

  const dirty = useRef(false)
  // Guards against an out-of-order response overwriting a newer one: a slow
  // query for the previous filter must not clobber the current results.
  const generation = useRef(0)
  /** The query most recently sent, for refreshes that happen outside one. */
  const queryRef = useRef<MediaQuery>(DEFAULT_QUERY)
  // How many rows are on screen right now. A ref rather than reading `items`,
  // so `reload` does not have to be rebuilt — and re-subscribed — on every
  // append.
  const loaded = useRef(0)

  const refreshFolders = useCallback(async () => {
    const [nextFolders, nextStats, nextExclusions, nextCharacters] = await Promise.all([
      native.listFolders(),
      native.libraryStats(),
      native.listExclusions(),
      native.topCharacters({ ...queryRef.current, search: '' }, 30),
    ])
    setFolders(nextFolders)
    setStats(nextStats)
    setExclusions(nextExclusions)
    setCharacters(nextCharacters)
  }, [])

  const runQuery = useCallback(async (next: MediaQuery, append: boolean) => {
    const ticket = ++generation.current
    if (!append) setLoading(true)

    try {
      queryRef.current = next
      const [page, nextCharacters] = await Promise.all([
        native.queryMedia(next),
        // The leaderboard follows the grid's filters — except the search term.
        // Clicking a character IS a search, so a leaderboard narrowed by it
        // would collapse to that one name and there would be no way to hop to
        // another character from the list that just navigated you here.
        native.topCharacters({ ...next, search: '' }, 30),
      ])
      setCharacters(nextCharacters)
      if (ticket !== generation.current) return
      setItems((previous) => {
        const merged = append ? [...previous, ...page.items] : page.items
        loaded.current = merged.length
        return merged
      })
      setTotal(page.total)
      totalRef.current = page.total
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

  /**
   * Append the next page, unless one is already on its way.
   *
   * **One at a time, and not merely as an optimisation.** `runQuery` stamps
   * each call with a generation and drops any response that is no longer the
   * newest — which is what makes a filter change cancel the query it replaced.
   * Two appends in flight together hit that same rule: the first page to return
   * is no longer the newest, so it is discarded, and those rows are simply
   * missing from the grid until something reloads it. The grid now asks
   * whenever the end is in reach, so this is reached in bursts and the guard is
   * what keeps the chain to one page per request.
   */
  const appending = useRef(false)
  const loadMore = useCallback(() => {
    if (appending.current) return
    setQueryState((previous) => {
      // `loaded` rather than `items.length`: a burst of asks arrives faster
      // than the render that would refresh a captured length, and the stale one
      // keeps paging past the end of the results.
      if (loaded.current >= totalRef.current) return previous
      const next = { ...previous, offset: previous.offset + previous.limit }
      appending.current = true
      void runQuery(next, true).finally(() => {
        appending.current = false
      })
      return next
    })
  }, [runQuery])

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

  // Live progress: subscribed to, and also polled.
  //
  // The subscription is the local case — events arrive four times a second and
  // cost nothing. The poll is the remote one: those events are emitted into the
  // webview of the machine doing the work and never cross the wire, so a status
  // bar in a remote session would otherwise sit at "Idle" through a scan of
  // 60,000 files. One snapshot read every two seconds is cheap enough that it is
  // not worth branching on which mode this is.
  useEffect(() => {
    let lastPhase = IDLE_PROGRESS.phase

    const apply = (next: ScanProgress) => {
      // Identity is kept when nothing moved, or an idle poll would re-render the
      // whole app every two seconds for no news.
      setProgress((previous) => (sameProgress(previous, next) ? previous : next))
      // Only while something is actually running. The subscription only fires
      // during a scan, but the poll answers forever, and marking the library
      // dirty on an idle snapshot would have the reconcile timer below
      // re-querying the grid every four seconds for the life of the app.
      if (next.phase !== 'idle' && next.phase !== 'done') dirty.current = true
      // A phase boundary is the one moment worth reconciling immediately: it is
      // when a batch of new rows becomes visible all at once.
      if (next.phase !== lastPhase) {
        lastPhase = next.phase
        dirty.current = false
        reload()
      }
    }

    const unsubscribe = native.onScanProgress(apply)
    const timer = window.setInterval(() => {
      // A failed poll is not worth reporting: the next one is two seconds away,
      // and a lost connection is already announced by everything else failing.
      void native.scanProgress().then(apply, () => {})
    }, 2000)

    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
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
      /**
       * Cap background work. Re-reads the environment rather than assuming it
       * took, so the checkbox reflects what the backend actually did.
       */
      async setThrottle(level: ThrottleLevel) {
        await native.setThrottle(level)
        setEnvironment(await native.environment())
      },
      /**
       * Stop scanning a folder and drop its rows. Returns how many went.
       *
       * Reloads rather than filtering in place: the removal happened in the
       * index, and the grid should show what the index now says.
       */
      /**
       * Search for duplicates, then switch the grid to showing them.
       *
       * The search writes the grouping into the index, so the view is a plain
       * query afterwards — no state to hold and nothing to invalidate.
       */
      async findDuplicates() {
        const report = await native.findDuplicates()
        setQueryState((previous) => {
          // Every narrowing filter is cleared, **including the folder**, because
          // a partial duplicate set is worse than none: two of three copies
          // shown reads as "these two are the duplicates" and invites deleting
          // the wrong one. The folder matters most of all — the usual reason to
          // hold the same picture twice is that it is in two places, so a
          // folder filter hides exactly the copy you are looking for and leaves
          // groups of one behind.
          const next = {
            ...previous,
            duplicatesOnly: report.files > 0,
            folderId: null,
            rating: null,
            kind: null,
            tag: null,
            sexyOnly: false,
            minStars: null,
            maxStars: null,
            unstarred: false,
            offset: 0,
          }
          void runQuery(next, false)
          return next
        })
        return report
      },
      async excludeFolder(path: string) {
        const removed = await native.excludeFolder(path)
        reload()
        return removed
      },
      async includeFolder(path: string) {
        await native.includeFolder(path)
        await refreshFolders()
      },
      async processPending() {
        await native.processPending()
      },
      /**
       * Import star ratings from a Stable Diffusion Image Browser database.
       *
       * Reloads afterwards because ratings that matched already-indexed rows
       * take effect immediately; the rest are staged and attach as their
       * folders are scanned.
       */
      async importRatings() {
        const path = await native.pickImageBrowserDb()
        if (!path) return null
        const summary = await native.importImageBrowserDb(path)
        reload()
        return summary
      },
      async retryFailed(folderId: number | null = null) {
        const cleared = await native.retryFailed(folderId)
        await refreshFolders()
        return cleared
      },
    }),
    [refreshFolders, reload, runQuery],
  )

  return {
    folders,
    exclusions,
    characters,
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
