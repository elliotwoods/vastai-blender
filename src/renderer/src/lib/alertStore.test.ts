import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertRecord, EventChannel } from '../../../shared/ipc'
import type { AlertEvent } from '../../../shared/models'
import {
  bannerOrder,
  MAX_ALERTS,
  OnScreen,
  REPLAY_TOAST_MS,
  RESURFACE_MS,
  SETTLE_MS,
  toastMs,
  useAlertStore,
  type AlertItem
} from './alertStore'

const T0 = 1_750_000_000_000

const scaleUp: AlertEvent = { level: 'warn', message: 'scale-up failed: no matching offers' }
const destroyFailed: AlertEvent = {
  level: 'error',
  message: 'Destroy failed for instance 123 — check the Vast.ai console!'
}
const foreign: AlertEvent = {
  level: 'warn',
  message:
    'instance 9 (vastai-blender x) was not rented by this profile — left running; destroy it from its own app or the Vast.ai console if it is stray'
}
const orphan: AlertEvent = {
  level: 'error',
  message: 'orphan destroy failed for 42: HTTP 500 — check the Vast.ai console!'
}
/** Distinct errors by the hundred: a dead node failing dispatch for every pending chunk. */
const dispatchFailed = (i: number): AlertEvent => ({
  level: 'error',
  message: `dispatch c${i}-r1 failed: ssh: connection lost`
})

function record(e: AlertEvent, over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: 1,
    key: `${e.level}:${e.message}`,
    level: e.level,
    message: e.message,
    ts: T0,
    lastSeen: T0,
    count: 1,
    dismissedAt: null,
    ...over
  }
}

const store = (): ReturnType<typeof useAlertStore.getState> => useAlertStore.getState()
const items = (): AlertItem[] => store().items
const onScreen = (): string[] => items().flatMap((a) => (a.dismissedAt === null ? [a.message] : []))

beforeEach(() => useAlertStore.setState({ items: [] }))

