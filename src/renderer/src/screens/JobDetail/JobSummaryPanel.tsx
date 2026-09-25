/**
 * The job at a glance: its bar, every chunk where it sits in the frame range
 * (segmentsFromChunks, the same segments the filmstrip's minimap is drawn
 * from), with live rendered counts folded in; its time (JobTiming: elapsed,
 * time left and ETA while it renders, how long it took once done); and its
 * chunks counted, failed and cancelled apart.
 */

import { JobTiming } from '../../components/JobTiming'
import { ProgressBar } from '../../components/ProgressBar'
import {
  barStateOf,
  type ProgressSegment,
  type SegmentTotals
} from '../../components/progressSegments'
import { mono, panel } from '../../lib/controls'
import { fmtMoney } from '../../lib/format'
import { SCALE, STATUS_VARS, TOKENS } from '../../lib/theme'
import type { JobDetail } from '../../../../shared/models'
import { chunkCounts } from './jobDetailModel'

function Count({ n, word, color }: { n: number; word: string; color?: string }): React.JSX.Element {
  return (
    <span data-count={word} style={{ whiteSpace: 'nowrap' }}>
      <span style={{ ...mono, color: n > 0 && color ? color : TOKENS.textSecondary }}>{n}</span>{' '}
      <span style={{ color: TOKENS.textFaint }}>{word}</span>
    </span>
  )
}

const dot = (
  <span aria-hidden="true" style={{ color: TOKENS.textFaint }}>
    ·
  </span>
)

export function JobSummaryPanel({
  job,
  segments,
  totals
}: {
  job: JobDetail
  segments: readonly ProgressSegment[]
  totals: SegmentTotals
}): React.JSX.Element {
  const n = chunkCounts(job.chunks)
  const pct = totals.total > 0 ? Math.floor((totals.done / totals.total) * 100) : 0
  return (
    <div
      style={{
        ...panel(),
        padding: SCALE.space3,
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: `4px ${SCALE.space4}`
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              ...mono,
              fontSize: SCALE.textLg,
              color: TOKENS.text,
              fontWeight: SCALE.weightMedium
            }}
          >
            {pct}%
          </span>
          <span style={{ fontSize: SCALE.textSm, color: TOKENS.textFaint }}>
            <span style={{ ...mono, color: TOKENS.textSecondary }}>
              {totals.done.toLocaleString()}
            </span>{' '}
            of <span style={mono}>{totals.total.toLocaleString()}</span> frames
          </span>
        </span>
        <JobTiming job={job} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: SCALE.textSm, color: TOKENS.textFaint }}>
          <span style={{ ...mono, color: TOKENS.textSecondary }}>{fmtMoney(job.costSoFar)}</span> so
          far
        </span>
      </div>
      <ProgressBar
        total={totals.total}
        done={totals.done}
        segments={segments}
        state={barStateOf(job)}
        height={8}
        ticks
        label={`frames of ${job.name}`}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: SCALE.space2,
          fontSize: SCALE.textSm
        }}
      >
        <span style={{ color: TOKENS.textFaint }}>chunks</span>
        <Count n={n.complete} word="complete" />
        {dot}
        <Count n={n.failed} word="failed" color={STATUS_VARS.error.text} />
        {dot}
        <Count n={n.cancelled} word="cancelled" />
        {n.active > 0 ? (
          <>
            {dot}
            <Count n={n.active} word="active" color={TOKENS.accent} />
          </>
        ) : null}
        {n.queued > 0 ? (
          <>
            {dot}
            <Count n={n.queued} word="queued" />
          </>
        ) : null}
        {totals.failed + totals.cancelled > 0 ? (
          <span style={{ marginLeft: 'auto', color: TOKENS.textFaint, fontSize: SCALE.textXs }}>
            {[
              totals.failed > 0 ? `${totals.failed} frames failed` : null,
              totals.cancelled > 0 ? `${totals.cancelled} frames cancelled` : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
      </div>
    </div>
  )
}
