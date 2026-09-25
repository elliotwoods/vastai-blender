/**
 * Ticking clock hook. Anything that renders "how long ago" / "uptime" needs a
 * re-render to stay honest, and calling Date.now() during render is impure
 * (react-hooks/purity) — so read the time from here instead.
 *
 * `enabled: false` stops the ticking (the value stays at the last tick), for
 * a caller that only needs a live clock some of the time, such as a job's
 * timing, which stops moving once the job has finished.
 */

import { useEffect, useState } from 'react'

export function useNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, enabled])
  return now
}
