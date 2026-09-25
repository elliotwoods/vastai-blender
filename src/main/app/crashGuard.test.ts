import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Plan 1.21. Field, job da68b61b: with the Mac's disk full, the headless
// stdout mirror threw ENOSPC, nothing caught it, and Electron's modal
// "A JavaScript error occurred in the main process" box sat in front of the
// app while nodes billed.

type CrashGuard = typeof import('./crashGuard')

let guard: CrashGuard
beforeEach(async () => {
  // Fresh counters per test.
  vi.resetModules()
  guard = await import('./crashGuard')
})

const enospc = (): Error =>
  Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })

describe('diagWrite (plan 1.21)', () => {
  it('a write the full disk refuses is counted and dropped, never thrown', () => {
    const sink = {
      write: () => {
        throw enospc()
      }
    }
    expect(() => guard.diagWrite(sink, 'line\n')).not.toThrow()
    guard.diagWrite(
      {
        write: () => {
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        }
      },
      'line\n'
    )
    guard.diagWrite(
      {
        write: () => {
          throw new Error('something else')
        }
      },
      'x'
    )
    expect(guard.diagFailures()).toEqual({ ENOSPC: 1, EPIPE: 1, EIO: 0, other: 1 })
  })

  it('a write that works is just written', () => {
    const lines: string[] = []
    guard.diagWrite({ write: (t) => lines.push(t) }, 'hello\n')
    expect(lines).toEqual(['hello\n'])
    expect(guard.diagFailures()).toEqual({ ENOSPC: 0, EPIPE: 0, EIO: 0, other: 0 })
  })
})

describe('guardStdio (plan 1.21)', () => {
  it("a stream's late 'error' (a closed terminal, a full disk) is counted, not an uncaught exception", () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    guard.guardStdio([stdout, stderr])
    // An EventEmitter with no 'error' listener throws the error at emit.
    expect(() => stdout.emit('error', enospc())).not.toThrow()
    expect(() =>
      stderr.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }))
    ).not.toThrow()
    expect(guard.diagFailures()).toMatchObject({ ENOSPC: 1, EIO: 1 })
  })
})

describe('installCrashGuard (plan 1.21)', () => {
  function installed(opts: { log?: (t: string) => void; alert?: (m: string) => void } = {}): {
    proc: EventEmitter
    alerts: string[]
    logged: string[]
  } {
    const proc = new EventEmitter()
    const alerts: string[] = []
    const logged: string[] = []
    guard.installCrashGuard({
      proc,
      alert: opts.alert ?? ((m) => alerts.push(m)),
      log: opts.log ?? ((t) => logged.push(t))
    })
    return { proc, alerts, logged }
  }

  it('an uncaught exception is logged with its stack and raised as an alert, not thrown', () => {
    const { proc, alerts, logged } = installed()
    const e = enospc()
    expect(() => proc.emit('uncaughtException', e)).not.toThrow()
    expect(alerts).toEqual([
      'Vast Render hit an unexpected error and kept running: ' +
        'ENOSPC: no space left on device, write. If renders or downloads look stuck, ' +
        'restart the app; nodes keep billing until they are destroyed.'
    ])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/^\[vast-render\] uncaught exception: ENOSPC: no space left/)
    expect(logged[0]).toMatch(/\n\s+at /)
  })

  it('an unhandled rejection too, whatever was rejected', () => {
    const { proc, alerts, logged } = installed()
    proc.emit('unhandledRejection', undefined)
    proc.emit('unhandledRejection', new Error('connect ECONNREFUSED 1.2.3.4:22'))
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toContain('unknown error (undefined was thrown)')
    expect(logged[1]).toMatch(/^\[vast-render\] unhandled rejection: connect ECONNREFUSED/)
  })

  it('a log that fails (the disk that caused all this) still raises the alert', () => {
    const { proc, alerts } = installed({
      log: () => {
        throw enospc()
      }
    })
    expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow()
    expect(alerts).toHaveLength(1)
    expect(guard.diagFailures().ENOSPC).toBe(1)
  })

  it('an alert that throws is not an uncaught exception of its own', () => {
    const { proc } = installed({
      alert: () => {
        throw new Error('window gone')
      }
    })
    expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow()
  })

  it('never logs or alerts an API key an error quotes', () => {
    const { proc, alerts, logged } = installed()
    proc.emit(
      'unhandledRejection',
      new Error('Failed to parse URL from https://console.vast.ai/api/v0/x?api_key=sekrit123')
    )
    expect(alerts[0]).not.toContain('sekrit123')
    expect(logged[0]).not.toContain('sekrit123')
  })
})
