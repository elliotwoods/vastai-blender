/**
 * JobDetail's actions on the job itself: "resume" for a job the retry
 * breaker held (plan 1.17), "Re-render missing" (plan 1.15) and cancel.
 * Each asks before it acts (ConfirmButton): a cancel was one click, and a
 * stray one stopped a long render (audit D4); a resume or a re-render
 * rents nodes. Kept free of the IPC bridge so it renders in a test; the
 * screen passes the actions in, each returning its promise so the button
 * stays disabled until main has answered.
 */

import { ConfirmButton } from '../../components/ConfirmButton'
import { canResume, retryMissingOffer } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import type { JobDetail } from '../../../../shared/models'

export function JobActions({
  job,
  onResume,
  onRetryMissing,
  onCancel,
  note
}: {
  job: JobDetail
  onResume: () => Promise<unknown>
  onRetryMissing: () => Promise<unknown>
  onCancel: () => Promise<unknown>
  /** what the last resume or re-render did, or why it was refused */
  note: string | null
}): React.JSX.Element {
  const offer = retryMissingOffer(job)
  const running = job.state === 'queued' || job.state === 'running'
  return (
    <>
      {note ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textMuted }}>{note}</span>
      ) : null}
      {canResume(job) ? (
        <ConfirmButton
          label="resume"
          confirmLabel="send its chunks again?"
          variant="default"
          title={
            'The job was held after its chunks failed the same way on several nodes. Resume ' +
            'counts its failures afresh and sends its chunks out again, on paid nodes; they may ' +
            'fail the same way. Frames already on this computer are kept.'
          }
          onConfirm={onResume}
        />
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

/**
 * The job's scene was saved over after it was submitted (plan 1.12). The
 * job renders the copy taken at submit, so the new version is not in it;
 * said here so nobody waits for frames of an edit this job will never
 * show.
 */
export function SceneChangedNote({ job }: { job: JobDetail }): React.JSX.Element | null {
  if (job.sceneChanged !== true) return null
  return (
    <span
      role="status"
      title={
        'The scene file was saved after this job was submitted. The job keeps rendering the ' +
        'copy taken then (scene.blend in its folder); submit the scene again to render the ' +
        'new version.'
      }
      style={{ fontSize: SCALE.textXs, color: TOKENS.warn, whiteSpace: 'nowrap' }}
    >
      scene changed since submit
    </span>
  )
}
