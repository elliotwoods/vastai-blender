/**
 * One job in the Jobs list, left to right:
 *
 *   grip · thumbnail · name, chips, bar and time · state · frames · cost ·
 *   submitted · open output · (unlink) · trash
 *
 * The grip is there only while the job is in the queue (queued or running):
 * a finished job has no place to move to. Alt+↑ / Alt+↓ on a focused row
 * does what dragging does, from the keyboard. The whole row opens the job;
 * every button in it stops its click reaching the row.
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { isLiveJob } from '../../../../shared/jobTiming'
import type { JobState, JobSummary } from '../../../../shared/models'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Icon } from '../../components/Icon'
import { JobTiming } from '../../components/JobTiming'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import { ProgressBar } from '../../components/ProgressBar'
import { barStateOf } from '../../components/progressSegments'
import { chip, iconBtn, mono, statusDot, tableRow, type ChipTone } from '../../lib/controls'
import { basename, fmtFrames, fmtMoney, fmtTimeAgo } from '../../lib/format'
import { useNav } from '../../lib/nav'
import { useCancelJob, useRemoveJob } from '../../lib/queries'
import { ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS, type StatusTone } from '../../lib/theme'
import type { ThumbState } from '../../media/Thumb'
import { Thumb } from '../../media/Thumb'

export const THUMB_W = 64
export const THUMB_H = 36
/** the grip's column, kept on finished rows too so the thumbnails line up */
const GRIP_W = 18
const ICON_W = 26

const smallChip: CSSProperties = {
  textTransform: 'uppercase',
  fontSize: 'var(--text-2xs)',
  padding: '1px 7px',
  letterSpacing: '0.04em'
}

/** A job's state as its chip shows it: a dot in the status palette, the word. */
function stateLook(job: JobSummary): { word: string; tone: StatusTone; chip: ChipTone } {
  if (job.attention && isLiveJob(job.state)) return { word: 'held', tone: 'queued', chip: 'warn' }
  const by: Record<JobState, { word: string; tone: StatusTone; chip: ChipTone }> = {
    queued: { word: 'queued', tone: 'queued', chip: 'neutral' },
    running: { word: 'running', tone: 'running', chip: 'neutral' },
    complete: { word: 'complete', tone: 'done', chip: 'neutral' },
    partial: { word: 'partial', tone: 'error', chip: 'warn' },
    failed: { word: 'failed', tone: 'error', chip: 'danger' },
    cancelled: { word: 'cancelled', tone: 'dead', chip: 'neutral' }
  }
  return by[job.state] ?? { word: job.state, tone: 'queued', chip: 'neutral' }
}

export function StateChip({ job }: { job: JobSummary }): React.JSX.Element {
  const look = stateLook(job)
  return (
    <span
      data-state-chip={job.state}
      title={job.attention?.message ?? undefined}
      style={{
        ...chip({ tone: look.chip }),
        fontSize: SCALE.textXs,
        padding: '2px 8px',
        ...(job.state === 'cancelled' ? { color: TOKENS.textMuted } : null)
      }}
    >
      <span style={{ ...statusDot(look.tone), width: 7, height: 7 }} />
      {look.word}
    </span>
  )
}

