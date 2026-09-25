/**
 * What the recovery actions (plan 1.15) offer for a job or a node, decided
 * without a DOM so it can be tested: JobDetail's "Re-render missing" and
 * NodeDetail's "reprovision". Main decides what they do (app/recovery.ts);
 * these only decide when a button is shown and what it says, and they
 * follow main's rules, so a button is never offered for something main
 * refuses, and its count is what main queues.
 */

import type {
  ChunkState,
  JobDetail,
  NodeSnapshot,
  NodeState,
  ReprovisionResult,
  RetryMissingResult
} from '../../../shared/models'
import { holdsInstance } from '../../../shared/nodeState'

/** A chunk with a run to come or under way: its frames are already queued. */
const LIVE: ReadonlySet<ChunkState> = new Set<ChunkState>([
  'pending',
  'assigned',
  'rendering',
  'encoding',
  'downloading'
])

export interface RetryOffer {
  /** the button's label */
  label: string
  /** its armed label: the question the second click answers */
  confirmLabel: string
  /** its tooltip */
  title: string
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * "Re-render missing" for `job`, or null when there is nothing to offer.
 *
 * Main queues every frame not yet downloaded that no live chunk covers
 * (jobs/revive.ts). With nothing live that is every frame not downloaded,
 * framesTotal − framesDone, so the button can say how many. While chunks
 * are live the renderer cannot tell which of the rest they cover, so the
 * button counts the failed chunks instead; the result says how many frames
 * went. A job the scheduler failed outright is never offered it: main
 * refuses it, because it would fail the same way on a paid node.
 */
export function retryMissingOffer(job: JobDetail): RetryOffer | null {
  if (job.state === 'failed') return null
  const held = job.attention != null
  const confirmLabel = held ? 'resume the held job and re-render?' : 're-render and pay for it?'
  const title =
    'Queue the frames that never arrived again, with fresh retries. Frames already on this ' +
    'computer are not rendered again.' +
    (held ? ' The job is held; this releases the hold.' : '')
  const live = job.chunks.some((c) => LIVE.has(c.state))
  if (!live) {
    const missing = job.framesTotal - job.framesDone
    if (missing <= 0) return null
    return { label: `re-render missing (${plural(missing, 'frame')})`, confirmLabel, title }
  }
  const failed = job.chunks.filter((c) => c.state === 'failed').length
  if (failed === 0) return null
  return {
    label: `re-render missing (${plural(failed, 'failed chunk')})`,
    confirmLabel,
    title
  }
}

/**
 * Whether JobDetail offers "resume" (job:resume, plan 1.17): the retry
 * breaker held the job after the same failure on several nodes. Before the
 * channel existed a held job's only way on was cancel and resubmit, which
 * renders and bills every finished frame again. A job the scheduler failed
 * outright (its scene, engine or an extension) stays failed: main refuses
 * to resume it, since it would fail the same way on a paid node.
 */
export function canResume(job: Pick<JobDetail, 'state' | 'attention'>): boolean {
  return (
    job.attention?.kind === 'repeatedFailure' && (job.state === 'queued' || job.state === 'running')
  )
}

/** What a finished "resume" did. */
export function describeResume(resumed: boolean): string {
  return resumed ? 'resumed: its chunks go out again' : 'the job was not held'
}

/** What a finished "Re-render missing" did, for the line beside the button. */
export function describeRetry(r: RetryMissingResult | void): string {
  if (!r || r.frames === 0) return 'nothing was missing'
  return `${plural(r.frames, 'frame')} queued again in ${plural(r.chunks, 'chunk')}`
}

/**
 * The node states main reprovisions from (app/recovery.ts): up, with an
 * agent the app talks to. Not one still coming up or already being
 * restored, or one on its way out.
 */
const REPROVISIONABLE: ReadonlySet<NodeState> = new Set<NodeState>([
  'ready',
  'idle',
  'rendering',
  'encoding'
])

/** Whether "reprovision" can be offered for `node` now. */
export function canReprovision(node: Pick<NodeSnapshot, 'state' | 'sshHost'>): boolean {
  return REPROVISIONABLE.has(node.state) && node.sshHost != null
}

/** What a finished reprovision did. */
export function describeReprovision(r: ReprovisionResult | void): string {
  const n = r?.requeued ?? 0
  return `agent restarted${n > 0 ? `; ${plural(n, 'chunk')} back in the queue` : ''}`
}

/**
 * Whether a node's destroy button is live. Not while a destroy is under
 * way: a second DELETE on a node that is 'destroying' fails, and raised a
 * false "check the Vast.ai console" alarm (#113). Not for a node whose
 * instance Vast has confirmed gone. But a 'destroyed' row whose destroy was
 * never confirmed still holds an instance that may be billing
 * (nodeState.holdsInstance: a DELETE can answer 200 and leave it running,
 * #140), and the Fleet lists it for that reason: its button stays live, and
 * main's destroyNode goes ahead for it.
 */
export function canDestroy(
  node: Pick<NodeSnapshot, 'state'> &
    Partial<Pick<NodeSnapshot, 'instanceId' | 'destroyedAt' | 'createUnknownSince'>>
): boolean {
  if (node.state === 'destroying') return false
  if (node.state !== 'destroyed') return true
  return holdsInstance({ ...node, instanceId: node.instanceId ?? null })
}

/**
 * The words of an error an ipc.invoke rejected with. Electron puts
 * "Error invoking remote method '<channel>': " and the error's name
 * ("Error: ", "NotRevivable: ") in front of main's message, which says
 * nothing to the user.
 */
export function ipcErrorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Z]\w*: )?/, '')
}
