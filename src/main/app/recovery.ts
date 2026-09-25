/**
 * Recovery actions (plan 1.15): what the user can do from the UI when work
 * or a node has gone wrong, short of cancelling or destroying. Both were
 * empty IPC stubs that answered success (#201, #122): a partial job could
 * only be submitted again, re-rendering and re-billing every frame already
 * verified, and a node whose agent had wedged could only be destroyed.
 *
 * - retryMissing (job:retryMissing, JobDetail's "Re-render missing"): the
 *   job's missing frames go back in the queue (jobs/revive.ts), and a hold
 *   the breaker put on the job is released, since the user has now seen why
 *   it was held and asked for the render.
 * - reprovisionNode (node:reprovision, NodeDetail's "reprovision"): the
 *   node's work goes back in the queue and its agent is restarted on
 *   freshly shipped scripts.
 * - cancelJob (job:cancel): the scheduler's cancel, noted until it has
 *   stopped the job's renders on the nodes, which retryMissing waits for.
 */

import { emit } from '../events'
import { reviveFailedChunks } from '../jobs/revive'
import { getDb } from '../db/db'
import { nodeManager } from '../nodes/nodeManager'
import { AgentBusyError, agentStatus, provisionBase, restartAgent } from '../nodes/provisioner'
import { scheduler } from '../scheduler/scheduler'
import { classify } from '../errors'
import type { SshConnection } from '../ssh/sshConnection'
import type { NodeState, ReprovisionResult, RetryMissingResult } from '../../shared/models'

/**
 * Jobs whose cancel is still stopping their renders, each with a promise
 * that settles when it has. scheduler.cancelJob settles the rows at once,
 * then runs `rm -f <spec>; pkill -f <chunkId>` on each run's node one after
 * another, each under a 30 s deadline, so the last of them can go out
 * minutes after the job reads as cancelled. A revived job keeps its chunk
 * ids (jobs/revive.ts): a chunk revived and sent out in that time, to a
 * node the cleanup has yet to reach, would have its spec deleted or its
 * render killed by the cancel. That render is paid for and lost, and the
 * chunk is charged a machine retry when the 1.7 watchdog finds the spec gone.
 */
const cancelling = new Map<string, Promise<void>>()

/** For a promise whose outcome is not wanted, only that it is over. */
function noop(): void {
  return undefined
}

/**
 * Cancel `jobId` (scheduler.cancelJob), noting it in `cancelling` until its
 * node cleanup is over. Resolves, or rejects, as the cancel does.
 */
export async function cancelJob(jobId: string): Promise<void> {
  const done = scheduler.cancelJob(jobId)
  // After any cancel of the job still cleaning up, not just this one: a
  // second cancel finds no runs left and is over at once, and in place of
  // the first it let a revive go out under the first's pkills (a3 review).
  const before = cancelling.get(jobId)
  const over = Promise.all([before, done.then(noop, noop)]).then(noop)
  cancelling.set(jobId, over)
  // Forgotten once the whole chain is over, whichever cancel's that is.
  void over.then(() => {
    if (cancelling.get(jobId) === over) cancelling.delete(jobId)
  })
  await done
}

/**
 * Queue again every frame of `jobId` not yet downloaded (see
 * reviveFailedChunks, whose refusals it passes on). A job the breaker held
 * (jobs.attention) is released once something is queued: "Re-render
 * missing" on a held job is the user asking for the render with the
 * reason in front of them, which is what resumeJob waits for. With the hold
 * left on, what was queued would sit pending behind it and the button would
 * seem to do nothing.
 *
 * A cancel of the job still stopping its renders is waited for first (see
 * `cancelling`), so nothing it revives can be hit by the cancel's clean-up.
 * The button stays disabled while it waits.
 */
export async function retryMissing(jobId: string): Promise<RetryMissingResult> {
  for (let c = cancelling.get(jobId); c; c = cancelling.get(jobId)) await c
  const result = reviveFailedChunks(jobId)
  if (result.frames > 0) {
    scheduler.resumeJob(jobId)
    scheduler.kick()
  }
  return result
}

/**
 * The states reprovision starts from: up, with an agent the app talks to.
 * Not a node still coming up, one already being restored ('unreachable'),
 * or one on its way out.
 */