describe('alertStore: append and de-duplicate', () => {
  it('an identical alert counts up on one entry instead of adding another', () => {
    expect(store().receive(scaleUp, T0)).toBe(true)
    for (let i = 1; i <= 20; i++) expect(store().receive(scaleUp, T0 + i * 15_000)).toBe(false)

    expect(items()).toHaveLength(1)
    expect(items()[0]).toMatchObject({
      message: scaleUp.message,
      count: 21,
      firstSeen: T0,
      lastSeen: T0 + 300_000
    })
  })

  it('keeps alerts apart that differ in message or level, and orders by last seen', () => {
    const other: AlertEvent = {
      ...destroyFailed,
      message: destroyFailed.message.replace('123', '456')
    }
    store().receive(destroyFailed, T0)
    store().receive(other, T0 + 1)
    store().receive({ ...destroyFailed, level: 'warn' }, T0 + 2)
    store().receive(destroyFailed, T0 + 3)

    expect(items().map((a) => [a.level, a.message, a.count])).toEqual([
      ['error', other.message, 1],
      ['warn', destroyFailed.message, 1],
      ['error', destroyFailed.message, 2]
    ])
  })

  it('errors and billing risks are sticky; the rest are toasts', () => {
    store().receive(scaleUp, T0)
    store().receive(destroyFailed, T0)
    store().receive(foreign, T0)
    store().receive(orphan, T0)
    store().receive({ level: 'error', message: 'dispatch c1 failed: boom' }, T0)
    // The sweep announcing a destroy it has not tried yet is not a risk: its
    // failure has its own alert (orphan, above).
    store().receive({ level: 'warn', message: 'destroying orphaned instance 7 (x)' }, T0)

    expect(items().map((a) => [a.sticky, a.billingRisk])).toEqual([
      [false, false],
      [true, true],
      [true, true],
      [true, true],
      [true, false],
      [false, false]
    ])
  })

  it('a toast times out; a sticky alert never does', () => {
    store().receive(scaleUp, T0)
    store().receive(destroyFailed, T0)

    store().expireToasts(T0 + toastMs('warn') - 1)
    expect(onScreen()).toEqual([scaleUp.message, destroyFailed.message])
    store().expireToasts(T0 + toastMs('warn'))
    expect(onScreen()).toEqual([destroyFailed.message])
    store().expireToasts(T0 + 24 * 3_600_000)
    expect(onScreen()).toEqual([destroyFailed.message])
  })

  it('a dismissed alert that fires again comes back, but not within the quiet period', () => {
    const failed = dispatchFailed(1)
    store().receive(failed, T0)
    store().dismiss([items()[0].key], T0 + 1_000)
    expect(onScreen()).toEqual([])

    expect(store().receive(failed, T0 + 1_000 + RESURFACE_MS - 1)).toBe(false)
    expect(onScreen()).toEqual([])
    expect(items()[0].count).toBe(2)

    expect(store().receive(failed, T0 + 1_000 + RESURFACE_MS)).toBe(true)
    expect(onScreen()).toEqual([failed.message])
    expect(items()[0]).toMatchObject({ count: 3, surfacedAt: T0 + 1_000 + RESURFACE_MS })
  })

  it('a billing risk that fires again after its dismissal is back at once: no quiet period', () => {
    // A Vast outage: the destroy failed, the user dismissed the row, and
    // pressed Fleet's "clear failed". The retry failed a minute later.
    store().receive(destroyFailed, T0)
    store().dismiss([items()[0].key], T0 + 1_000)
    expect(onScreen()).toEqual([])

    expect(store().receive(destroyFailed, T0 + 61_000)).toBe(true)
    expect(bannerOrder(items()).map((a) => a.message)).toEqual([destroyFailed.message])
    expect(items()[0]).toMatchObject({ count: 2, surfacedAt: T0 + 61_000, dismissedAt: null })
  })

  it('scale-up failing every 15 s toasts once per quiet period, not every 15 s', () => {
    let toasts = 0
    for (let t = T0; t < T0 + 20 * 60_000; t += 15_000) {
      store().expireToasts(t)
      if (store().receive(scaleUp, t)) toasts++
    }
    // 20 minutes of 80 failures: the first, then one after each quiet period
    // (measured from when the previous toast ran out).
    expect(toasts).toBe(4)
    expect(items()).toHaveLength(1)
    expect(items()[0].count).toBe(80)
  })

  it(`is bounded at ${MAX_ALERTS}, and never evicts a sticky alert still on screen for a toast`, () => {
    store().receive(destroyFailed, T0)
    for (let i = 0; i < MAX_ALERTS + 50; i++) {
      store().receive({ level: 'warn', message: `download failed (frames/${i}.png)` }, T0 + 1 + i)
    }
    expect(items()).toHaveLength(MAX_ALERTS)
    expect(items()[0].message).toBe(destroyFailed.message)
    expect(items()[1].message).toBe('download failed (frames/51.png)')
    expect(items()[MAX_ALERTS - 1].message).toBe(`download failed (frames/${MAX_ALERTS + 49}.png)`)
  })

  it('a billing risk outlasts any number of distinct errors; the oldest errors go first', () => {
    store().receive(orphan, T0)
    for (let i = 0; i <= MAX_ALERTS; i++) store().receive(dispatchFailed(i), T0 + 1 + i)

    expect(items()).toHaveLength(MAX_ALERTS)
    expect(items()[0].message).toBe(orphan.message)
    expect(items()[1].message).toBe(dispatchFailed(2).message)
    expect(bannerOrder(items())[0].message).toBe(orphan.message)
  })

  it('what is off the banner goes before an error still on it', () => {
    store().receive(dispatchFailed(0), T0)
    store().receive(destroyFailed, T0 + 1)
    store().dismiss([items()[1].key], T0 + 2) // dismissed: off the banner
    for (let i = 1; i < MAX_ALERTS; i++) store().receive(dispatchFailed(i), T0 + 2 + i)

    expect(items()).toHaveLength(MAX_ALERTS)
    expect(items()[0].message).toBe(dispatchFailed(0).message)
    expect(items().some((a) => a.message === destroyFailed.message)).toBe(false)
  })
})

