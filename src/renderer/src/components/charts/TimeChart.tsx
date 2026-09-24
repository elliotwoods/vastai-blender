/**
 * The app's time chart: History's four views, and the Fleet screen's GPU
 * graphs. Inline SVG on purpose: the renderer's CSP is `script-src 'self'`,
 * so a CDN chart library is out, and bundling one to draw a handful of line
 * and bar plots would cost more than it saves.
 *
 * Drawn in real pixels (measured with a ResizeObserver) rather than a scaled
 * viewBox, so strokes stay 1px and labels stay upright at any panel width.
 *
 * Mark choice follows the data, not taste: `bars` for quantities accumulated
 * *over* a bucket (spend, energy), `line`/`step` for levels sampled *at* an
 * instant (draw, node count, balance, GPU util). Drawing spend as a line would
 * imply a continuous rate it never had.
 *
 * Every series shares the one y axis. A measure in other units (watts beside
 * percent) gets its own chart — two scales on one plot invent a correlation.
 * With two or more series a legend is always drawn, so colour is never the
 * only key, and the hover readout lists every series at the snapped x.
 */

import { Fragment, useMemo, useRef, useState, type CSSProperties } from 'react'
import { mono } from '../../lib/controls'
import { SCALE, TOKENS } from '../../lib/theme'
import {
  barSlot,
  mergeIntervals,
  nearestIndex,
  polylinePoints,
  segments,
  stepHover,
  ticks,
  tooltipLeft,
  unionXs,
  valueAt,
  yDomain,
  type ChartPoint,
  type MarkKind
} from './scale'
import { useWidth } from './useWidth'

export interface TimeSeries {
  /** stable identity — legend isolation and React keys follow it */
  id: string
  /** legend and tooltip text (rendered as text, never markup) */
  label: string
  /** any CSS colour; per-GPU series take `gpuColor(index)` from ./palette */
  color: string
  points: ChartPoint[]
  /**
   * Wash the area under a line or step at 10% — for a part drawn under its
   * whole ("GPUs busy" under "GPUs rented"). Ignored for bars.
   */
  area?: boolean
}

/** A span to shade behind the marks — "GPU idle while a run is assigned". */
export interface TimeBand {
  fromMs: number
  toMs: number
  /** tooltip text while the crosshair is inside it */
  label: string
}

/** A moment worth a tick along the top edge — a chunk dispatched or done. */
export interface TimeMarker {
  atMs: number
  label: string
}

export interface TimeChartProps {
  series: TimeSeries[]
  kind: MarkKind
  /** window bounds (epoch ms) — fixed by the range, not by the data */
  fromMs: number
  toMs: number
  /** bucket width, so bars can be drawn to scale */
  spanMs?: number
  height?: number
  /** y-axis + tooltip value formatting */
  format: (y: number) => string
  formatX: (ms: number) => string
  /** Levels (balance) read better zoomed; quantities must start at zero. */
  baseline?: 'zero' | 'fit'
  /**
   * Pin the top of a `'zero'` axis for a bounded measure — 100 for a
   * percentage, so an idle GPU's 3% sits near the floor instead of filling
   * the plot. Data above it still fits.
   */
  yMax?: number
  /**
   * Extra muted lines under the hovered values — the place for figures
   * derived from the moment rather than any one series (a bucket's energy
   * and its CO2 estimate, the fleet's idle $/h). `values` are in series
   * order, null where a series has no reading at `x`.
   */
  tooltipExtra?: (x: number, values: ReadonlyArray<number | null>) => string[] | null
  /** Shaded spans, drawn behind the marks. Overlaps merge into one wash. */
  bands?: TimeBand[]
  /** The legend's name for the shading ("paid, idle"); no entry without it. */
  bandLabel?: string
  markers?: TimeMarker[]
  /** shown centred when there is nothing to plot */
  emptyNote?: string
}

const PAD = { top: 12, right: 14, bottom: 22, left: 58 }
const GRID_LINES = 4
/** Widest the hover panel gets — also the edge-clamp budget. */
const TOOLTIP_W = 210
/** A band or marker this close to the crosshair (px) is listed in its readout. */
const SNAP_PX = 4
/** How far a series recedes while the legend isolates another. */
const DIM = 0.2

