/**
 * Retry-with-backoff for the FIRST SSH connection to a freshly booted node.
 *
 * vast.ai reports an instance as "running" as soon as its container starts,
 * which is before sshd inside it is listening — and before the proxy endpoint
 * has been wired up. The first attempt therefore routinely gets ECONNREFUSED
 * (or a reset / handshake timeout). Treating that as fatal destroyed healthy
 * nodes and rented replacements: in one 53-node run, 23 were thrown away this
 * way. The fix is to keep trying for a few minutes before declaring the node
 * dead, and to give up at once only on the errors that retrying cannot fix.
 *
 * Pure apart from the injected clock/sleep, so it is unit-testable.
 */

import { HostKeyMismatchError } from './sshConnection'

/** How long a freshly booted node gets to start accepting SSH. */
export const FIRST_CONNECT_BUDGET_MS = 3 * 60_000

export interface RetryOptions {
  /** total time budget, measured from the first attempt */
  budgetMs: number
  /** first backoff delay; doubles per retry up to maxDelayMs */
  initialDelayMs?: number
  maxDelayMs?: number
  /** errors for which this returns false fail immediately */
  isRetryable?: (e: Error) => boolean
  /** told about each failed attempt that will be retried */
  onRetry?: (e: Error, attempt: number, delayMs: number) => void
  /** give up early (e.g. the node was destroyed meanwhile) */
  shouldAbort?: () => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Errors worth retrying on a node that has only just booted. Everything is,
 * except a host-key mismatch — that is a different machine (or an attacker)
 * answering, and retrying would only paper over it.
 */
export function isRetryableSshError(e: Error): boolean {
  if (e instanceof HostKeyMismatchError) return false
  return !/host key mismatch/i.test(e.message)
}

export class RetryAbortedError extends Error {
  constructor() {
    super('aborted')
  }
}

/**
 * Run `attempt` until it resolves, the budget runs out, or it throws a
 * non-retryable error. The last error is rethrown with the attempt count.
 */
export async function retryWithBackoff<T>(
  attempt: (n: number) => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const isRetryable = opts.isRetryable ?? isRetryableSshError
  const maxDelay = opts.maxDelayMs ?? 30_000
  let delay = opts.initialDelayMs ?? 5_000
  const start = now()
  for (let n = 1; ; n++) {
    if (opts.shouldAbort?.()) throw new RetryAbortedError()
    try {
      return await attempt(n)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (!isRetryable(e)) throw e
      const elapsed = now() - start
      if (elapsed + delay > opts.budgetMs) {
        const wrapped = new Error(
          `${e.message} (gave up after ${n} attempt${n === 1 ? '' : 's'} over ${Math.round(elapsed / 1000)}s)`
        )
        throw wrapped
      }
      opts.onRetry?.(e, n, delay)
      await sleep(delay)
      delay = Math.min(delay * 2, maxDelay)
    }
  }
}