const REPROVISIONABLE: ReadonlySet<NodeState> = new Set<NodeState>([
  'ready',
  'idle',
  'rendering',
  'encoding'
])

/**
 * How long a reprovision may hold its node out of the fleet: nodeManager's
 * PROVISION_DEADLINE_MS (plan 1.8). Every other step that puts a node in
 * 'provisioning' (onReady, resumeNode, restoreAgent, recoverUnreachable)
 * runs under it, and the supervisor leaves a 'provisioning' node alone
 * because of it. provisionBase's own step timeouts add up to over an hour
 * (the deps step alone may take 75 min, sized for a trickling ffmpeg
 * mirror). The node bills all that time with nothing rendered, and scaling
 * counts it as capacity on its way. Keep the two equal. A reprovision past
 * it has failed, and its node is destroyed like any other; the destroy
 * closes the connection the hung step runs on.
 */
export const REPROVISION_DEADLINE_MS = 25 * 60_000

/** A reprovision that ran past REPROVISION_DEADLINE_MS. */
class ReprovisionTimeout extends Error {
  override readonly name = 'ReprovisionTimeout'

  constructor(ms: number) {
    super(`reprovisioning did not finish within ${Math.round(ms / 60_000)} min`)
  }
}

/** `work`, or a ReprovisionTimeout once `ms` has passed without it. As nodeManager's withDeadline. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReprovisionTimeout(ms)), ms)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * Restart a node's agent, and requeue what was in flight on it.
 *
 * In this order, each step for a reason:
 * 1. 'provisioning': nothing more is sent to the node, so no spec lands in
 *    the inbox the restart is about to clear. That is the phantom run of
 *    field incident 81fe2875, a run polling for a render that was deleted.
 * 2. The scheduler forgets the node's runs and requeues their chunks around
 *    the frames that landed. Forgotten before the restart, not after: a run
 *    forgotten cannot write its spec any more (its prep checks), and one
 *    still live during the restart could write one after the inbox was
 *    cleared, for the new agent to render and nobody to collect. Their
 *    renders go on until the restart kills them.
 * 3. provisionBase: the remote/ tree shipped again, the deps checked, and
 *    the agent restarted with --force, which kills every Blender on the node
 *    and empties its inbox. The scripts go first so that a node provisioned
 *    by an older build, whose provision.sh has no restart-agent, is
 *    reprovisioned rather than failed. All of it under
 *    REPROVISION_DEADLINE_MS.
 * 4. 'ready', unless the node was destroyed meanwhile, which is the
 *    destroy's to finish (ManagedNode.movedOn).
 *
 * A reprovision that fails, or runs past its deadline, leaves a node whose
 * runs are forgotten and whose old renders may still hold its GPUs, or with
 * no agent at all: it could only bill. So it is destroyed, as driveToReady
 * destroys a node that cannot be provisioned, and the call rejects saying
 * so. Not when the app ended it: a destroy, or a quit closing every
 * connection (below). When another restart-agent held the node, see
 * restartForReprovision.
 *
 * The requeued chunks are charged an infrastructure retry by forgetNode, as
 * for a node that went away, and it raises its "node went away mid-render"
 * alert; their render retries are untouched. scheduler.ts has no forget
 * that charges nothing yet.
 */
