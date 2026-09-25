import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeState } from '../../shared/models'
import { setup, type App, type FakeMachine, type World } from '../test/harness'

// Plan 1.6: Vast not answering is not the instance gone, nor the machine bad.
//
// A 5xx, a 429 or a network blip during a boot's status poll used to fail the
// node there and then: its machine blacklisted, its instance destroyed after
// the image pull had been paid for (#39 #236). And a start-up while Vast, or
// this computer's network, was down sent every live node to
// recoverUnreachable, which either marked it 'ready' without re-provisioning
// (SSH fine: a stale agent and inbox left running) or 'failed', uncounted and
// still billing, with a replacement rented next to it (#33). The control
// plane being down now only means: wait, counted as billing, and ask again.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

/** Vast's reply when its API is having a bad minute. */
const unavailable = (path: string): { status: number; message: string } => ({
  status: 503,
  message: `vast.ai GET ${path} → 503: service unavailable`
})

/** What vastClient throws when this computer's network is down under a request. */
const offline = { message: 'network error: fetch failed: getaddrinfo ENOTFOUND console.vast.ai' }

/** Every state a node was shown in, repeats left out. */
function states(nodeId: string): NodeState[] {
  return w
    .eventsOf('node:changed')
    .filter((s) => s.id === nodeId)
    .map((s) => s.state)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
}

/**
 * Whether a machine is still rentable, i.e. not blacklisted as having failed:
 * offer it again and see whether it rents.
 */
async function rentsAgain(app: App, machineId: number): Promise<boolean> {
  w.vast.offers = []
  w.vast.addOffer({ machine_id: machineId })
  const ids = await app.nodeManager.requestNodes(1).catch(() => [])
  return ids.length === 1
}

/**
 * Start the app over a node the last run left `state`, on a live instance
 * with its label, endpoint and pinned host key, as a node that reached
 * 'ready' leaves its row. `before` runs before init() asks Vast about it.
 */
async function restartWith(
  state: NodeState,
  before: (app: App, machine: FakeMachine, instanceId: number) => void = () => {}
): Promise<{ app: App; id: string; instanceId: number; machine: FakeMachine }> {
  const app = await w.boot({ start: false })
  const id = randomUUID()
  const inst = w.vast.addInstance({ label: `vastai-blender ${id.slice(0, 8)}` })
  const machine = w.vast.machine(inst.id)
  const [ep] = machine.endpoints
  w.db
    .prepare(
      `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, ssh_host,
         ssh_port, host_key, started_at, accumulated_cost, blender_versions, label)
       VALUES (?, ?, ?, 'RTX 4090', 1, 0.4, ?, ?, ?, ?, 0, '[]', ?)`
    )
    .run(
      id,
      inst.id,
      state,
      ep.host,
      ep.port,
      machine.hostKey,
      Date.now() - 3_600_000,
      `vastai-blender ${id.slice(0, 8)}`
    )
  before(app, machine, inst.id)
  app.nodeManager.init()
  return { app, id, instanceId: inst.id, machine }
}

describe('1.6 driveToReady: a boot rides out Vast not answering its status poll', () => {
  it('two 502s in the poll: the node still reaches ready, nothing destroyed (#39 #236)', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    w.vast.fail('showInstance', unavailable('/instances/9001/'), 1)
    w.vast.fail(
      'showInstance',
      { status: 502, message: 'vast.ai GET /instances/9001/ → 502: bad gateway' },
      1
    )
    let provisioned = 0
    app.nodeManager.onReady = async () => {
      provisioned++
    }

    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')

    expect(states(id)).not.toContain('failed')
    expect(provisioned).toBe(1)
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.vast.live()).toEqual(w.vast.created)
    expect(w.alerts('error')).toEqual([])
  })

  it('Vast silent past the boot deadline: the node fails and is destroyed, but its machine is not blamed', async () => {
    const app = await w.boot()
    const offer = w.vast.addOffer()
    // Every poll for the 8-minute deadline and one past it.
    w.vast.fail('showInstance', unavailable('/instances/9001/'), 50)

    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'failed and destroyed', {
      timeoutMs: 12 * 60_000,
      stepMs: 5_000
    })

    const failed = w.alerts('error').filter((m) => m.startsWith('Node failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('503')
    expect(w.vast.live()).toEqual([])
    // Vast's outage says nothing against the machine: it may be rented again.
    expect(await rentsAgain(app, offer.machine_id)).toBe(true)
  })
})

