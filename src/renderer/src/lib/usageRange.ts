/**
 * The windows the Fleet screen's GPU graphs offer (Feature G), shared by the
 * queries that read them and the charts that draw them.
 */

import { useState } from 'react'

export type UsageRange = '15m' | '1h' | '6h' | '24h'

export const USAGE_RANGES: ReadonlyArray<{ key: UsageRange; label: string; ms: number }> = [
  { key: '15m', label: '15m', ms: 15 * 60_000 },
  { key: '1h', label: '1h', ms: 60 * 60_000 },
  { key: '6h', label: '6h', ms: 6 * 60 * 60_000 },
  { key: '24h', label: '24h', ms: 24 * 60 * 60_000 }
]

export function rangeMs(range: UsageRange): number {
  return USAGE_RANGES.find((r) => r.key === range)?.ms ?? 60 * 60_000
}

export function isUsageRange(v: unknown): v is UsageRange {
  return USAGE_RANGES.some((r) => r.key === v)
}

/**
 * Buckets a history read may return. Main widens each bucket to the next
 * step it knows (at least 30 s), so this bounds the points, not the width:
 * 15 min comes back as 30 buckets of 30 s, 24 h as 144 of 10 min.
 */
export const HISTORY_POINTS = 240

/**
 * A graph's range, remembered under `key`: a view preference, kept in
 * localStorage like the Fleet's "show failed", and never required (a
 * private window or cleared storage falls back).
 */
export function useStoredRange(
  key: string,
  fallback: UsageRange
): [UsageRange, (r: UsageRange) => void] {
  const [range, setRange] = useState<UsageRange>(() => {
    try {
      const v = localStorage.getItem(key)
      return isUsageRange(v) ? v : fallback
    } catch {
      return fallback
    }
  })
  const set = (r: UsageRange): void => {
    setRange(r)
    try {
      localStorage.setItem(key, r)
    } catch {
      // best-effort persistence
    }
  }
  return [range, set]
}
