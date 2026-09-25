/**
 * A progress bar that says what state the work is in, not only how far along:
 *
 *   queued     the track alone
 *   active     lime, with a stripe moving through it
 *   complete   solid green, still
 *   failed     what finished in muted green, what failed in red
 *   cancelled  what finished in grey, what the cancel stopped hatched
 *   held       amber: waiting for the user (the retry breaker, a bad scene)
 *
 * Given `segments` (segmentsFromChunks) it draws each chunk where it sits in
 * the job, weighted by frames; otherwise done, failed and cancelled frames
 * stack from the left. `ticks` marks every frame once each gets 3 px, or
 * every chunk boundary once the chunks do (tickPlan), so a short job's bar
 * reads as countable steps. Each time `done` grows the new part flashes
 * (useGrowPulse), so a frame arriving is seen, not only a bar a pixel longer.
 *
 * Motion lives in styles/base.css (.vr-progress-live, .vr-progress-pulse,
 * .vr-progress-hatch) and stops under prefers-reduced-motion.
 */

import { useRef, type CSSProperties } from 'react'
import { STATUS_VARS, TOKENS } from '../lib/theme'
import { useWidth } from './charts/useWidth'
import {
  mergeSegments,
  tickPlan,
  type ProgressBarState,
  type ProgressSegment
} from './progressSegments'
import { useGrowPulse } from './useGrowPulse'

export type { ProgressBarState, ProgressSegment }

export interface ProgressBarProps {
  /** frames (or any unit) in all */
  total: number
  /** of those, done */
  done: number
  /** failed, not done; drawn after the done ones (ignored with `segments`) */
  failed?: number
  /** stopped by a cancel, not done (ignored with `segments`) */
  cancelled?: number
  state: ProgressBarState
  /** per-chunk stretches (segmentsFromChunks); their frames should sum to `total` */
  segments?: readonly ProgressSegment[]
  /** px; default 4 */
  height?: number
  /** what the bar measures, for screen readers and the tooltip: "frames of shot_010" */
  label?: string
  /** mark each frame, or each chunk, when there is room (tickPlan) */
  ticks?: boolean
  style?: CSSProperties
}

/** The colour of done work, by the bar's state. */
const DONE_FILL: Record<ProgressBarState, string> = {
  queued: TOKENS.borderStrong,
  active: TOKENS.accent,
  complete: STATUS_VARS.done.fill,
  failed: `color-mix(in srgb, ${STATUS_VARS.done.fill} 55%, ${TOKENS.border})`,
  cancelled: `color-mix(in srgb, ${TOKENS.textMuted} 55%, ${TOKENS.border})`,
  held: TOKENS.warn
}

const FAILED_FILL = STATUS_VARS.error.fill
/** A tick is a thin cut through the fill, in the page's colour. */
const TICK = `color-mix(in srgb, ${TOKENS.surface} 75%, transparent)`

function pct(n: number, total: number): string {
  return `${total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)) : 0}%`
}

const fill: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  transition: 'left 400ms ease-out, width 400ms ease-out'
}

/** A stretch of failed or cancelled frames stays visible however few they are. */
const SLIVER = 2

function Remainder({
  tone,
  left,
  width
}: {
  tone: 'failed' | 'cancelled' | 'working'
  left: string
  width: string
}): React.JSX.Element {
  if (tone === 'cancelled') {
    return (
      <div
        className="vr-progress-hatch"
        data-part="cancelled"
        style={{ ...fill, left, width, minWidth: SLIVER }}
      />
    )
  }
  if (tone === 'failed') {
    return (
      <div
        data-part="failed"
        style={{ ...fill, left, width, minWidth: SLIVER, backgroundColor: FAILED_FILL }}
      />
    )
  }
  return (
    <div
      data-part="working"
      style={{ ...fill, left, width, backgroundColor: TOKENS.accentSoftBg }}
    />
  )
}

