import type { HistoryMetric, HistorySummary } from '../../../../shared/models'

/**
 * The date for the "Recording began …" note under a History chart, or null
 * for no note. The note explains a line that starts late by its series
 * starting late, so the date must be that series' own (#117).
 *
 * Balance has its own log. Its first point is the last earlier reading,
 * restamped to the window start, whenever the balance was known before the
 * window: the line then spans the window and there is nothing to explain.
 * Otherwise its first point is the first reading there has ever been, which
 * is when balance recording began. With no readings at all, the chart's own
 * empty note says so; the usage log's start would be an unrelated date.
 *
 * The other views are built from usage_log, whose oldest row is
 * `earliestMs`; `plotted` is how many points the view drew.
 */
export function recordingBegan(
  metric: HistoryMetric,
  data: Pick<HistorySummary, 'fromMs' | 'earliestMs' | 'balancePoints' | 'totals'>,
  plotted: number
): number | null {
  if (metric === 'balance') {
    const first = data.balancePoints[0]
    return first != null && first.ts > data.fromMs ? first.ts : null
  }
  const short = plotted === 0 || (metric === 'power' && data.totals.wh === 0)
  return short ? data.earliestMs : null
}