describe('alertStore: banner order', () => {
  it('billing risks first, then errors; newest first within each; nothing dismissed or toast', () => {
    store().receive(orphan, T0)
    store().receive(dispatchFailed(1), T0 + 1)
    store().receive(scaleUp, T0 + 2)
    store().receive(destroyFailed, T0 + 3)
    store().receive(dispatchFailed(2), T0 + 4)
    store().receive(dispatchFailed(3), T0 + 5)
    store().receive(foreign, T0 + 6)
    store().receive(dispatchFailed(4), T0 + 7)
    store().dismiss([items().find((a) => a.message === dispatchFailed(4).message)!.key], T0 + 8)

    expect(bannerOrder(items()).map((a) => a.message)).toEqual([
      foreign.message,
      destroyFailed.message,
      orphan.message,
      dispatchFailed(3).message,
      dispatchFailed(2).message,
      dispatchFailed(1).message
    ])
  })
})

describe('alertStore: seed from alerts:recent', () => {
  it('shows every sticky alert however old, and only recent toasts', () => {
    const now = T0 + 3_600_000
    store().seed(
      [
        record(destroyFailed, { lastSeen: T0, count: 2 }),
        record(scaleUp, { id: 2, lastSeen: now - REPLAY_TOAST_MS }),
        record({ level: 'info', message: 'Node RTX 4090 ready' }, { id: 3, lastSeen: now - 2_000 })
      ],
      now
    )
    expect(items().map((a) => [a.message, a.count])).toEqual([
      [destroyFailed.message, 2],
      [scaleUp.message, 1],
      ['Node RTX 4090 ready', 1]
    ])
    expect(onScreen()).toEqual([destroyFailed.message, 'Node RTX 4090 ready'])

    // The old toast was never shown, so when it fires again it comes straight
    // back rather than waiting out a quiet period.
    expect(store().receive(scaleUp, now + 1)).toBe(true)
    expect(onScreen()).toContain(scaleUp.message)
  })

  it('counts an alert once when its push raced the replay, and a second seed changes nothing', () => {
    // The push arrived before the alerts:recent reply, and main's buffer
    // counted it too.
    store().receive(destroyFailed, T0 + 5)
    const replay = [record(destroyFailed, { count: 3, ts: T0, lastSeen: T0 + 5 })]
    store().seed(replay, T0 + 10)
    expect(items()).toHaveLength(1)
    expect(items()[0]).toMatchObject({ count: 3, firstSeen: T0, lastSeen: T0 + 5 })

    const before = items()
    store().seed(replay, T0 + 20)
    expect(items()).toEqual(before)
  })

  it('keeps what the user dismissed', () => {
    store().receive(destroyFailed, T0)
    store().dismiss([items()[0].key], T0 + 1)
    store().seed([record(destroyFailed)], T0 + 2)
    expect(onScreen()).toEqual([])
  })

  it('keeps a dismissal from an earlier window when a push raced the replay', () => {
    // Dismissed in the window before this one. It fires again just as this
    // one mounts, and the push lands before the alerts:recent reply, whose
    // record (counting that push) says it is still quiet.
    const failed = dispatchFailed(1)
    expect(store().receive(failed, T0 + 60_000)).toBe(true)
    store().seed(
      [record(failed, { count: 2, dismissedAt: T0, lastSeen: T0 + 60_000 })],
      T0 + 60_010
    )
    expect(onScreen()).toEqual([])
    expect(items()[0]).toMatchObject({ count: 2, dismissedAt: T0 })

    // And it comes back when it would have in that window.
    expect(store().receive(failed, T0 + RESURFACE_MS)).toBe(true)
    expect(onScreen()).toEqual([failed.message])
  })

  it('keeps what the user dismissed in an earlier window, until it comes back', () => {
    const now = T0 + 3_600_000
    store().seed(
      [
        // Dismissed, and it has not fired since.
        record(dispatchFailed(1), { dismissedAt: T0 + 10 }),
        // Fired again within the quiet period: still dismissed.
        record(dispatchFailed(2), { id: 2, dismissedAt: T0, lastSeen: T0 + RESURFACE_MS - 1 }),
        // Fired again after it: back, as it would have come back in that window.
        record(destroyFailed, { id: 3, dismissedAt: T0, lastSeen: T0 + RESURFACE_MS })
      ],
      now
    )
    expect(onScreen()).toEqual([destroyFailed.message])

    // The dismissal keeps its time, so a repeat now is past the quiet period
    // and comes straight back.
    expect(items()[0].dismissedAt).toBe(T0 + 10)
    expect(store().receive(dispatchFailed(1), now)).toBe(true)
  })

  it('shows a billing risk that failed again after its dismissal in an earlier window, however soon', () => {
    // Main's record for "dismissed, then 'clear failed' failed again a minute
    // later" (events.test.ts checks main hands out exactly this).
    store().seed(
      [record(destroyFailed, { count: 2, dismissedAt: T0 + 1_000, lastSeen: T0 + 61_000 })],
      T0 + 62_000
    )
    expect(bannerOrder(items()).map((a) => a.message)).toEqual([destroyFailed.message])
  })
})

