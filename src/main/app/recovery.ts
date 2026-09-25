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
 */

import { emit } from '../events'
import { reviveFailedChunks } from '../jobs/revive'
import { getDb } from '../db/db'
import { nodeManager } from '../nodes/nodeManager'
import { AgentBusyError, provisionBase } from '../nodes/provisioner'
import { scheduler } from '../scheduler/scheduler'
import { classify } from '../errors'
import type { NodeState, ReprovisionResult, RetryMissingResult } from '../../shared/models'

/**
 * Queue again every frame of `jobId` not yet downloaded (see
 * reviveFailedChunks, whose refusals it passes on). A job the breaker held
 * (jobs.attention) is released once something is queued: "Re-render
 * missing" on a held job is the user asking for the render with the
 * reason in front of them, which is what resumeJob waits for. With the hold
 * left on, what was queued would sit pending behind it and the button would
 * seem to do nothing.
 */
export function retryMissing(jobId: string): RetryMissingResult {
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
 *    reprovisioned rather than failed.
 * 4. 'ready', unless the node was destroyed meanwhile, which is the
 *    destroy's to finish (ManagedNode.movedOn).
 *
 * A reprovision that fails leaves a node whose runs are forgotten and whose
 * old renders may still hold its GPUs, or with no agent at all: it could
 * only bill. So it is destroyed, as driveToReady destroys a node that
 * cannot be provisioned, and the call rejects saying so. Except when
 * another restart-agent held the node (AgentBusyError, the node busy, not
 * broken): that restart kills the old renders itself, and the node goes
 * back to 'ready'.
 *
 * The requeued chunks are charged an infrastructure retry by forgetNode, as
 * for a node that went away; their render retries are untouched.
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

  try {
    await provisionBase(ssh, nodeId)
  } catch (e) {
    // Destroyed meanwhile: the destroy closed the connection under the
    // restart. Not this node failing; the destroy finishes it.
    if (node.movedOn(held)) return { requeued }
    const reason = classify(e, { via: 'ssh' }).reason
    if (e instanceof AgentBusyError) {
      node.setState('ready')
      emit('alert', {
        level: 'warn',
        message:
          `Node ${name} was not reprovisioned: another agent restart is under way on it ` +
          `(${reason}). ${requeued} chunk(s) went back to the queue.`
      })
      scheduler.kick()
      throw new Error(`another agent restart is under way on node ${short}`, { cause: e })
    }
    const message =
      `Node ${name} could not be reprovisioned (${reason}), so it is being destroyed. ` +
      `${requeued} chunk(s) went back to the queue.`
    emit('alert', { level: 'error', message })
    await nodeManager.destroyNode(nodeId)
    throw new Error(message, { cause: e })
  }

  if (node.movedOn(held)) return { requeued }
  node.setState('ready')
  emit('alert', {
    level: 'info',
    message: `Node ${name} reprovisioned: agent restarted, ${requeued} chunk(s) back in the queue`
  })
  scheduler.kick()
  return { requeued }
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
