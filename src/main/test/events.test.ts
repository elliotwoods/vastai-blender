import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStickyAlert, isStillDismissed, RESURFACE_MS } from '../../shared/ipc'
import type { AlertEvent, LogLineEvent } from '../../shared/models'
// events.ts imports nothing with side effects (types, and pure helpers from
// shared/ipc.ts), so unlike the engine modules it can be imported statically,
// which is the point of it. The harness tests at the end still follow the
// harness's rule: their bus is the one imported after setup().
import { emit, on, onEvent, type BusEvent } from '../events'
import { setup, type World } from './harness'

const alert: AlertEvent = { level: 'warn', message: 'spend cap reached' }
const logLine: LogLineEvent = {
  nodeId: '0123456789abcdef',
  chunkId: 'c1',
  line: 'Fra:12 Mem:1.2G | Rendering',
  ts: 1
}

describe('event bus', () => {
  const unsubscribes: Array<() => void> = []
  afterEach(() => {
    for (const u of unsubscribes.splice(0)) u()
  })

  it('delivers every event to every listener, in emit order, payload untouched', () => {
    const a: BusEvent[] = []
    const b: BusEvent[] = []
    unsubscribes.push(
      onEvent((e) => a.push(e)),
      onEvent((e) => b.push(e))
    )

    emit('alert', alert)
    emit('render:logLine', logLine)

    expect(a).toEqual([
      { channel: 'alert', payload: alert },
      { channel: 'render:logLine', payload: logLine }
    ])
    expect(b).toEqual(a)
    // The very object the emitter passed, not a copy: what ipc.ts forwards is
    // what was emitted.
    expect(a[0].payload).toBe(alert)
  })

  it('on() hears one channel only', () => {
    const alerts: AlertEvent[] = []
    unsubscribes.push(on('alert', (p) => alerts.push(p)))
    emit('render:logLine', logLine)
    emit('alert', alert)
    expect(alerts).toEqual([alert])
  })

  it('an unsubscribed listener hears nothing more, even mid-emit', () => {
    const heard: string[] = []
    let offB: () => void = () => {}
    const offA = onEvent(() => {
      heard.push('a')
      offB()
    })
    offB = onEvent(() => heard.push('b'))
    unsubscribes.push(offA, offB)

    emit('alert', alert) // b was subscribed when this began, so it still hears it
    emit('alert', alert)
    expect(heard).toEqual(['a', 'b', 'a'])
  })

  // emit() runs inside nodeManager's destroy and recovery catch blocks: a
  // window whose webContents was destroyed must not unwind into them.
  it('a throwing listener neither reaches the emitter nor silences the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const heard: BusEvent[] = []
    unsubscribes.push(
      onEvent(() => {
        throw new Error('listener failed')
      }),
      onEvent((e) => heard.push(e))
    )
    expect(() => emit('alert', alert)).not.toThrow()
    expect(heard).toHaveLength(1)
    expect(String(err.mock.calls[0]?.[1])).toContain('listener failed')
    err.mockRestore()
  })
})

describe('headless stdout mirror', () => {
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.stubEnv('VR_JOB_SPEC', '')
    vi.stubEnv('VR_E2E_BLEND', '')
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    log.mockRestore()
  })

  it('is silent in an interactive run', () => {
    emit('alert', alert)
    emit('render:logLine', logLine)
    expect(log).not.toHaveBeenCalled()
  })

  // Observed on a full disk: console.log threw ENOSPC out of emit() and main
  // showed a modal error while the fleet billed.
  it('a stdout that throws (full disk) costs the mirror, not the event', () => {
    vi.stubEnv('VR_JOB_SPEC', '/tmp/spec.json')
    log.mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('EPIPE')
    })
    const heard: BusEvent[] = []
    const off = onEvent((e) => heard.push(e))
    expect(() => emit('alert', alert)).not.toThrow()
    expect(heard).toHaveLength(1)
    off()
    err.mockRestore()
  })

  it.each(['VR_JOB_SPEC', 'VR_E2E_BLEND'])('mirrors every event under %s', (env) => {
    vi.stubEnv(env, '/tmp/spec.json')
    const long: AlertEvent = { level: 'info', message: 'x'.repeat(400) }

    emit('alert', alert)
    emit('alert', long)
    emit('render:logLine', logLine)

    expect(log.mock.calls).toEqual([
      [`[event] alert ${JSON.stringify(alert)}`],
      // Payloads are cut at 240 characters of their JSON.
      [`[event] alert ${JSON.stringify(long).slice(0, 240)}`],
      // Log lines get their own compact form, and only that one.
      ['[log:01234567] Fra:12 Mem:1.2G | Rendering']
    ])
  })
})

