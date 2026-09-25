/**
 * Every job down the left of the job detail view, when the window is wide
 * enough (the screen decides), so moving between jobs is one click rather
 * than back to the list and in again. Each entry is a thumbnail, the name,
 * a thin progress bar and a state dot; the job on screen is highlighted and
 * scrolled into view. It folds to a narrow rail, remembered across launches.
 * Alt+↑/↓ hops to the previous or next job from anywhere on the screen
 * (JobDetailScreen), in this order.
 */

import { useEffect, useRef } from 'react'
import { Icon } from '../../components/Icon'
import { ProgressBar } from '../../components/ProgressBar'
import { barStateOf } from '../../components/progressSegments'
import { iconBtn, sectionLabel, statusDot, tableRow } from '../../lib/controls'
import { basename } from '../../lib/format'
import { SCALE, TOKENS } from '../../lib/theme'
import { Thumb } from '../../media/Thumb'
import type { JobSummary } from '../../../../shared/models'
import { jobTone } from './jobDetailModel'

export const SIDEBAR_WIDTH = 260
const RAIL_WIDTH = 36

function Entry({
  job,
  current,
  onOpen
}: {
  job: JobSummary
  current: boolean
  onOpen: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [current])
  const name = job.name || basename(job.blendPath)
  return (
    <button
      ref={ref}
      type="button"
      aria-current={current ? 'page' : undefined}
      onClick={onOpen}
      title={`${name} · ${job.state}`}
      style={{
        ...tableRow({ selected: current, clickable: true }),
        gap: SCALE.space2,
        padding: '6px 10px',
        width: '100%',
        border: 'none',
        borderBottom: `1px solid ${TOKENS.border}`,
        boxShadow: current ? `inset 2px 0 0 ${TOKENS.accent}` : undefined,
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit'
      }}
    >
      <Thumb url={job.thumbUrl} width={48} height={27} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: SCALE.textSm,
              color: current ? TOKENS.text : TOKENS.textSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {name}
          </span>
          <span aria-label={job.state} title={job.state} style={statusDot(jobTone(job))} />
        </span>
        <ProgressBar
          total={job.framesTotal}
          done={job.framesDone}
          cancelled={job.framesCancelled}
          failed={
            job.state === 'failed' || job.state === 'partial'
              ? Math.max(0, job.framesTotal - job.framesDone - job.framesCancelled)
              : 0
          }
          state={barStateOf(job)}
          height={3}
        />
      </span>
    </button>
  )
}

export function JobsSidebar({
  jobs,
  currentId,
  open,
  onToggle,
  onOpen
}: {
  /** in sidebar order (sidebarOrder) */
  jobs: readonly JobSummary[]
  currentId: string
  open: boolean
  onToggle: () => void
  onOpen: (jobId: string) => void
}): React.JSX.Element {
  if (!open) {
    return (
      <aside
        aria-label="jobs"
        style={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          borderRight: `1px solid ${TOKENS.border}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: SCALE.space2
        }}
      >
        <button
          type="button"
          title="Show the jobs list"
          aria-label="Show the jobs list"
          aria-expanded={false}
          onClick={onToggle}
          style={iconBtn({ size: 'sm' })}
        >
          <Icon name="list" size={13} />
        </button>
      </aside>
    )
  }
  return (
    <aside
      aria-label="jobs"
      style={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        borderRight: `1px solid ${TOKENS.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space2,
          padding: `${SCALE.space2} ${SCALE.space2} ${SCALE.space2} 10px`,
          borderBottom: `1px solid ${TOKENS.border}`
        }}
      >
        <span style={sectionLabel()}>jobs</span>
        <span style={{ fontSize: 'var(--text-2xs)', color: TOKENS.textFaint }}>
          {jobs.length} · alt ↑↓
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          title="Hide the jobs list"
          aria-label="Hide the jobs list"
          aria-expanded
          onClick={onToggle}
          style={iconBtn({ size: 'sm' })}
        >
          <Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>
      <nav style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {jobs.map((j) => (
          <Entry key={j.id} job={j} current={j.id === currentId} onOpen={() => onOpen(j.id)} />
        ))}
        {jobs.length === 0 ? (
          <span
            style={{
              display: 'block',
              padding: SCALE.space3,
              fontSize: SCALE.textXs,
              color: TOKENS.textFaint
            }}
          >
            No jobs.
          </span>
        ) : null}
      </nav>
    </aside>
  )
}
