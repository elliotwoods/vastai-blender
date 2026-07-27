/**
 * Ticking clock hook. Anything that renders "how long ago" / "uptime" needs a
 * re-render to stay honest, and calling Date.now() during render is impure
 * (react-hooks/purity) — so read the time from here instead.
 */

import { useEffect, useState } from 'react'

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
