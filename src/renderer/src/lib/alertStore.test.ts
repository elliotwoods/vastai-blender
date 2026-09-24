import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertRecord, EventChannel } from '../../../shared/ipc'
import type { AlertEvent } from '../../../shared/models'
import {
  MAX_ALERTS,
  REPLAY_TOAST_MS,
  RESURFACE_MS,
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

function record(e: AlertEvent, over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: 1,
    key: `${e.level}:${e.message}`,
    level: e.level,
    message: e.message,
    ts: T0,
    lastSeen: T0,
    count: 1,
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
    store().receive({ level: 'warn', message: 'destroying orphaned instance 7 (x)' }, T0)
    store().receive({ level: 'error', message: 'dispatch c1 failed: boom' }, T0)

    expect(items().map((a) => [a.sticky, a.billingRisk])).toEqual([
      [false, false],
      [true, true],
      [true, true],
      [true, true],
      [true, false]
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
    store().receive(destroyFailed, T0)
    store().dismiss([items()[0].key], T0 + 1_000)
    expect(onScreen()).toEqual([])

    expect(store().receive(destroyFailed, T0 + 1_000 + RESURFACE_MS - 1)).toBe(false)
    expect(onScreen()).toEqual([])
    expect(items()[0].count).toBe(2)

    expect(store().receive(destroyFailed, T0 + 1_000 + RESURFACE_MS)).toBe(true)
    expect(onScreen()).toEqual([destroyFailed.message])
    expect(items()[0]).toMatchObject({ count: 3, surfacedAt: T0 + 1_000 + RESURFACE_MS })
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
})

describe('main: recent alerts (events.ts)', () => {
  // Fresh module per test: the buffer is module state.
  let bus: typeof import('../../../main/events')
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    bus = await import('../../../main/events')
  })
  afterEach(() => vi.useRealTimers())

  it('collapses identical repeats into one entry with a count and lastSeen', () => {
    bus.emit('alert', scaleUp)
    vi.setSystemTime(T0 + 1_000)
    bus.emit('alert', destroyFailed)
    for (let i = 1; i <= 40; i++) {
      vi.setSystemTime(T0 + 1_000 + i * 15_000)
      bus.emit('alert', scaleUp)
    }

    const recent = bus.recentAlerts()
    expect(recent).toHaveLength(2)
    // Least recently seen first: the repeat moved to the newest end.
    expect(recent.map((r) => r.message)).toEqual([destroyFailed.message, scaleUp.message])
    expect(recent[1]).toMatchObject({
      id: 1,
      level: 'warn',
      key: `warn:${scaleUp.message}`,
      ts: T0,
      lastSeen: T0 + 1_000 + 40 * 15_000,
      count: 41
    })
    expect(recent[0]).toMatchObject({ id: 2, ts: T0 + 1_000, count: 1 })
  })

  it('is bounded, evicting the least recently seen alert that is not sticky', () => {
    bus.emit('alert', destroyFailed)
    bus.emit('alert', foreign)
    for (let i = 0; i < bus.MAX_RECENT_ALERTS + 30; i++) {
      bus.emit('alert', { level: 'warn', message: `download failed (frames/${i}.png)` })
    }
    const recent = bus.recentAlerts()
    expect(recent).toHaveLength(bus.MAX_RECENT_ALERTS)
    expect(recent.slice(0, 3).map((r) => r.message)).toEqual([
      destroyFailed.message,
      foreign.message,
      'download failed (frames/32.png)'
    ])
  })

  it('evicts the oldest sticky alert only once every entry is sticky', () => {
    for (let i = 0; i <= bus.MAX_RECENT_ALERTS; i++) {
      bus.emit('alert', { level: 'error', message: `Destroy failed for instance ${i}` })
    }
    const recent = bus.recentAlerts()
    expect(recent).toHaveLength(bus.MAX_RECENT_ALERTS)
    expect(recent[0].message).toBe('Destroy failed for instance 1')
  })

  it('keeps alerts nobody was listening for, and hands out copies', () => {
    // Before any window, as nodeManager.init()'s orphan sweep is.
    bus.emit('alert', destroyFailed)
    const a = bus.recentAlerts()
    a[0].count = 99
    expect(bus.recentAlerts()[0].count).toBe(1)
  })

  it('listeners still get the emitted object itself', () => {
    const heard: unknown[] = []
    const off = bus.on('alert', (p) => heard.push(p))
    bus.emit('alert', scaleUp)
    off()
    expect(heard[0]).toBe(scaleUp)
  })
})

describe('useIpcEvents', () => {
  // Driven without a DOM: useEffect runs its body at once, and window.api is
  // a fake that records subscriptions and answers alerts:recent from the
  // real main-side buffer.
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

  it('a pushed alert reaches the store; an error raises an OS notification only while unfocused', async () => {
    const { useAlertStore } = await mount()
    const push = (a: AlertEvent): void => listeners.get('alert')?.(a)

    push(scaleUp)
    push(destroyFailed)
    expect(useAlertStore.getState().items.map((a) => a.message)).toEqual([
      scaleUp.message,
      destroyFailed.message
    ])
    expect(notifications).toEqual([])

    focused = false
    const other = {
      level: 'error' as const,
      message: 'Could not destroy instance 5 — check the Vast.ai console!'
    }
    push(other)
    push(other) // a repeat of one already on screen: no second notification
    push({ level: 'warn', message: 'chunk c1 failed: exit 1' })
    expect(notifications).toEqual([other.message])
  })

  it('a boot-time alert, raised before any window existed, shows once the window mounts', async () => {
    // Main, at boot: the orphan sweep fails a destroy before createWindow().
    const bus = await import('../../../main/events')
    const orphan: AlertEvent = {
      level: 'error',
      message: 'orphan destroy failed for 42: HTTP 500 — check the Vast.ai console!'
    }
    bus.emit('alert', orphan)
    replay = bus.recentAlerts()

    const { useAlertStore } = await mount()
    const banner = useAlertStore
      .getState()
      .items.filter((a) => a.sticky && a.dismissedAt === null)
      .map((a) => [a.message, a.billingRisk])
    expect(banner).toEqual([[orphan.message, true]])
  })
})
