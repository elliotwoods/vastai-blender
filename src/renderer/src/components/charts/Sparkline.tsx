/**
 * A trend at a glance, sized for a table row: no axes, no labels, the mean as
 * a line over a faint band from min to max. Across a node's GPUs a wide band
 * says the lanes are uneven: one card busy while the rest sit idle.
 *
 * Fixed size, so a column of them lines up, and a fixed y range, so rows
 * compare: two sparklines that both fill their box are equally busy only when
 * the box means the same thing on both. Nothing is drawn outside the box:
 * readings outside fromMs..toMs are dropped (a 60-minute ring handed to a
 * 30-minute sparkline would otherwise run over the next column), and values
 * outside the y range pin to its edge.
 *
 * Hovering (or focusing) reads out the snapped reading through the shared
 * Tooltip, which is portalled so a scrolling fleet list can't clip it.
 */

import { useState } from 'react'
import { TOKENS } from '../../lib/theme'
import { Tooltip } from '../Tooltip'
import { nearestIndex, summarize } from './scale'

export interface SparkPoint {
  /** epoch ms */
  x: number
  /** null = not sampled; breaks the line rather than reading as zero */
  mean: number | null
  /** spread across whatever the mean was taken over (a node's GPUs) */
  min?: number | null
  max?: number | null
}

export interface SparklineProps {
  points: SparkPoint[]
  /** window bounds (epoch ms) — fixed by the range, not by the data */
  fromMs: number
  toMs: number
  /** Fixed y range, so rows compare. GPU util: 0–100. */
  yMin?: number
  yMax: number
  width?: number
  height?: number
  color?: string
  /** What the trend is, for screen readers and the readout: "GPU util, 30 min". */
  label: string
  format: (v: number) => string
  formatX?: (ms: number) => string
}

/** Keeps a line at the edge of the box from losing half its stroke to the clip. */
const INSET = 1.5

/** Runs of consecutive readings; a missing mean is a gap. */
function runs(points: readonly SparkPoint[]): Array<Array<SparkPoint & { mean: number }>> {
  const out: Array<Array<SparkPoint & { mean: number }>> = []
  let run: Array<SparkPoint & { mean: number }> = []
  for (const p of points) {
    if (p.mean == null) {
      if (run.length) out.push(run)
      run = []
    } else {
      run.push({ ...p, mean: p.mean })
    }
  }
  if (run.length) out.push(run)
  return out
}

export function Sparkline({
  points: given,
  fromMs,
  toMs,
  yMin = 0,
  yMax,
  width = 64,
  height = 16,
  color = TOKENS.accent,
  label,
  format,
  formatX
}: SparklineProps): React.JSX.Element {
  const [hover, setHover] = useState<number | null>(null)

  // Only the window's readings, so x stays inside the box and the summary
  // describes the window the label names.
  const points = given.filter((p) => p.x >= fromMs && p.x <= toMs)
  const windowMs = toMs - fromMs || 1
  const range = yMax - yMin || 1
  const sx = (ms: number): number => INSET + ((ms - fromMs) / windowMs) * (width - 2 * INSET)
  // Clamped: a reading outside the fixed range pins to the edge rather than
  // drawing outside a 16px box.
  const sy = (v: number): number =>
    INSET + (1 - Math.min(1, Math.max(0, (v - yMin) / range))) * (height - 2 * INSET)

  const means = summarize(points.map((p) => p.mean))
  const low = summarize(points.map((p) => p.min ?? p.mean))
  const high = summarize(points.map((p) => p.max ?? p.mean))
  const summary = means
    ? `${label}: mean ${format(means.mean)}, low ${format(low?.min ?? means.min)}, high ${format(high?.max ?? means.max)}`
    : `${label}: no readings`

  const hovered = hover != null && hover < points.length ? points[hover] : null
  const readout = hovered
    ? [
        formatX ? formatX(hovered.x) : null,
        hovered.mean == null
          ? `${label}: no reading`
          : `${label}: ${format(hovered.mean)}` +
            (hovered.min != null && hovered.max != null && hovered.min !== hovered.max
              ? ` (${format(hovered.min)}–${format(hovered.max)})`
              : '')
      ]
        .filter(Boolean)
        .join('\n')
    : summary

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!points.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ms = fromMs + ((e.clientX - rect.left - INSET) / (width - 2 * INSET)) * windowMs
    setHover(
      nearestIndex(
        points.map((p) => p.x),
        ms
      )
    )
  }

  return (
    <Tooltip text={readout}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={summary}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', flex: 'none' }}
      >
        {runs(points).map((run, i) => {
          const hasBand = run.some((p) => p.min != null || p.max != null)
          const mean = run.map((p) => `${sx(p.x)},${sy(p.mean)}`).join(' ')
          return (
            <g key={i}>
              {hasBand && run.length > 1 ? (
                <polygon
                  points={[
                    ...run.map((p) => `${sx(p.x)},${sy(p.max ?? p.mean)}`),
                    ...run
                      .slice()
                      .reverse()
                      .map((p) => `${sx(p.x)},${sy(p.min ?? p.mean)}`)
                  ].join(' ')}
                  style={{ fill: color, fillOpacity: 0.18 }}
                />
              ) : null}
              {run.length > 1 ? (
                <polyline
                  points={mean}
                  fill="none"
                  strokeWidth={1.25}
                  strokeLinejoin="round"
                  style={{ stroke: color }}
                />
              ) : (
                <circle cx={sx(run[0].x)} cy={sy(run[0].mean)} r={1.5} style={{ fill: color }} />
              )}
            </g>
          )
        })}
        {hovered ? (
          <>
            <line
              x1={sx(hovered.x)}
              x2={sx(hovered.x)}
              y1={0}
              y2={height}
              stroke={TOKENS.textFaint}
              strokeWidth={1}
            />
            {hovered.mean != null ? (
              <circle
                cx={sx(hovered.x)}
                cy={sy(hovered.mean)}
                r={2}
                strokeWidth={1}
                style={{ fill: color, stroke: TOKENS.surface }}
              />
            ) : null}
          </>
        ) : null}
        {/* Nothing read yet: a quiet floor line, so the cell reads as empty
            rather than broken. */}
        {!means ? (
          <line
            x1={0}
            x2={width}
            y1={height - INSET}
            y2={height - INSET}
            stroke={TOKENS.border}
            strokeWidth={1}
          />
        ) : null}
      </svg>
    </Tooltip>
  )
}