export function TimeChart({
  series,
  kind,
  fromMs,
  toMs,
  spanMs,
  height = 200,
  format,
  formatX,
  baseline = 'zero',
  yMax,
  tooltipExtra,
  bands,
  bandLabel,
  markers,
  emptyNote
}: TimeChartProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const width = useWidth(wrapRef)
  // An index into `xs`, the positions the crosshair snaps to.
  const [hover, setHover] = useState<number | null>(null)
  // Legend emphasis: `pinned` by a click, `peek` while hovered or focused.
  const [pinned, setPinned] = useState<string | null>(null)
  const [peek, setPeek] = useState<string | null>(null)

  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = Math.max(0, height - PAD.top - PAD.bottom)
  const values: number[] = []
  for (const s of series) for (const p of s.points) if (p.y != null) values.push(p.y)
  const empty = values.length === 0
  const multi = series.length > 1

  const { min: yMin, max: yTop } = yDomain(values, baseline, yMax)
  const span = yTop - yMin || 1
  const windowMs = toMs - fromMs || 1

  const sx = (ms: number): number => PAD.left + ((ms - fromMs) / windowMs) * plotW
  const sy = (v: number): number => PAD.top + plotH - ((v - yMin) / span) * plotH
  const floor = PAD.top + plotH

  const yTicks = ticks(yMin, yTop, GRID_LINES)
  const xTicks = ticks(fromMs, toMs, 4)

  const bucketPx = kind === 'bars' && spanMs ? Math.max(1, (spanMs / windowMs) * plotW - 1) : 0

  // Memoised for the hover path: every mousemove re-renders, the data doesn't change.
  const xs = useMemo(() => unionXs(series), [series])
  // Bounds-checked rather than reset in an effect: switching to a shorter range
  // can leave the index past the end, and the next mousemove re-snaps it anyway.
  const hoverX = hover != null && hover < xs.length ? xs[hover] : null
  const hoverValues = hoverX == null ? [] : series.map((s) => valueAt(s.points, hoverX, kind))
  const showHover = hoverX != null && hoverValues.some((v) => v != null)

  // What else sits under the crosshair: a band or marker within half a bucket
  // or a few pixels, whichever is wider — they rarely land on a sample exactly.
  const reach = Math.max((spanMs ?? 0) / 2, plotW > 0 ? (SNAP_PX / plotW) * windowMs : 0)
  const bandsHere =
    hoverX == null
      ? []
      : (bands ?? []).filter((b) => b.fromMs <= hoverX + reach && b.toMs >= hoverX - reach)
  const markersHere =
    hoverX == null ? [] : (markers ?? []).filter((m) => Math.abs(m.atMs - hoverX) <= reach)

  // A pinned series a filter has since removed must not leave the rest dimmed.
  const live = (id: string | null): string | null =>
    id != null && series.some((s) => s.id === id) ? id : null
  const focus = live(peek) ?? live(pinned)
  const dimmed = (id: string): boolean => focus != null && focus !== id

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!xs.length || plotW <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ms = fromMs + ((e.clientX - rect.left - PAD.left) / plotW) * (toMs - fromMs)
    setHover(nearestIndex(xs, ms))
  }

  // The keyboard gets what the pointer gets: focus shows the latest reading,
  // arrows step through the rest.
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>): void => {
    const next = stepHover(e.key, hover, xs.length)
    if (next === undefined) return
    e.preventDefault()
    setHover(next)
  }

  const label: CSSProperties = { ...mono, fontSize: 9, fill: TOKENS.textFaint }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={width || '100%'}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        tabIndex={empty ? undefined : 0}
        onKeyDown={onKey}
        // A click focuses too, after the mousemove already snapped — keep that.
        onFocus={() => setHover((h) => h ?? (xs.length ? xs.length - 1 : null))}
        onBlur={() => setHover(null)}
        style={{ display: 'block' }}
      >
        {yTicks.map((t) => (
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

        {bands?.length
          ? mergeIntervals(bands, fromMs, toMs).map((b) => (
              <rect
                key={b.fromMs}
                x={sx(b.fromMs)}
                y={PAD.top}
                width={Math.max(1, sx(b.toMs) - sx(b.fromMs))}
                height={plotH}
                style={{ fill: TOKENS.warnSoftBg }}
              />
            ))
          : null}

        {empty ? (
          <>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={floor}
              y2={floor}
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
        ) : (
          series.map((s, si) => (
            <Fragment key={s.id}>
              {kind === 'bars'
                ? s.points.map((p) => {
                    if (p.y == null) return null
                    const h = Math.max(p.y > 0 ? 1 : 0, floor - sy(p.y))
                    const slot = barSlot(bucketPx, series.length, si)
                    return (
                      <rect
                        key={p.x}
                        x={sx(p.x) + slot.dx}
                        y={floor - h}
                        width={slot.width}
                        height={h}
                        opacity={dimmed(s.id) ? DIM : 0.85}
                        style={{ fill: s.color }}
                      />
                    )
                  })
                : segments(s.points).map((seg, i) => {
                    const pts = polylinePoints(seg, kind, sx, sy)
                    return (
                      <Fragment key={i}>
                        {s.area ? (
                          <polygon
                            points={`${sx(seg[0].x)},${floor} ${pts} ${sx(seg[seg.length - 1].x)},${floor}`}
                            opacity={dimmed(s.id) ? DIM : 1}
                            style={{ fill: s.color, fillOpacity: 0.1 }}
                          />
                        ) : null}
                        <polyline
                          fill="none"
                          strokeWidth={1.5}
                          strokeLinejoin="round"
                          points={pts}
                          opacity={dimmed(s.id) ? DIM : undefined}
                          style={{ stroke: s.color }}
                        />
                      </Fragment>
                    )
                  })}
            </Fragment>
          ))
        )}

        {markers?.map((m, i) =>
          m.atMs >= fromMs && m.atMs <= toMs ? (
            <line
              key={`${m.atMs}:${i}`}
              x1={sx(m.atMs)}
              x2={sx(m.atMs)}
              y1={PAD.top}
              y2={PAD.top + 5}
              stroke={TOKENS.textMuted}
              strokeWidth={1}
            />
          ) : null
        )}

        {showHover && hoverX != null ? (
          <>
            <line
              x1={sx(hoverX)}
              x2={sx(hoverX)}
              y1={PAD.top}
              y2={floor}
              stroke={TOKENS.playhead}
              strokeWidth={1}
              opacity={0.6}
            />
            {multi ? (
              series.map((s, si) => {
                const v = hoverValues[si]
                return v == null ? null : (
                  <circle
                    key={s.id}
                    cx={sx(hoverX)}
                    cy={sy(v)}
                    r={3}
                    // A ring in the panel colour keeps overlapping dots apart.
                    strokeWidth={1.5}
                    style={{ fill: s.color, stroke: TOKENS.surfaceRaised }}
                  />
                )
              })
            ) : hoverValues[0] != null ? (
              <circle cx={sx(hoverX)} cy={sy(hoverValues[0])} r={3} fill={TOKENS.playhead} />
            ) : null}
          </>
        ) : null}
      </svg>

      {showHover && hoverX != null ? (
        <div
          aria-live="polite"
          style={{
            position: 'absolute',
            // Clamped against the panel's own width so the extra lines can't
            // push it off the right edge.
            left: tooltipLeft(sx(hoverX), width, TOOLTIP_W),
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
          <div style={{ color: TOKENS.textFaint, whiteSpace: 'nowrap' }}>{formatX(hoverX)}</div>
          {multi ? (
            // Value first, name second: the reader has the series and wants
            // the number. Keyed by a short stroke, like the line it names.
            series.map((s, si) => {
              const v = hoverValues[si]
              return (
                <div key={s.id} style={tooltipRow}>
                  <span style={{ ...lineKey(kind), background: s.color }} />
                  <span style={{ ...mono, color: v == null ? TOKENS.textDisabled : TOKENS.text }}>
                    {v == null ? '—' : format(v)}
                  </span>
                  <span
                    style={{
                      color: TOKENS.textMuted,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {s.label}
                  </span>
                </div>
              )
            })
          ) : (
            <div style={{ ...mono, color: TOKENS.text, whiteSpace: 'nowrap' }}>
              {hoverValues[0] != null ? format(hoverValues[0]) : null}
            </div>
          )}
          {bandsHere.map((b, i) => (
            <div key={`b${i}`} style={tooltipRow}>
              <span style={bandKey} />
              <span style={{ color: TOKENS.textSecondary }}>{b.label}</span>
            </div>
          ))}
          {markersHere.map((m, i) => (
            <div key={`m${i}`} style={tooltipRow}>
              <span style={markerKey} />
              <span style={{ color: TOKENS.textSecondary }}>{m.label}</span>
            </div>
          ))}
          {(tooltipExtra?.(hoverX, hoverValues) ?? []).map((line) => (
            <div key={line} style={{ color: TOKENS.textMuted, marginTop: 2 }}>
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {multi || (bandLabel && bands?.length) ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 12px',
            padding: `2px ${PAD.right}px 0 ${PAD.left}px`,
            fontSize: SCALE.textXs
          }}
        >
          {multi
            ? series.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={pinned === s.id}
                  title={pinned === s.id ? 'show all' : `pick out ${s.label}`}
                  // Charts sit inside click-to-expand rows — never toggle the row.
                  onClick={(e) => {
                    e.stopPropagation()
                    setPinned((p) => (p === s.id ? null : s.id))
                  }}
                  onPointerEnter={() => setPeek(s.id)}
                  onPointerLeave={() => setPeek(null)}
                  onFocus={() => setPeek(s.id)}
                  onBlur={() => setPeek(null)}
                  style={{
                    ...tooltipRow,
                    marginTop: 0,
                    padding: 0,
                    cursor: 'pointer',
                    color: dimmed(s.id) ? TOKENS.textFaint : TOKENS.textSecondary
                  }}
                >
                  <span
                    style={{
                      ...lineKey(kind),
                      background: s.color,
                      opacity: dimmed(s.id) ? DIM : 1
                    }}
                  />
                  {s.label}
                </button>
              ))
            : null}
          {bandLabel && bands?.length ? (
            <span style={{ ...tooltipRow, marginTop: 0, color: TOKENS.textSecondary }}>
              <span style={bandKey} />
              {bandLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const tooltipRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 2,
  whiteSpace: 'nowrap'
}

/** Legend and tooltip key: a short stroke for lines, a small block for bars. */
function lineKey(kind: MarkKind): CSSProperties {
  return kind === 'bars'
    ? { width: 8, height: 8, borderRadius: 2, flex: 'none' }
    : { width: 12, height: 2, borderRadius: 1, flex: 'none' }
}

const bandKey: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  flex: 'none',
  background: TOKENS.warnSoftBg,
  border: `1px solid ${TOKENS.warnSoftBorder}`
}

const markerKey: CSSProperties = {
  width: 1,
  height: 8,
  flex: 'none',
  margin: '0 4px',
  background: TOKENS.textMuted
}
