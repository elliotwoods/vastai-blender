import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AlertEvent, LogLineEvent } from '../../shared/models'
// events.ts imports nothing but types, so unlike the engine modules it can be
// imported statically — which is the point of it.
import { emit, on, onEvent, type BusEvent } from '../events'

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

  it('a throwing listener reaches the emitter, as a throwing webContents.send did', () => {
    unsubscribes.push(
      onEvent(() => {
        throw new Error('listener failed')
      })
    )
    expect(() => emit('alert', alert)).toThrow('listener failed')
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