describe('alertStore: a banner row dismissed only once it could have been read', () => {
  const keys = (...alerts: AlertEvent[]): string[] => alerts.map((a) => `${a.level}:${a.message}`)

  it('leaves out a billing risk that arrived at the top just before the click', () => {
    const rows = new OnScreen()
    rows.drawn(keys(dispatchFailed(1), dispatchFailed(2), dispatchFailed(3)), T0)
    // The user reads them, and moves to "Dismiss all". A billing risk lands
    // on top just before the click and pushes the last one off the banner.
    rows.drawn(keys(orphan, dispatchFailed(1), dispatchFailed(2)), T0 + 5_000)
    const onClick = keys(orphan, dispatchFailed(1), dispatchFailed(2))
    expect(rows.settled(onClick, T0 + 5_200)).toEqual(keys(dispatchFailed(1), dispatchFailed(2)))

    // Once it has been on screen a moment, it goes like the rest.
    expect(rows.settled(onClick, T0 + 5_000 + SETTLE_MS)).toEqual(onClick)
  })

  it('leaves out the rows that moved up after a dismissal, from a second quick click', () => {
    const rows = new OnScreen()
    rows.drawn(keys(dispatchFailed(1), dispatchFailed(2), dispatchFailed(3)), T0)
    // "Dismiss these 3" at T0 + 4 s: the next three move up in their place.
    rows.drawn(keys(dispatchFailed(4), dispatchFailed(5), dispatchFailed(6)), T0 + 4_000)
    expect(rows.settled(keys(dispatchFailed(4), dispatchFailed(5)), T0 + 4_300)).toEqual([])
  })

  it('a row that left the screen and came back has to settle again', () => {
    const rows = new OnScreen()
    rows.drawn(keys(orphan), T0)
    rows.drawn([], T0 + 5_000)
    rows.drawn(keys(orphan), T0 + 6_000)
    expect(rows.settled(keys(orphan), T0 + 6_000 + SETTLE_MS - 1)).toEqual([])
    expect(rows.settled(keys(orphan), T0 + 6_000 + SETTLE_MS)).toEqual(keys(orphan))
    // A key never drawn is never dismissed.
    expect(rows.settled(keys(foreign), T0 + 60_000)).toEqual([])
  })
})