// -- recent alerts ----------------------------------------------------------------

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
const keyOf = (a: AlertEvent): string => `${a.level}:${a.message}`

describe('recent alerts', () => {
  // Fresh module per test: the buffer is module state.
  let bus: typeof import('../events')
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    bus = await import('../events')
  })
  afterEach(() => vi.useRealTimers())

  /**
   * What a window opened now puts on its banner: each sticky alert in the
   * replay that isStillDismissed does not hold back. That is alertStore's
   * seed, which takes both rules from shared/ipc.ts, so the renderer's store
   * is not needed here. alertStore.test.ts seeds the store itself with
   * records like these.
   */
  const reopenedBanner = (): string[] =>
    bus
      .recentAlerts()
      .filter((r) => isStickyAlert(r) && !isStillDismissed(r))
      .map((r) => r.message)

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

  it('a billing risk outlasts any number of distinct errors; the oldest errors go first', () => {
    bus.emit('alert', orphan)
    for (let i = 0; i <= bus.MAX_RECENT_ALERTS; i++) bus.emit('alert', dispatchFailed(i))

    const recent = bus.recentAlerts()
    expect(recent).toHaveLength(bus.MAX_RECENT_ALERTS)
    expect(recent.slice(0, 2).map((r) => r.message)).toEqual([
      orphan.message,
      dispatchFailed(2).message
    ])
  })

  it('a dismissed error goes before one nobody has seen', () => {
    bus.emit('alert', dispatchFailed(0))
    bus.emit('alert', destroyFailed)
    bus.dismissAlerts([keyOf(destroyFailed)])
    for (let i = 1; i < bus.MAX_RECENT_ALERTS; i++) bus.emit('alert', dispatchFailed(i))

    const recent = bus.recentAlerts()
    expect(recent).toHaveLength(bus.MAX_RECENT_ALERTS)
    expect(recent[0].message).toBe(dispatchFailed(0).message)
    expect(recent.some((r) => r.message === destroyFailed.message)).toBe(false)
  })

  it('remembers a dismissal, so a reopened window does not show it again', () => {
    bus.emit('alert', dispatchFailed(1))
    bus.emit('alert', dispatchFailed(2))
    vi.setSystemTime(T0 + 1_000)
    bus.dismissAlerts([keyOf(dispatchFailed(1)), 'error:never raised'])
    expect(bus.recentAlerts().map((r) => r.dismissedAt)).toEqual([T0 + 1_000, null])

    // A window opened now: only what the user has not dealt with.
    expect(reopenedBanner()).toEqual([dispatchFailed(2).message])

    // It fires again within the quiet period, and later after it. A window
    // opened after each shows it only the second time, just as the window
    // that was open all along would have.
    vi.setSystemTime(T0 + 60_000)
    bus.emit('alert', dispatchFailed(1))
    expect(reopenedBanner()).toEqual([dispatchFailed(2).message])

    vi.setSystemTime(T0 + 1_000 + RESURFACE_MS)
    bus.emit('alert', dispatchFailed(1))
    expect(reopenedBanner()).toEqual([dispatchFailed(2).message, dispatchFailed(1).message])
    expect(bus.recentAlerts()[1]).toMatchObject({ count: 3, dismissedAt: T0 + 1_000 })
  })

  it('a billing risk that fires again after its dismissal is back for a reopened window at once', () => {
    bus.emit('alert', destroyFailed)
    vi.setSystemTime(T0 + 1_000)
    bus.dismissAlerts([keyOf(destroyFailed)])
    expect(reopenedBanner()).toEqual([])

    // "clear failed" retried the destroy during the same Vast outage, and it
    // failed again a minute later: the instance is still billing.
    vi.setSystemTime(T0 + 61_000)
    bus.emit('alert', destroyFailed)
    expect(reopenedBanner()).toEqual([destroyFailed.message])
    expect(bus.recentAlerts()[0]).toMatchObject({
      count: 2,
      lastSeen: T0 + 61_000,
      dismissedAt: T0 + 1_000
    })
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

  it('surfaces an alert when it is new or back after a dismissal, not on every repeat', () => {
    const surfaced: AlertEvent[] = []
    const off = bus.onAlertSurfaced((a) => surfaced.push(a))

    bus.emit('alert', scaleUp) // new
    vi.setSystemTime(T0 + 15_000)
    bus.emit('alert', scaleUp) // still showing: counts up only
    const failed = dispatchFailed(1)
    bus.emit('alert', failed) // new
    vi.setSystemTime(T0 + 20_000)
    bus.dismissAlerts([keyOf(failed)])
    vi.setSystemTime(T0 + 80_000)
    bus.emit('alert', failed) // quiet
    vi.setSystemTime(T0 + 20_000 + RESURFACE_MS)
    const back = { ...failed }
    bus.emit('alert', back) // back
    vi.setSystemTime(T0 + 35_000 + RESURFACE_MS)
    bus.emit('alert', failed) // showing again: counts up only

    expect(surfaced).toEqual([scaleUp, failed, back])
    // The emitted object itself, as the bus listeners get it.
    expect(surfaced[2]).toBe(back)

    off()
    bus.emit('alert', orphan)
    expect(surfaced).toHaveLength(3)
  })

  it('surfaces a billing risk again on any repeat after its dismissal, however soon', () => {
    const surfaced: string[] = []
    bus.onAlertSurfaced((a) => surfaced.push(a.message))

    bus.emit('alert', destroyFailed)
    vi.setSystemTime(T0 + 1_000)
    bus.dismissAlerts([keyOf(destroyFailed)])
    vi.setSystemTime(T0 + 61_000)
    bus.emit('alert', destroyFailed)
    vi.setSystemTime(T0 + 76_000)
    bus.emit('alert', destroyFailed) // not dismissed since: showing, counts up only

    expect(surfaced).toEqual([destroyFailed.message, destroyFailed.message])
  })
})