export function ProgressBar({
  total,
  done,
  failed = 0,
  cancelled = 0,
  state,
  segments,
  height = 4,
  label,
  ticks = false,
  style
}: ProgressBarProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const width = useWidth(trackRef)
  const pulse = useGrowPulse(done)

  const safeTotal = Math.max(0, total)
  const safeDone = Math.max(0, Math.min(safeTotal, done))
  const live = state === 'active'
  const doneFill = DONE_FILL[state]
  const radius = Math.min(height / 2, 3)
  const plan = ticks ? tickPlan(width, safeTotal, segments) : ({ kind: 'none' } as const)

  const parts: React.JSX.Element[] = []
  if (segments && segments.length > 0) {
    for (const [i, s] of mergeSegments(segments).entries()) {
      const left = pct(s.start, safeTotal)
      const doneW = pct(s.done, safeTotal)
      if (s.done > 0) {
        parts.push(
          <div
            key={`d${i}`}
            data-part="done"
            className={live && s.tone === 'working' ? 'vr-progress-live' : undefined}
            style={{ ...fill, left, width: doneW, backgroundColor: doneFill }}
          />
        )
      }
      const rest = s.frames - s.done
      if (rest > 0 && s.tone !== 'queued' && s.tone !== 'done') {
        parts.push(
          <Remainder
            key={`r${i}`}
            tone={s.tone}
            left={pct(s.start + s.done, safeTotal)}
            width={pct(rest, safeTotal)}
          />
        )
      }
    }
  } else {
    const f = Math.max(0, Math.min(safeTotal - safeDone, failed))
    const c = Math.max(0, Math.min(safeTotal - safeDone - f, cancelled))
    if (safeDone > 0) {
      parts.push(
        <div
          key="done"
          data-part="done"
          className={live ? 'vr-progress-live' : undefined}
          style={{ ...fill, left: 0, width: pct(safeDone, safeTotal), backgroundColor: doneFill }}
        />
      )
    }
    if (f > 0) {
      parts.push(
        <Remainder
          key="failed"
          tone="failed"
          left={pct(safeDone, safeTotal)}
          width={pct(f, safeTotal)}
        />
      )
    }
    if (c > 0) {
      parts.push(
        <Remainder
          key="cancelled"
          tone="cancelled"
          left={pct(safeDone + f, safeTotal)}
          width={pct(c, safeTotal)}
        />
      )
    }
  }

  // The flash covers what just arrived, at least a few px so one frame of
  // thousands still shows; with segments the growth is spread over chunks,
  // so the whole bar glows instead.
  const pulseStyle: CSSProperties | null =
    pulse.gen === 0 || state === 'queued'
      ? null
      : segments && segments.length > 0
        ? { left: 0, right: 0 }
        : {
            right: `calc(100% - ${pct(pulse.to, safeTotal)})`,
            width: `max(6px, ${pct(pulse.to - pulse.from, safeTotal)})`
          }

  const valueText = [
    `${safeDone.toLocaleString()} of ${safeTotal.toLocaleString()} done`,
    failed > 0 && !segments ? `${failed.toLocaleString()} failed` : null,
    cancelled > 0 && !segments ? `${cancelled.toLocaleString()} cancelled` : null,
    state === 'held' ? 'held' : null
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-valuenow={safeDone}
      aria-valuetext={valueText}
      data-state={state}
      title={label ? `${label}: ${valueText}` : undefined}
      style={{ position: 'relative', width: '100%', height, ...style }}
    >
      <div
        ref={trackRef}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          borderRadius: radius,
          background: TOKENS.border
        }}
      >
        {parts}
        {plan.kind === 'frames' ? (
          <div
            data-ticks="frames"
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `linear-gradient(to right, ${TICK} 0 1px, transparent 1px)`,
              backgroundSize: `${100 / plan.total}% 100%`,
              pointerEvents: 'none'
            }}
          />
        ) : plan.kind === 'chunks' ? (
          plan.at.map((f, i) => (
            <div
              key={`t${i}`}
              data-ticks="chunks"
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${f * 100}%`,
                width: 1,
                background: TICK,
                pointerEvents: 'none'
              }}
            />
          ))
        ) : null}
      </div>
      {pulseStyle ? (
        <div
          key={pulse.gen}
          className="vr-progress-pulse"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            borderRadius: radius,
            pointerEvents: 'none',
            ...pulseStyle,
            // the glow takes the colour of what grew
            ...({ '--vr-progress-pulse': doneFill } as CSSProperties)
          }}
        />
      ) : null}
    </div>
  )
}