describe('useIpcEvents', () => {
  // Driven without a DOM: useEffect runs its body at once, and window.api is
  // a fake that records subscriptions and answers alerts:recent with `replay`.
  // Notification is stubbed only to show the window never raises one.
  type Listener = (payload: unknown) => void
  const listeners = new Map<string, Listener>()
  const notifications: string[] = []
  let replay: AlertRecord[] = []
  let focused = true
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    listeners.clear()
    notifications.length = 0
    replay = []
    focused = true
    vi.resetModules()
    vi.doMock('react', async (importOriginal) => ({
      ...(await importOriginal<typeof import('react')>()),
      useEffect: (fn: () => (() => void) | void) => {
        cleanup = fn() || undefined
      }
    }))
    vi.doMock('@tanstack/react-query', async (importOriginal) => {
      const rq = await importOriginal<typeof import('@tanstack/react-query')>()
      const qc = new rq.QueryClient()
      return { ...rq, useQueryClient: () => qc }
    })
    vi.stubGlobal('window', {
      api: {
        on: (channel: string, listener: Listener) => {
          listeners.set(channel, listener)
          return () => listeners.delete(channel)
        },
        invoke: async (channel: string) => {
          if (channel !== 'alerts:recent') throw new Error(`unexpected invoke ${channel}`)
          return replay
        }
      },
      focus: () => {}
    })
    vi.stubGlobal('document', { hasFocus: () => focused })
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted'
        onclick: (() => void) | null = null
        constructor(_title: string, opts: { body: string }) {
          notifications.push(opts.body)
        }
      }
    )
  })
  afterEach(() => {
    if (cleanup) cleanup()
    cleanup = undefined
    vi.doUnmock('react')
    vi.doUnmock('@tanstack/react-query')
    vi.unstubAllGlobals()
  })

  async function mount(): Promise<typeof import('./alertStore')> {
    const queries = await import('./queries')
    const alerts = await import('./alertStore')
    // Called as a plain function (useEffect is mocked above), under a name
    // the rules-of-hooks lint does not take for a hook call outside React.
    const runIpcEvents = queries.useIpcEvents
    runIpcEvents()
    // Let the alerts:recent reply land.
    await new Promise((r) => setTimeout(r, 0))
    return alerts
  }

  it('subscribes to every push channel, alert included', async () => {
    await mount()
    const channels: EventChannel[] = [
      'node:changed',
      'job:changed',
      'chunk:progress',
      'chunk:changed',
      'render:logLine',
      'asset:added',
      'fleet:cost',
      'alert'
    ]
    expect([...listeners.keys()].sort()).toEqual([...channels].sort())
  })

  it("a pushed alert reaches the store; the OS notification is main's, never the window's", async () => {
    const { useAlertStore } = await mount()
    const push = (a: AlertEvent): void => listeners.get('alert')?.(a)

    push(scaleUp)
    push(destroyFailed)
    expect(useAlertStore.getState().items.map((a) => a.message)).toEqual([
      scaleUp.message,
      destroyFailed.message
    ])

    // Main notifies for this one (ipc.ts), so a second from here would tell
    // the user twice.
    focused = false
    push(orphan)
    expect(useAlertStore.getState().items.map((a) => a.message)).toContain(orphan.message)
    expect(notifications).toEqual([])
  })

  it('a boot-time alert, raised before any window existed, shows once the window mounts', async () => {
    // Main, at boot: the orphan sweep failed a destroy before createWindow(),
    // and main's buffer kept it for this replay (events.test.ts).
    replay = [record(orphan)]

    const { useAlertStore } = await mount()
    const banner = useAlertStore
      .getState()
      .items.filter((a) => a.sticky && a.dismissedAt === null)
      .map((a) => [a.message, a.billingRisk])
    expect(banner).toEqual([[orphan.message, true]])
  })
})