/** What the thumbnail's placeholder says while a job has no preview yet. */
function thumbState(job: JobSummary): ThumbState | undefined {
  switch (job.state) {
    case 'running':
      return 'rendering'
    case 'queued':
      return 'pending'
    case 'failed':
    case 'partial':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

/**
 * The row's trash: a live job is cancelled (its frames so far are kept), a
 * finished one leaves the list (its files stay on disk). Both ask first.
 */
export function JobTrashButton({
  job,
  onError
}: {
  job: JobSummary
  onError: (text: string) => void
}): React.JSX.Element {
  const cancel = useCancelJob()
  const remove = useRemoveJob()
  const live = isLiveJob(job.state)
  return live ? (
    <ConfirmButton
      icon="trash"
      iconOnly
      label="cancel job"
      confirmLabel="cancel job?"
      title="Cancel this job: its unfinished chunks stop; frames already downloaded are kept"
      onConfirm={() =>
        cancel.mutateAsync(job.id).catch((e: unknown) => onError(`cancel: ${ipcErrorText(e)}`))
      }
    />
  ) : (
    <ConfirmButton
      icon="trash"
      iconOnly
      variant="default"
      label="remove from list"
      confirmLabel="remove from list?"
      title="Remove from the list. The rendered files are kept on disk"
      onConfirm={() =>
        remove.mutateAsync(job.id).catch((e: unknown) => onError(`remove: ${ipcErrorText(e)}`))
      }
    />
  )
}

export interface JobRowProps {
  job: JobSummary
  /** a grip's pointerdown: starts a drag (live jobs only) */
  onGripPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void
  /** Alt+↑ / Alt+↓ */
  onKeyMove?: (dir: 'up' | 'down') => void
  /** .vr-drop-before / -after / -group while a drag hovers this row */
  dropClassName?: string
  /** this row is the one being dragged */
  lifted?: boolean
  /** its place in a group block, for the drag's hit test */
  block?: { index: number; size: number }
  /** a member of a group: leave it */
  onUngroup?: () => void
  onError: (text: string) => void
}

export function JobRow({
  job,
  onGripPointerDown,
  onKeyMove,
  dropClassName,
  lifted = false,
  block,
  onUngroup,
  onError
}: JobRowProps): React.JSX.Element {
  const { navigate } = useNav()
  const live = isLiveJob(job.state)
  const name = job.name || basename(job.blendPath)
  // tableRow's transparent background would sit over .vr-drop-group's.
  const { background: _bg, ...rowBase } = tableRow({ clickable: true })
  void _bg
  const open = (): void => navigate({ screen: 'job', jobId: job.id })

  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={`${name}, ${stateLook(job).word}`}
      data-job-row={job.id}
      data-live={live || undefined}
      data-block-index={block?.index}
      data-block-size={block?.size}
      className={['vr-job-row', dropClassName].filter(Boolean).join(' ')}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') {
          e.preventDefault()
          open()
        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onKeyMove) {
          e.preventDefault()
          onKeyMove(e.key === 'ArrowUp' ? 'up' : 'down')
        }
      }}
      style={{
        ...rowBase,
        gap: SCALE.space3,
        padding: '8px 12px 8px 6px',
        opacity: lifted ? 0.35 : 1
      }}
    >
      <span style={{ width: GRIP_W, flexShrink: 0, display: 'inline-flex' }}>
        {live && onGripPointerDown ? (
          <span
            data-grip
            role="button"
            aria-label={`Drag to reorder ${name} (or Alt+↑ / Alt+↓)`}
            title="Drag to reorder; drop on a job's middle to share its priority"
            onPointerDown={onGripPointerDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: GRIP_W,
              height: THUMB_H,
              color: TOKENS.textFaint,
              cursor: lifted ? 'grabbing' : 'grab',
              touchAction: 'none'
            }}
          >
            <Icon name="grip" size={14} />
          </span>
        ) : null}
      </span>

      <Thumb
        url={job.thumbUrl}
        width={THUMB_W}
        height={THUMB_H}
        state={job.thumbUrl ? undefined : thumbState(job)}
        title={job.thumbUrl ? `latest frame of ${name}` : undefined}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2, minWidth: 0 }}>
          <span
            title={name}
            style={{
              fontWeight: SCALE.weightSemibold,
              fontSize: SCALE.textSm,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {name}
          </span>
          <span style={{ ...chip({ tone: 'accent' }), ...smallChip }}>{job.engine}</span>
          {job.shareNode ? (
            <span
              style={{ ...chip({ tone: 'neutral' }), ...smallChip }}
              title="May run alongside other renders on one node"
            >
              shared node
            </span>
          ) : null}
          {live && job.groupId && !block ? (
            <span
              data-group-chip
              style={{ ...chip({ tone: 'neutral' }), ...smallChip }}
              title="Shares its place in the queue with the other jobs in its group"
            >
              <Icon name="link" size={10} />
              grouped
            </span>
          ) : null}
          <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint, flexShrink: 0 }}>
            {job.frameStart}–{job.frameEnd}
            {job.frameStep > 1 ? ` ×${job.frameStep}` : ''}
          </span>
        </div>
        <ProgressBar
          done={job.framesDone}
          total={job.framesTotal}
          cancelled={job.framesCancelled}
          state={barStateOf(job)}
          label={`frames of ${name}`}
          height={5}
          ticks
        />
        <div style={{ display: 'flex', minWidth: 0, overflow: 'hidden', height: 16 }}>
          <JobTiming job={job} style={{ fontSize: SCALE.textXs }} />
        </div>
      </div>

      <span style={{ width: 96, flexShrink: 0, display: 'inline-flex' }}>
        <StateChip job={job} />
      </span>
      <span
        style={{ ...mono, width: 96, flexShrink: 0, fontSize: SCALE.textSm, textAlign: 'right' }}
        title={
          job.framesCancelled > 0
            ? `${job.framesCancelled.toLocaleString()} frames cancelled`
            : undefined
        }
      >
        {fmtFrames(job.framesDone, job.framesTotal)}
      </span>
      <span
        style={{ ...mono, width: 60, flexShrink: 0, fontSize: SCALE.textSm, textAlign: 'right' }}
      >
        {fmtMoney(job.costSoFar)}
      </span>
      <span
        title={new Date(job.submittedAt).toLocaleString()}
        style={{
          ...mono,
          width: 72,
          flexShrink: 0,
          fontSize: SCALE.textXs,
          color: TOKENS.textFaint,
          textAlign: 'right'
        }}
      >
        {fmtTimeAgo(job.submittedAt)}
      </span>

      <span style={{ display: 'inline-flex', gap: SCALE.space1, flexShrink: 0 }}>
        <OpenInExplorerButton path={job.outputDir} mode="open" title="Open output folder" />
        {onUngroup ? (
          <button
            type="button"
            aria-label={`Take ${name} out of its group`}
            title="Take out of the group: it gets its own place in the queue, just after"
            onClick={(e) => {
              e.stopPropagation()
              onUngroup()
            }}
            style={iconBtn({ size: 'sm' })}
          >
            <Icon name="unlink" size={13} />
          </button>
        ) : (
          <span aria-hidden="true" style={{ width: ICON_W }} />
        )}
        <JobTrashButton job={job} onError={onError} />
      </span>
    </div>
  )
}
