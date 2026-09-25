/**
 * The Jobs list: the render queue on top in the order it will render (drag a
 * grip, or Alt+↑ / Alt+↓, to reorder; drop on a job's middle to share its
 * priority), then the finished jobs, newest first.
 *
 * A group, jobs sharing one place in the queue, is drawn as one block with
 * an accent bar down its left edge; each member's unlink button takes it
 * out. The order, the rows and what a drop means are jobOrder.ts's; the
 * gesture is useJobDrag's.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { Icon } from '../../components/Icon'
import { btn, panel } from '../../lib/controls'
import { basename } from '../../lib/format'
import { useGroupJob, useJobs, useMoveJob, useUngroupJob } from '../../lib/queries'
import { ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import { Thumb } from '../../media/Thumb'
import type { JobSummary } from '../../../../shared/models'
import { JobRow, THUMB_H, THUMB_W } from './JobRow'
import {
  dropAction,
  groupRows,
  keyboardMove,
  orderJobs,
  type DropAction,
  type JobListRow
} from './jobOrder'
import { dropClass, useJobDrag, type JobDragState } from './useJobDrag'
import { SubmitJobDialog } from './SubmitJobDialog'

/** How long a refused queue action's message stays up. */
const NOTE_MS = 20_000

/** The dragged job, following the pointer. */
function DragGhost({ job, drag }: { job: JobSummary; drag: JobDragState }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: drag.x + 12,
        top: drag.y - THUMB_H / 2,
        zIndex: 1000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space2,
        padding: '4px 10px 4px 4px',
        maxWidth: 320,
        background: TOKENS.surfaceOverlay,
        border: `1px solid ${TOKENS.accentSoftBorder}`,
        borderRadius: SCALE.radiusMd,
        boxShadow: TOKENS.shadowPopover,
        fontSize: SCALE.textSm,
        fontWeight: SCALE.weightSemibold,
        transform: 'rotate(-1deg)'
      }}
    >
      <Thumb url={job.thumbUrl} width={THUMB_W} height={THUMB_H} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {job.name || basename(job.blendPath)}
      </span>
    </div>
  )
}

function GroupBlock({
  row,
  children
}: {
  row: Extract<JobListRow, { kind: 'group' }>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="group"
      data-group-block={row.groupId}
      aria-label={`shared priority, ${row.jobs.length} jobs`}
      style={{
        position: 'relative',
        borderBottom: `1px solid ${TOKENS.border}`,
        background: `color-mix(in srgb, ${TOKENS.accentSoftBg} 35%, transparent)`
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: TOKENS.accent,
          borderRadius: 2
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space1,
          padding: '5px 12px 0 30px',
          fontSize: SCALE.text2xs,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: SCALE.weightSemibold,
          color: TOKENS.textFaint
        }}
      >
        <Icon name="link" size={11} />
        shared priority · {row.jobs.length} jobs
      </div>
      {children}
    </div>
  )
}

export function JobsScreen(): React.JSX.Element {
  const { data: jobs, isLoading } = useJobs()
  const [showSubmit, setShowSubmit] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const move = useMoveJob()
  const group = useGroupJob()
  const ungroup = useUngroupJob()

  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(() => setNote(null), NOTE_MS)
    return () => window.clearTimeout(t)
  }, [note])

  const list = useMemo(() => jobs ?? [], [jobs])
  const ordered = useMemo(() => orderJobs(list), [list])
  const rows = useMemo(() => groupRows(ordered), [ordered])

  const apply = useCallback(
    (action: DropAction | null) => {
      if (!action) return
      const fail = (what: string) => (e: unknown) => setNote(`${what}: ${ipcErrorText(e)}`)
      if ('move' in action) move.mutate(action.move, { onError: fail('move') })
      else group.mutate(action.group, { onError: fail('group') })
    },
    [move, group]
  )

  const { drag, gripProps } = useJobDrag({
    onDrop: (jobId, target) => apply(dropAction(list, jobId, target.jobId, target.intent))
  })
  // Only a drop that would do something shows where it lands.
  const shown: JobDragState | null =
    drag?.target && dropAction(list, drag.jobId, drag.target.jobId, drag.target.intent)
      ? drag
      : drag
        ? { ...drag, target: null }
        : null
  const dragged = drag ? list.find((j) => j.id === drag.jobId) : undefined

  const rowOf = (job: JobSummary, block?: { index: number; size: number }): React.JSX.Element => (
    <JobRow
      key={job.id}
      job={job}
      onGripPointerDown={gripProps(job.id).onPointerDown}
      onKeyMove={(dir) => apply(keyboardMove(list, job.id, dir))}
      dropClassName={dropClass(shown, job.id)}
      lifted={drag?.jobId === job.id}
      block={block}
      onUngroup={
        block
          ? () =>
              ungroup.mutate(job.id, {
                onError: (e) => setNote(`ungroup: ${ipcErrorText(e)}`)
              })
          : undefined
      }
      onError={setNote}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {showSubmit ? <SubmitJobDialog onClose={() => setShowSubmit(false)} /> : null}
      <AppToolbar
        left={
          <>
            <button
              style={btn({ variant: 'primary', size: 'sm' })}
              onClick={() => setShowSubmit(true)}
            >
              + new render
            </button>
            {note ? (
              <span
                role="status"
                title={note}
                style={{
                  maxWidth: 420,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: SCALE.textXs,
                  color: TOKENS.danger
                }}
              >
                {note}
              </span>
            ) : null}
          </>
        }
      />
      <div style={{ flex: 1, overflow: 'auto', padding: SCALE.space4 }}>
        {list.length === 0 ? (
          <div style={{ ...panel(), padding: SCALE.space6, textAlign: 'center' }}>
            <span style={{ color: TOKENS.textFaint }}>
              {isLoading ? 'Loading…' : 'No render jobs yet.'}
            </span>
          </div>
        ) : (
          <div role="list" aria-label="render jobs" style={{ ...panel(), overflow: 'hidden' }}>
            {rows.map((row) =>
              row.kind === 'single' ? (
                rowOf(row.job)
              ) : (
                <GroupBlock key={`g:${row.groupId}`} row={row}>
                  {row.jobs.map((j, index) => rowOf(j, { index, size: row.jobs.length }))}
                </GroupBlock>
              )
            )}
          </div>
        )}
      </div>
      {drag && dragged ? <DragGhost job={dragged} drag={drag} /> : null}
    </div>
  )
}
