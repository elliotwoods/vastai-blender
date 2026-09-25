/**
 * Vast's rate limit on one endpoint, and vastClient's answer to it, on a
 * FakeVast: for a test of something that sends many of the same request
 * at once (plan 1.1's Destroy all).
 *
 * Vast applies "a minimum interval between requests for a given endpoint and
 * identity", and a DELETE refused for it answers 429 `rate_limit_exceeded`,
 * "threshold=3.0" (docs.vast.ai, Rate Limits and Errors; destroy instance).
 * vastClient's request() retries a 429 itself, inside the one call: backoff
 * doubling from RETRY_FIRST_DELAY_MS to RETRY_MAX_DELAY_MS, and no retry that
 * would start past RETRY_BUDGET_MS. fakeVast.ts leaves that retry out (see
 * its header), so this puts both back for one method: a request that comes
 * too soon after the last one Vast took is refused and retried on the
 * client's schedule, as the app sees it. Without the client's ±25% jitter,
 * so that a run is repeatable.
 *
 * Lenient on purpose: only a request Vast takes restarts the interval, not a
 * refused one. Vast does not document which, and a test that fails under the
 * lenient reading fails under the strict one too.
 */

import type { FakeVast } from './fakeVast'

/** vastClient's retry schedule: pass its exported RETRY_* constants. */
export interface ClientRetry {
  RETRY_FIRST_DELAY_MS: number
  RETRY_MAX_DELAY_MS: number
  RETRY_BUDGET_MS: number
}

export interface RateLimit {
  /** 429s Vast answered, retried or not. */
  readonly refused: number
  /** Calls that ended in a 429 once the client's retry budget ran out. */
  readonly gaveUp: number
}

/**
 * Rate-limit `vast.destroyInstance` to one request every `intervalMs`.
 * `client` is `await import('../vast/vastClient')` after setup (its real
 * constants come through the harness's mock), and `vastError` builds its
 * VastError, so the app's classify() reads the 429 as it would Vast's.
 */
export function rateLimitDestroys(
  vast: FakeVast,
  client: ClientRetry,
  vastError: (message: string, status: number) => Error,
  intervalMs = 3_000
): RateLimit {
  const send = vast.destroyInstance.bind(vast)
  const stats = { refused: 0, gaveUp: 0 }
  let lastTaken = Number.NEGATIVE_INFINITY
  vast.destroyInstance = async (id: number): Promise<void> => {
    const start = Date.now()
    let delay = client.RETRY_FIRST_DELAY_MS
    for (;;) {
      if (Date.now() - lastTaken >= intervalMs) {
        lastTaken = Date.now()
        return send(id)
      }
      stats.refused++
      if (Date.now() - start + delay > client.RETRY_BUDGET_MS) {
        stats.gaveUp++
        throw vastError(
          `vast.ai DELETE /instances/${id}/ → 429: {"error":"rate_limit_exceeded",` +
            `"msg":"API requests too frequent endpoint threshold=3.0"}`,
          429
        )
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, client.RETRY_MAX_DELAY_MS)
    }
  }
  return stats
}