export async function reprovisionNode(nodeId: string): Promise<ReprovisionResult> {
  const node = nodeManager.get(nodeId)
  if (!node) throw new Error(`no node ${nodeId}`)
  const short = nodeId.slice(0, 8)
  const state = node.state
  if (!REPROVISIONABLE.has(state)) {
    throw new Error(`node ${short} is ${state}: only a node that is up can be reprovisioned`)
  }
  const ssh = node.ssh
  if (!ssh) throw new Error(`node ${short} is not connected`)
  const name = `${node.snapshot.gpuName ?? 'node'} ${short}`

  node.setState('provisioning')
  const held: NodeState = 'provisioning'
  const inFlight = scheduler.activeWorkForNode(nodeId).map((w) => w.chunkId)
  scheduler.forgetNode(nodeId)
  const requeued = countPending(inFlight)

  // The app ended this reprovision rather than the node failing it: the
  // deadline passed, a destroy moved the node on, or the quit's
  // nodeManager.shutdown() closed its connection. Nothing but a destroy and
  // shutdown() closes the connection of a node a step holds.
  let over = false
  const endedByApp = (): boolean => over || node.movedOn(held) || node.ssh !== ssh

  let kept: string | null
  try {
    kept = await withDeadline(
      restartForReprovision(ssh, nodeId, endedByApp),
      REPROVISION_DEADLINE_MS
    )
  } catch (e) {
    over = true
    // Destroyed meanwhile: the destroy closed the connection under the
    // restart. Not this node failing; the destroy finishes it.
    if (node.movedOn(held)) return { requeued }
    // The app is quitting. Not this node failing either, and on a "leave
    // running" quit the user chose to keep it: a destroy here would overrule
    // that, and race the database's close. Left as the quit leaves it, as
    // the supervisor's recoveries leave theirs (`|| this.shutDown`); the
    // next launch takes it up.
    if (node.ssh !== ssh) {
      throw new Error(`node ${short} was not reprovisioned: the app is quitting`, { cause: e })
    }
    const reason = classify(e, { via: 'ssh' }).reason
    const message =
      `Node ${name} could not be reprovisioned (${reason}), so it is being destroyed. ` +
      `${requeued} chunk(s) went back to the queue.`
    emit('alert', { level: 'error', message })
    await nodeManager.destroyNode(nodeId)
    throw new Error(message, { cause: e })
  }

  if (endedByApp()) return { requeued }
  node.setState('ready')
  scheduler.kick()
  if (kept) {
    emit('alert', {
      level: 'warn',
      message:
        `Node ${name} was not reprovisioned: ${kept}, so it is back in service. ` +
        `${requeued} chunk(s) went back to the queue.`
    })
    throw new Error(`node ${short} was not reprovisioned: ${kept}`)
  }
  emit('alert', {
    level: 'info',
    message: `Node ${name} reprovisioned: agent restarted, ${requeued} chunk(s) back in the queue`
  })
  return { requeued }
}

/**
 * provisionBase, and what follows when another restart-agent held the node
 * through both of restartAgent's waits (AgentBusyError: busy, not broken).
 *
 * The node's runs are already forgotten, so an old render still going on it
 * renders a chunk the app has requeued elsewhere: paid for twice, never
 * collected, on GPUs the scheduler counts as free, with a fresh heartbeat
 * the supervisor never questions. The other run cannot be trusted to kill
 * it: a restart-agent without --force keeps a live agent, renders and all
 * (AGENT_KEPT). So the node is asked (agent-status):
 * - A live agent of this build, rendering nothing, with an empty inbox:
 *   there is nothing to kill, and a restart-agent without --force keeps
 *   such an agent. It is left as it is, and this resolves with why.
 * - Anything else (renders, specs, an agent that needs restarting, no
 *   answer): the agent is forced once more, and if that fails too, so does
 *   the reprovision.
 *
 * Resolves null once the agent was restarted. Once `ended` says the app has
 * ended the reprovision, nothing more is run on the node.
 */
async function restartForReprovision(
  ssh: SshConnection,
  nodeId: string,
  ended: () => boolean
): Promise<string | null> {
  try {
    await provisionBase(ssh, nodeId)
    return null
  } catch (e) {
    if (!(e instanceof AgentBusyError) || ended()) throw e
  }
  const status = await agentStatus(ssh)
  if (ended()) throw new Error('the reprovision was ended')
  if (status && !status.restartNeeded && status.blenderProcs === 0 && status.inboxSpecs === 0) {
    return 'another agent restart was under way on it, and its agent is up with nothing to render'
  }
  await restartAgent(ssh, nodeId, { force: true })
  return null
}

/** How many of these chunks are pending: requeued, not complete or failed for good. */
function countPending(chunkIds: string[]): number {
  if (chunkIds.length === 0) return 0
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM chunks
        WHERE state = 'pending' AND id IN (${chunkIds.map(() => '?').join(', ')})`
    )
    .get(...chunkIds) as { n: number }
  return row.n
}