// -- OS notification -----------------------------------------------------------------
// ipc.ts raises it from onAlertSurfaced, through the harness's electron.

describe('OS notification (ipc.ts)', () => {
  let w: World
  beforeEach(async () => {
    w = await setup()
  })
  afterEach(() => w.dispose())

  /** registerIpc wired as index.ts wires it, minus createWindow; nothing started. */
  async function boot(): Promise<typeof import('../events')> {
    await w.boot({ start: false })
    return import('../events')
  }
  const bodies = (): unknown[] => w.notifications.map((n) => n.options.body)

  /**
   * `p`'s outcome once fake time has run it out: a destroy retries Vast on
   * timers (plan 1.2), so awaiting one without moving the clock never ends.
   */
  async function settled<T>(p: Promise<T>, what: string): Promise<T> {
    let done = false
    const tracked = p.finally(() => (done = true))
    await w.until(() => done, what, { stepMs: 1_000 })
    return tracked
  }

  it('for an error or billing risk while no window is in front; never for a toast', async () => {
    const bus = await boot()
    const win = w.openWindow() // open, behind another app

    bus.emit('alert', scaleUp)
    bus.emit('alert', dispatchFailed(1))
    bus.emit('alert', foreign) // a billing risk raised as a warning
    win.focused = true
    bus.emit('alert', orphan) // the user is looking: the banner is enough

    expect(bodies()).toEqual([dispatchFailed(1).message, foreign.message])
    expect(w.notifications.every((n) => n.shown && n.options.title === 'Vast Render')).toBe(true)
    // The window heard every one of them either way.
    expect(win.sent.map((e) => e.payload)).toEqual([scaleUp, dispatchFailed(1), foreign, orphan])
  })

  // A dead node fails dispatch for every pending chunk, each alert distinct.
  it('an error storm is paced to one now and one summary; billing risks are never held', async () => {
    const bus = await boot()
    for (let i = 0; i < 12; i++) bus.emit('alert', dispatchFailed(i))
    bus.emit('alert', destroyFailed) // a billing risk mid-storm
    expect(bodies()).toEqual([dispatchFailed(0).message, destroyFailed.message])

    await w.advance(20_000)
    expect(bodies()).toEqual([
      dispatchFailed(0).message,
      destroyFailed.message,
      '11 more errors — open Vast Render to see them'
    ])
    await w.advance(60_000)
    bus.emit('alert', dispatchFailed(99)) // the pace has passed: notifies at once
    expect(bodies()).toHaveLength(4)
  })

  it('with no window at all: on macOS the window can close while the fleet bills', async () => {
    const bus = await boot()
    bus.emit('alert', destroyFailed)
    expect(bodies()).toEqual([destroyFailed.message])
  })

  it('once per surfacing: not for a repeat still showing or still quiet, again once it is back', async () => {
    const bus = await boot()
    const failed = dispatchFailed(1)

    bus.emit('alert', failed)
    await w.advance(15_000)
    bus.emit('alert', failed) // still on the banner
    await w.invoke('alerts:dismiss', [keyOf(failed)])
    await w.advance(60_000)
    bus.emit('alert', failed) // quiet
    await w.advance(RESURFACE_MS)
    bus.emit('alert', failed) // back

    expect(bodies()).toEqual([failed.message, failed.message])
  })

  it('a destroy that fails again after its failure was dismissed notifies again, however soon', async () => {
    const app = await w.boot()
    const id = await w.readyNode(app)
    const [instanceId] = w.vast.created

    // A Vast outage longer than a destroy rides out its blips for (plan
    // 1.2): the destroy gives up for now, and so does the retry.
    w.vast.fail('destroyInstance', { status: 503, message: 'service unavailable' }, 100)
    await settled(app.nodeManager.destroyNode(id), 'destroy given up for now')
    const [message] = bodies() as string[]
    expect(bodies()).toHaveLength(1)
    expect(message).toContain(`Destroy failed for instance ${instanceId}`)
    expect(message).toContain('Vast.ai console')

    // The user dismisses it in the window, and a minute later presses Fleet's
    // "clear failed", which retries the destroy. The retry timer's own tries
    // meanwhile tell nobody: the user has heard.
    await w.invoke('alerts:dismiss', [`error:${message}`])
    await w.advance(60_000)
    expect(bodies()).toEqual([message])
    await expect(settled(w.invoke('fleet:clearFailed'), 'clear failed')).resolves.toBe(0)
    expect(w.vast.live()).toEqual([instanceId])

    // Still billing, so the user is told again...
    expect(bodies()).toEqual([message, message])
    // ...and a window opened now has it back on the banner.
    const replay = await w.invoke('alerts:recent')
    expect(replay.filter((r) => !isStillDismissed(r)).map((r) => r.message)).toContain(message)
  })

  it('clicked, brings the window back from behind or minimised', async () => {
    const bus = await boot()
    const win = w.openWindow()
    win.minimized = true
    win.visible = false

    bus.emit('alert', destroyFailed)
    w.notifications[0].emit('click')
    expect(win).toMatchObject({ minimized: false, visible: true, focused: true })
  })

  it('clicked with no window open, opens one', async () => {
    // registerIpc as index.ts calls it, with createWindow.
    const { registerIpc } = await import('../ipc')
    const bus = await import('../events')
    let created = 0
    registerIpc({
      createWindow: () => {
        created++
        w.openWindow()
      }
    })

    bus.emit('alert', orphan)
    expect(created).toBe(0)
    w.notifications[0].emit('click')
    expect(created).toBe(1)
    expect(w.windows).toHaveLength(1)
  })

  it('none where the desktop has no notifications; one that fails never costs the window the alert', async () => {
    const bus = await boot()
    const win = w.openWindow()
    w.notificationsSupported = false
    bus.emit('alert', dispatchFailed(1))
    expect(w.notifications).toHaveLength(0)

    // Notification itself throws (a desktop with no notification service).
    Object.defineProperty(w, 'notificationsSupported', {
      get: () => {
        throw new Error('no notification service')
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => bus.emit('alert', destroyFailed)).not.toThrow()
      expect(warn).toHaveBeenCalledWith('[alerts] OS notification failed:', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
    expect(win.sent.map((e) => e.payload)).toEqual([dispatchFailed(1), destroyFailed])
  })
})
