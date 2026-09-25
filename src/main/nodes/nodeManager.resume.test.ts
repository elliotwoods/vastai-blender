import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeState } from '../../shared/models'
import { setup, type App, type FakeMachine, type World } from '../test/harness'

// Destroying a node while a restart re-attaches to it: resumeNode, and the
// recoverUnreachable it hands over to when the node does not answer. The
// Fleet shows the row, destroy button and all, from start-up, and a resume
// that re-provisions takes minutes. As for a node being rented
// (nodeManager.rent.test.ts): the instance is destroyed exactly once, the
// node ends as the destroy left it, and nothing reports a node failure.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

/**
 * Every state a node was shown in from event index `from` on. A snapshot
 * pushed for another field (the destroy's stamp) that repeats the state
 * before it is left out.
 */
function statesSince(nodeId: string, from: number): NodeState[] {
  return w.events
    .slice(from)
    .filter((e) => e.channel === 'node:changed')
    .map((e) => e.payload as { id: string; state: NodeState })
    .filter((s) => s.id === nodeId)
    .map((s) => s.state)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
}

/**
 * Start the app over a node the last run left `state`, on a live instance
 * with its label, its SSH endpoint recorded and its host key pinned, as a
 * node that reached 'ready' leaves its row. `before` runs after the engine is
 * loaded and before init() resumes the node, which asks Vast about the
 * instance at once: script onReady, the machine and Vast there.
 */
async function restartWith(
  state: NodeState,
  before: (app: App, machine: FakeMachine) => void = () => {}
): Promise<{ app: App; id: string; instanceId: number }> {
  const app = await w.boot({ start: false })
  const id = randomUUID()
  const inst = w.vast.addInstance({ label: `vastai-blender ${id.slice(0, 8)}` })
  const machine = w.vast.machine(inst.id)
  const [ep] = machine.endpoints
  w.db
    .prepare(
      `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, ssh_host,
         ssh_port, host_key, started_at, accumulated_cost, blender_versions)
       VALUES (?, ?, ?, 'RTX 4090', 1, 0.4, ?, ?, ?, ?, 0, '[]')`
    )
    .run(id, inst.id, state, ep.host, ep.port, machine.hostKey, Date.now() - 3_600_000)
  before(app, machine)
  app.nodeManager.init()
  return { app, id, instanceId: inst.id }
}

/** onReady held open until the test ends it, as a slow provisionBase is. */
function holdProvisioning(app: App): {
  readonly entered: boolean
  finish(): void
  fail(e: Error): void
} {
  const s: { entered: boolean; finish: () => void; fail: (e: Error) => void } = {
    entered: false,
    finish: () => {},
    fail: () => {}
  }
  app.nodeManager.onReady = () => {
    s.entered = true
    return new Promise<void>((resolve, reject) => {
      s.finish = resolve
      s.fail = reject
    })
  }
  return s
}

describe('destroy while a restart re-provisions the node (resumeNode)', () => {
  it('re-attaches to a live node and provisions it back to ready', async () => {
    let provisioned = 0
    const { app, id } = await restartWith('rendering', (a) => {
      a.nodeManager.onReady = async () => {
        provisioned++
      }
    })
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'resumed node ready')
    expect(provisioned).toBe(1)
    expect(w.vast.count('destroyInstance')).toBe(0)
  })

  it('provisioning that completes after the destroy does not mark the node ready', async () => {
    let prov!: ReturnType<typeof holdProvisioning>
    const { app, id } = await restartWith('ready', (a) => (prov = holdProvisioning(a)))
    await w.until(() => prov.entered, 'resume provisioning')

    const from = w.events.length
    await app.nodeManager.destroyNode(id)
    prov.finish()
    await w.advance(60_000)

    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(app.nodeManager.get(id)?.state).toBe('destroyed')
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.vast.live()).toEqual([])
    expect(w.alerts('error')).toEqual([])
  })

  it('provisioning that fails because of the destroy is not the node becoming unreachable', async () => {
    let prov!: ReturnType<typeof holdProvisioning>
    const { app, id } = await restartWith('ready', (a) => (prov = holdProvisioning(a)))
    await w.until(() => prov.entered, 'resume provisioning')

    const from = w.events.length
    await app.nodeManager.destroyNode(id)
    // What provisionBase throws when its connection is closed under it.
    prov.fail(new Error('provision.sh base failed (exit null)'))
    await w.advance(2 * 60_000, 5_000)

    // Not 'unreachable', then 'failed' over 'destroyed', and a second DELETE
    // (a 404) raising "Could not destroy".
    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
  })

  it('a destroy whose DELETE fails is not undone when provisioning ends', async () => {
    let prov!: ReturnType<typeof holdProvisioning>
    const { app, id, instanceId } = await restartWith('idle', (a) => (prov = holdProvisioning(a)))
    await w.until(() => prov.entered, 'resume provisioning')

    const from = w.events.length
    // Refused outright, so ensureInstanceGone gives up at once (a 5xx it
    // would retry within the call).
    w.vast.fail('destroyInstance', { status: 403, message: 'access denied' })
    await app.nodeManager.destroyNode(id)
    prov.finish()
    await w.advance(1_000)

    expect(statesSince(id, from)).toEqual(['destroying', 'failed'])
    expect(w.get('SELECT state, instance_id FROM nodes WHERE id = ?', id)).toEqual({
      state: 'failed',
      instance_id: instanceId
    })
    const errors = w.alerts('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(`Destroy failed for instance ${instanceId}`)
    await expect(app.nodeManager.clearFailed()).resolves.toBe(1)
    expect(w.vast.live()).toEqual([])
  })

  it('a destroy while Vast is asked about the instance is not undone by the answer', async () => {
    let show!: ReturnType<World['vast']['hold']>
    const { app, id, instanceId } = await restartWith('ready', (a) => {
      a.nodeManager.onReady = async () => {}
      show = w.vast.hold('showInstance')
    })
    await w.until(() => show.reached, 'resume asking Vast')
    // Hold the destroy's DELETE too, so the instance is still up, and
    // running, when Vast's answer comes back.
    const del = w.vast.hold('destroyInstance')
    const from = w.events.length
    const destroying = app.nodeManager.destroyNode(id)
    show.release()
    await w.advance(30_000)
    del.release()
    await destroying
    await w.advance(30_000)

    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.machine(instanceId).connects).toBe(0)
    expect(w.alerts('error')).toEqual([])
  })
})

describe('destroy while an unreachable node is reconnecting (recoverUnreachable)', () => {
  it('is not a node failure: no second destroy, no error alert', async () => {
    // sshd does not answer: resume marks the node unreachable and retries.
    const { app, id } = await restartWith('rendering', (a, machine) => {
      a.nodeManager.onReady = async () => {}
      machine.refuseConnects = Infinity
    })
    await w.until(() => app.nodeManager.get(id)?.state === 'unreachable', 'node unreachable')

    const from = w.events.length
    await app.nodeManager.destroyNode(id)
    // The reconnect wakes from its backoff to a closed connection.
    await w.advance(2 * 60_000, 5_000)

    expect(statesSince(id, from)).toEqual(['destroying', 'destroyed'])
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
  })

  it('still destroys a node that never comes back', async () => {
    const { app, id, instanceId } = await restartWith('rendering', (_a, machine) => {
      machine.refuseConnects = Infinity
    })
    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'dead node destroyed', {
      timeoutMs: 15 * 60_000,
      stepMs: 5_000
    })
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).toEqual([])
  })
})
