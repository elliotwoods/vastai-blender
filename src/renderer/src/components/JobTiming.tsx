/**
 * A job's time in one line: "elapsed 1h 02m · 14m left · ETA 14:32" while it
 * renders, "took 1h 02m · finished 14:32" once done, "queued" before it
 * starts. Words in the sans face and faint, figures in mono and brighter, the
 * ETA (or the finish time) brightest, so a column of rows reads down its
 * figures. The wording is jobTimingView's; this lays it out.
 *
 * It ticks once a second only while the job is live (useNow), projecting
 * main's figures forward; a finished job's line never re-renders on its own.
 * `compact` is the Jobs row's: the time left and the ETA, or how long it took.
 */

import { Fragment, type CSSProperties } from 'react'
import { isLiveJob } from '../../../shared/jobTiming'
import { mono } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import { useNow } from '../lib/useNow'
import { jobTimingView, type JobTimingJob, type TimingPart } from './jobTimingView'

export interface JobTimingProps {
  job: JobTimingJob
  compact?: boolean
  style?: CSSProperties
}

const sep: CSSProperties = { color: TOKENS.textFaint, padding: `0 ${SCALE.space1}` }
const word: CSSProperties = { color: TOKENS.textFaint }

function Part({ part }: { part: TimingPart }): React.JSX.Element {
  if (part.muted) {
    return <span style={{ color: TOKENS.textMuted, fontStyle: 'italic' }}>{part.value}</span>
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.3em' }}>
      {part.label ? <span style={word}>{part.label}</span> : null}
      {part.value ? (
        <span
          style={{
            ...mono,
            color: part.emphasis ? TOKENS.text : TOKENS.textSecondary,
            fontWeight: part.emphasis ? SCALE.weightMedium : undefined
          }}
        >
          {part.value}
        </span>
      ) : null}
      {part.after ? <span style={word}>{part.after}</span> : null}
    </span>
  )
}

export function JobTiming({
  job,
  compact = false,
  style
}: JobTimingProps): React.JSX.Element | null {
  const now = useNow(1000, isLiveJob(job.state))
  const view = jobTimingView(job, now, compact)
  if (view.parts.length === 0) return null
  return (
    <span
      data-timing={view.kind}
      title={view.title}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        flexWrap: 'nowrap',
        whiteSpace: 'nowrap',
        minWidth: 0,
        fontSize: compact ? SCALE.textXs : SCALE.textSm,
        lineHeight: SCALE.leadingTight,
        ...style
      }}
    >
      {view.parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden="true" style={sep}>
              ·
            </span>
          ) : null}
          <Part part={p} />
        </Fragment>
      ))}
    </span>
  )
}
