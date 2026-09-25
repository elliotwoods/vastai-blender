/**
 * Vast's rate limit on one endpoint, and vastClient's answer to it, on a
 * FakeVast: for a test of something that sends many of the same request
 * at once (plan 1.1's Destroy all).
 *
 * Vast applies "a minimum interval between requests for a given endpoint and
 * identity", and a DELETE refused for it answers 429 `rate_limit_exceeded`,
 * "threshold=3.0" (docs.vast.ai, Rate Limits and Errors; destroy instance).
 * vastClient's request() retries a 429 itself, after 3, 6, 9 and 12 s, and
 * throws the fifth. fakeVast.ts leaves that retry out (see its header), so
 * this puts both back for one method: a request that comes too soon after
 * the last one Vast took is refused and retried on vastClient's schedule,
 * inside the one call, as the app sees it.
 *
 * Lenient on purpose: only a request Vast takes restarts the interval, not a
 * refused one. Vast does not document which, and a test that fails under the
 * lenient reading fails under the strict one too.
 */

import type { FakeVast } from './fakeVast'

/** What vastClient's request() does after the attempt-th 429 (0-based), and when it gives up. */
const CLIENT_RETRIES = 4
const clientBackoffMs = (attempt: number): number => 3_000 * (attempt + 1)

export interface RateLimit {
  /** 429s Vast answered, retried or not. */
  readonly refused: number
  /** Calls that ended in a 429 after vastClient's last retry. */
  readonly gaveUp: number
}

/**
 * Rate-limit `vast.destroyInstance` to one request every `intervalMs`.
 * `vastError` builds the real VastError (`new VastError(message, status)`
 * from `await import('../vast/vastClient')` after setup), so the app's
 * classify() reads the 429 as it would Vast's.
 */
export function rateLimitDestroys(
  vast: FakeVast,
  vastError: (message: string, status: number) => Error,
  intervalMs = 3_000
): RateLimit {
  const send = vast.destroyInstance.bind(vast)
  const stats = { refused: 0, gaveUp: 0 }
  let lastTaken = Number.NEGATIVE_INFINITY
  const attempt = async (id: number, n: number): Promise<void> => {
    if (Date.now() - lastTaken >= intervalMs) {
      lastTaken = Date.now()
      return send(id)
    }
    stats.refused++
    if (n < CLIENT_RETRIES) {
      await new Promise((r) => setTimeout(r, clientBackoffMs(n)))
      return attempt(id, n + 1)
    }
    stats.gaveUp++
    throw vastError(
      `vast.ai DELETE /instances/${id}/ → 429: {"error":"rate_limit_exceeded",` +
        `"msg":"API requests too frequent endpoint threshold=3.0"}`,
      429
    )
  }
  vast.destroyInstance = (id: number) => attempt(id, 0)
  return stats
}
