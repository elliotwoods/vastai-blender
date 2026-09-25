/**
 * JobDetail's actions on the job itself: "Re-render missing" (plan 1.15)
 * and cancel. Both ask before they act (ConfirmButton): a cancel was one
 * click, and a stray one stopped a long render (audit D4); a re-render
 * rents nodes. Kept free of the IPC bridge so it renders in a test; the
 * screen passes the actions in, each returning its promise so the button
 * stays disabled until main has answered.
 */

import { ConfirmButton } from '../../components/ConfirmButton'
import { retryMissingOffer } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import type { JobDetail } from '../../../../shared/models'

export function JobActions({
  job,
  onRetryMissing,
  onCancel,
  note
}: {
  job: JobDetail
  onRetryMissing: () => Promise<unknown>
  onCancel: () => Promise<unknown>
  /** what the last re-render did, or why it was refused */
  note: string | null
}): React.JSX.Element {
  const offer = retryMissingOffer(job)
  const running = job.state === 'queued' || job.state === 'running'
  return (
    <>
      {note ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textMuted }}>{note}</span>
      ) : null}
      {offer ? (
        <ConfirmButton
          label={offer.label}
          confirmLabel={offer.confirmLabel}
          variant="default"
          title={offer.title}
          onConfirm={onRetryMissing}
        />
      ) : null}
      {running ? (
        <ConfirmButton
          label="cancel"
          confirmLabel="cancel the job?"
          title="Stop every render of this job. Frames already downloaded are kept."
          onConfirm={onCancel}
        />
      ) : null}
    </>
  )
}

/**
 * Why the job is waiting on the user, or why it failed (jobs.attention):
 * the scheduler's own words. Shown with the actions, since "Re-render
 * missing" on a held job releases the hold.
 */
export function JobAttentionNote({ job }: { job: JobDetail }): React.JSX.Element | null {
  if (!job.attention) return null
  const failed = job.state === 'failed'
  return (
    <span
      role="status"
      title={job.attention.message}
      style={{
        fontSize: SCALE.textXs,
        color: failed ? TOKENS.danger : TOKENS.warn,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0
      }}
    >
      {failed ? 'failed: ' : 'held: '}
      {job.attention.message}
    </span>
  )
}
