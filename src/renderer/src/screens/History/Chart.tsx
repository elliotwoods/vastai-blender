/**
 * History's chart: one series per view, drawn by the shared TimeChart. This
 * wrapper keeps the single-series props HistoryScreen was written against, so
 * the four views read exactly as they did before the chart was generalised
 * for the Fleet screen's per-GPU graphs.
 */

import { TimeChart } from '../../components/charts/TimeChart'
import type { ChartPoint, MarkKind } from '../../components/charts/scale'
import { TOKENS } from '../../lib/theme'

export type { ChartPoint, MarkKind }

export interface ChartProps {
  points: ChartPoint[]
  kind: MarkKind
  /** window bounds (epoch ms) — fixed by the range, not by the data */
  fromMs: number
  toMs: number
  /** bucket width, so bars can be drawn to scale */
  spanMs?: number
  color?: string
  height?: number
  /** y-axis + tooltip value formatting */
  format: (y: number) => string
  formatX: (ms: number) => string
  /** Levels (balance) read better zoomed; quantities must start at zero. */
  baseline?: 'zero' | 'fit'
  /**
   * Extra muted lines under the hovered value — the place for figures derived
   * from the point rather than the point itself (a bucket's energy and its CO2
   * estimate). Kept separate from `format`, which also labels the y-axis and
   * must stay a bare number.
   */
  tooltipExtra?: (p: { x: number; y: number }) => string[] | null
  /** shown centred when there is nothing to plot */
  emptyNote?: string
}

export function Chart({
  points,
  color = TOKENS.accent,
  tooltipExtra,
  ...rest
}: ChartProps): React.JSX.Element {
  return (
    <TimeChart
      {...rest}
      series={[{ id: 'value', label: '', color, points }]}
      tooltipExtra={
        tooltipExtra ? (x, [y]) => (y == null ? null : tooltipExtra({ x, y })) : undefined
      }
    />
  )
}
