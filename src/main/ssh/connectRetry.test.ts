import { describe, expect, it } from 'vitest'
import { isRetryableSshError, retryWithBackoff } from './connectRetry'
import { HostKeyMismatchError } from './sshConnection'

/** A fake clock whose sleep just advances time. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps
  }
}

const refused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:22'), { code: 'ECONNREFUSED' })

describe('retryWithBackoff', () => {
  it('rides out connection-refused while sshd starts', async () => {
    const c = clock()
    let calls = 0
    const r = await retryWithBackoff(
      async () => {
        calls++
        if (calls < 4) throw refused()
        return 'ok'
      },
      { budgetMs: 180_000, now: c.now, sleep: c.sleep }
    )
    expect(r).toBe('ok')
    expect(calls).toBe(4)
    expect(c.sleeps).toEqual([5_000, 10_000, 20_000])
  })

  it('gives up after the budget, naming the attempts', async () => {
    const c = clock()
    const err = await retryWithBackoff(
      async () => {
        throw refused()
      },
      { budgetMs: 180_000, now: c.now, sleep: c.sleep }
    ).catch((e) => e as Error)
    expect(err.message).toMatch(/ECONNREFUSED.*gave up after \d+ attempts/)
    expect(c.now()).toBeLessThanOrEqual(180_000)
    // Backoff is capped at 30 s.
    expect(Math.max(...c.sleeps)).toBe(30_000)
  })

  it('does not retry a host-key mismatch', async () => {
    const c = clock()
    let calls = 0
    await expect(
      retryWithBackoff(
        async () => {
          calls++
          throw new HostKeyMismatchError('a', 'b')
        },
        { budgetMs: 180_000, now: c.now, sleep: c.sleep }
      )
    ).rejects.toBeInstanceOf(HostKeyMismatchError)
    expect(calls).toBe(1)
  })

  it('stops when told to abort (node destroyed meanwhile)', async () => {
    const c = clock()
    let calls = 0
    await expect(
      retryWithBackoff(
        async () => {
          calls++
          throw refused()
        },
        { budgetMs: 180_000, now: c.now, sleep: c.sleep, shouldAbort: () => calls >= 2 }
      )
    ).rejects.toThrow(/aborted/)
    expect(calls).toBe(2)
  })

  it('classifies errors', () => {
    expect(isRetryableSshError(refused())).toBe(true)
    expect(isRetryableSshError(new Error('Timed out while waiting for handshake'))).toBe(true)
    expect(isRetryableSshError(new HostKeyMismatchError('a', 'b'))).toBe(false)
  })
})
