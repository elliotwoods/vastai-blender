/**
 * The one chart in the app. Inline SVG on purpose: the renderer's CSP is
 * `script-src 'self'`, so a CDN chart library is out, and bundling one to draw
 * four single-series plots would cost more than it saves.
 *
 * Drawn in real pixels (measured with a ResizeObserver) rather than a scaled
 * viewBox, so strokes stay 1px and labels stay upright at any panel width.
 *
 * Mark choice follows the data, not taste: `bars` for quantities accumulated
 * *over* a bucket (spend, energy), `line`/`step` for levels sampled *at* an
 * instant (draw, node count, balance). Drawing spend as a line would imply a
 * continuous rate it never had.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { mono } from '../../lib/controls'
import { SCALE, TOKENS } from '../../lib/theme'

export type MarkKind = 'bars' | 'line' | 'step'

export interface ChartPoint {
  /** epoch ms */
  x: number
  /** null = not sampled; breaks the line rather than reading as zero */
  y: number | null
}

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

const PAD = { top: 12, right: 14, bottom: 22, left: 58 }
const GRID_LINES = 4
/** Widest the hover panel gets — also the edge-clamp budget. */
const TOOLTIP_W = 210

/** Container width in px; 0 until the first measurement. */
function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/**
 * "Nice" axis maximum — round up to 1/2/5 × 10ⁿ so gridline labels land on
 * readable numbers instead of $0.0731.
 */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  const norm = v / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/** Split on nulls so a gap in sampling becomes a gap in the line. */
function segments(points: ChartPoint[]): Array<Array<{ x: number; y: number }>> {
  const out: Array<Array<{ x: number; y: number }>> = []
  let run: Array<{ x: number; y: number }> = []
  for (const p of points) {
    if (p.y == null) {
      if (run.length) out.push(run)
      run = []
    } else {
      run.push({ x: p.x, y: p.y })
    }
  }
  if (run.length) out.push(run)
  return out
}

export function Chart({
  points,
  kind,
  fromMs,
  toMs,
  spanMs,
  color = TOKENS.accent,
  height = 200,
  format,
  formatX,
  baseline = 'zero',
  tooltipExtra,
  emptyNote
}: ChartProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const width = useWidth(wrapRef)
  const [hover, setHover] = useState<number | null>(null)

  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = Math.max(0, height - PAD.top - PAD.bottom)
  const real = points.filter((p) => p.y != null) as Array<{ x: number; y: number }>
  const empty = real.length === 0

  const rawMax = empty ? 0 : Math.max(...real.map((p) => p.y))
  const rawMin = empty ? 0 : Math.min(...real.map((p) => p.y))
  // 'fit' still leaves headroom, and never collapses to a zero-height band when
  // the value never moved (a flat balance is a valid, and common, story).
  const yMin = baseline === 'fit' ? (rawMin === rawMax ? rawMin - 1 : rawMin) : 0
  const yMax = baseline === 'fit' ? (rawMin === rawMax ? rawMax + 1 : rawMax) : niceCeil(rawMax)
  const span = yMax - yMin || 1

  const sx = (ms: number): number => PAD.left + ((ms - fromMs) / (toMs - fromMs || 1)) * plotW
  const sy = (v: number): number => PAD.top + plotH - ((v - yMin) / span) * plotH

  const ticks = Array.from({ length: GRID_LINES + 1 }, (_, i) => yMin + (span * i) / GRID_LINES)
  const xTicks = Array.from({ length: 5 }, (_, i) => fromMs + ((toMs - fromMs) * i) / 4)

  const barW =
    kind === 'bars' && spanMs ? Math.max(1, (spanMs / (toMs - fromMs || 1)) * plotW - 1) : 0

  // Bounds-checked rather than reset in an effect: switching to a shorter range
  // can leave the index past the end, and the next mousemove re-snaps it anyway.
  const hovered = hover != null && hover < points.length ? points[hover] : null

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!points.length || plotW <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ms = fromMs + ((e.clientX - rect.left - PAD.left) / plotW) * (toMs - fromMs)
    // Nearest point wins — with sparse balance readings the bucket a pixel
    // falls in is often empty, and snapping beats showing nothing.
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].x - ms)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setHover(best)
  }

  const label: CSSProperties = { ...mono, fontSize: 9, fill: TOKENS.textFaint }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={width || '100%'}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block' }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={sy(t)}
              y2={sy(t)}
              stroke={TOKENS.border}
              strokeWidth={1}
            />
            <text x={PAD.left - 8} y={sy(t) + 3} textAnchor="end" style={label}>
              {format(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={t}
            x={sx(t)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            style={label}
          >
            {formatX(t)}
          </text>
        ))}

        {empty ? (
          <>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={PAD.top + plotH}
              y2={PAD.top + plotH}
              stroke={TOKENS.borderStrong}
              strokeDasharray="3 4"
            />
            {emptyNote ? (
              <text
                x={PAD.left + plotW / 2}
                y={PAD.top + plotH / 2}
                textAnchor="middle"
                style={{ fontSize: SCALE.textSm, fill: TOKENS.textDisabled }}
              >
                {emptyNote}
              </text>
            ) : null}
          </>
        ) : kind === 'bars' ? (
          real.map((p) => {
            const h = Math.max(p.y > 0 ? 1 : 0, PAD.top + plotH - sy(p.y))
            return (
              <rect
                key={p.x}
                x={sx(p.x)}
                y={PAD.top + plotH - h}
                width={barW}
                height={h}
                fill={color}
                opacity={0.85}
              />
            )
          })
        ) : (
          segments(points).map((seg, i) => (
            <polyline
              key={i}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              points={seg
                .flatMap((p, j) =>
                  // A step series holds its value until the next reading — draw
                  // the horizontal run before the vertical jump.
                  kind === 'step' && j > 0
                    ? [`${sx(p.x)},${sy(seg[j - 1].y)}`, `${sx(p.x)},${sy(p.y)}`]
                    : [`${sx(p.x)},${sy(p.y)}`]
                )
                .join(' ')}
            />
          ))
        )}

        {hovered && hovered.y != null ? (
          <>
            <line
              x1={sx(hovered.x)}
              x2={sx(hovered.x)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke={TOKENS.playhead}
              strokeWidth={1}
              opacity={0.6}
            />
            <circle cx={sx(hovered.x)} cy={sy(hovered.y)} r={3} fill={TOKENS.playhead} />
          </>
        ) : null}
      </svg>

      {hovered && hovered.y != null ? (
        <div
          style={{
            position: 'absolute',
            // Clamped against the panel's own width so the extra lines can't
            // push it off the right edge.
            left: Math.min(Math.max(sx(hovered.x) + 10, 0), Math.max(0, width - TOOLTIP_W - 8)),
            top: 6,
            pointerEvents: 'none',
            maxWidth: TOOLTIP_W,
            background: TOKENS.surfaceOverlay,
            border: `1px solid ${TOKENS.border}`,
            borderRadius: SCALE.radiusSm,
            padding: '4px 8px',
            fontSize: SCALE.textXs,
            boxShadow: TOKENS.shadowPopover
          }}
        >
          <div style={{ color: TOKENS.textFaint, whiteSpace: 'nowrap' }}>{formatX(hovered.x)}</div>
          <div style={{ ...mono, color: TOKENS.text, whiteSpace: 'nowrap' }}>
            {format(hovered.y)}
          </div>
          {(tooltipExtra?.({ x: hovered.x, y: hovered.y }) ?? []).map((line) => (
            <div key={line} style={{ color: TOKENS.textMuted, marginTop: 2 }}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