describe('1.6 resumeNode: Vast down at start-up is not the instance gone (#33)', () => {
  it('a restart while Vast is unreachable waits, then re-provisions the node once Vast answers', async () => {
    let provisioned = 0
    const { app, id } = await restartWith('rendering', (a) => {
      a.nodeManager.onReady = async () => {
        provisioned++
      }
      w.vast.fail('showInstance', offline, 3)
    })

    // Waiting on Vast: unreachable, not failed, counted as billing, no work.
    await w.until(() => app.nodeManager.get(id)?.state === 'unreachable', 'waiting on Vast')
    expect(app.nodeManager.get(id)?.snapshot.lastError).toMatch(/Vast\.ai did not answer/)
    expect(app.nodeManager.activeCount()).toBe(1)

    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'resumed', {
      timeoutMs: 5 * 60_000
    })
    // Through provisioning, as every resume must be: never 'ready' on SSH alone.
    expect(provisioned).toBe(1)
    expect(states(id)).toEqual(['unreachable', 'provisioning', 'ready'])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.alerts('error')).toEqual([])
  })

  it('Vast and SSH both down: nothing failed or destroyed while Vast is silent, and the node is metered', async () => {
    const { app, id, instanceId } = await restartWith('rendering', (a, machine) => {
      a.nodeManager.onReady = async () => {}
      machine.refuseConnects = Infinity
      w.vast.fail('showInstance', offline, 1_000)
    })

    await w.advance(10 * 60_000, 5_000)

    expect(states(id)).toEqual(['unreachable'])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.vast.live()).toEqual([instanceId])
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(app.nodeManager.billingPerHour()).toBeCloseTo(0.4)
    const metered = w.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cost_log WHERE node_id = ?',
      id
    )!.n
    expect(metered).toBeGreaterThanOrEqual(9)
    // Asked again and again, backing off to once a minute: not hammered.
    const asked = w.vast.count('showInstance')
    expect(asked).toBeGreaterThan(5)
    expect(asked).toBeLessThan(20)
  })

  it('a destroy while it waits on Vast is the destroy: no resume comes back over it', async () => {
    let provisioned = 0
    const { app, id, instanceId } = await restartWith('idle', (a) => {
      a.nodeManager.onReady = async () => {
        provisioned++
      }
      w.vast.fail('showInstance', offline, 1)
    })
    await w.until(() => app.nodeManager.get(id)?.state === 'unreachable', 'waiting on Vast')

    await app.nodeManager.destroyNode(id)
    // The resume wakes from its backoff to a node that is not its any more.
    await w.advance(3 * 60_000, 5_000)

    expect(states(id)).toEqual(['unreachable', 'destroying', 'destroyed'])
    expect(provisioned).toBe(0)
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).toEqual([])
    expect(w.vast.machine(instanceId).connects).toBe(0)
  })

  it('Vast answering that the instance is gone still settles it at once', async () => {
    const { app, id } = await restartWith('ready', (_a, _m, instanceId) => {
      void w.vast.destroyInstance(instanceId)
    })
    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'confirmed gone')

    expect(
      w.get<{ destroyed_at: number | null }>('SELECT destroyed_at FROM nodes WHERE id = ?', id)
        ?.destroyed_at
    ).not.toBeNull()
    // The test's own, then the app's, whose 404 is what confirms it gone.
    expect(w.vast.count('destroyInstance')).toBe(2)
    expect(app.nodeManager.activeCount()).toBe(0)
  })
})
