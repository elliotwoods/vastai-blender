import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SshConnection } from '../ssh/sshConnection'
import { setup, type World } from '../test/harness'

// Smoke scenarios for the lifecycle harness (src/main/test/harness.ts): the
// real nodeManager renting, readying and destroying fake Vast instances. Each
// asserts what the money path must guarantee — which instance was created and
// destroyed, and what the node row ends as — not how it got there.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

/** The label a rental made this session carries (plan 1.3): this profile's install id, then the node's. */
function labelOf(nodeId: string): string {
  return `vastai-blender ${w.settings.installId!.slice(0, 8)}:${nodeId.slice(0, 8)}`
}

describe('nodeManager lifecycle', () => {
  it('rents an offer and drives it through provisioning to ready', async () => {
    const app = await w.boot()
    const offer = w.vast.addOffer({
      gpu_name: 'RTX 4090',
      dph_total: 0.5,
      geolocation: 'Norway, NO'
    })
    const provisioned: string[] = []
    app.nodeManager.onReady = async ({ id, ssh }) => {
      // The handle onReady gets is the node's own live connection.
      const r = await ssh.exec('echo ok')
      expect(r.stdout).toContain('ok')
      provisioned.push(id)
    }

    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')

    expect(provisioned).toEqual([id])
    expect(w.vast.count('createInstance')).toBe(1)
    const [[opts]] = w.vast.argsOf('createInstance') as Array<[{ offerId: number; label: string }]>
    expect(opts.offerId).toBe(offer.id)
    // The label is what the orphan sweep trusts to tell our instances apart.
    expect(opts.label).toBe(labelOf(id))

    const row = w.get<Record<string, unknown>>('SELECT * FROM nodes WHERE id = ?', id)!
    expect(row.state).toBe('ready')
    expect(row.instance_id).toBe(w.vast.created[0])
    expect(row.geolocation).toBe('Norway, NO')
    // TOFU: the first connection pinned the machine's host key.
    expect(row.host_key).toBe(w.machineFor(id).hostKey)

    const states = w
      .eventsOf('node:changed')
      .filter((s) => s.id === id)
      .map((s) => s.state)
    expect(states[0]).toBe('requested')
    expect(states).toContain('provisioning')
    expect(states.at(-1)).toBe('ready')
    expect(w.alerts('error')).toEqual([])
  })

  it('destroyNode destroys the instance and ends destroyed', async () => {
    const app = await w.boot()
    const id = await w.readyNode(app)
    const machine = w.machineFor(id)
    const instanceId = w.vast.created[0]

    await app.nodeManager.destroyNode(id)

    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).toEqual([])
    expect(machine.alive).toBe(false)
    expect(app.nodeManager.get(id)?.state).toBe('destroyed')
    // Stamped only once Vast confirmed it (plan 1.2): the stamp is what stops
    // the node counting as billing.
    const row = w.get<{ state: string; destroyed_at: number | null }>(
      'SELECT state, destroyed_at FROM nodes WHERE id = ?',
      id
    )
    expect(row?.state).toBe('destroyed')
    expect(row?.destroyed_at).not.toBeNull()
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it('a node whose provisioning fails is destroyed, not left billing', async () => {
    const app = await w.boot()
    app.nodeManager.onReady = async () => {
      throw new Error('provision.sh base failed (exit 1)')
    }
    w.vast.addOffer()

    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'failed node destroyed')

    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.vast.live()).toEqual([])
    expect(w.alerts('error').join('\n')).toContain('provision.sh base failed')
  })

  it('a held createInstance can be inspected mid-flight and released', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    const gate = w.vast.hold('createInstance')

    const renting = app.nodeManager.requestNodes(1)
    await w.until(() => gate.reached, 'createInstance in flight')
    // The row exists before the instance does: nothing has been rented yet.
    const [row] = w.all<{ state: string; instance_id: number | null }>(
      'SELECT state, instance_id FROM nodes'
    )
    expect(row).toEqual({ state: 'requested', instance_id: null })
    expect(w.vast.live()).toEqual([])

    gate.release()
    const [id] = await renting
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')
    expect(w.vast.live()).toEqual([w.vast.created[0]])
  })

  it('a create whose reply is lost has still rented the instance, and it is found by its label (finding #151, plan 1.4)', async () => {
    const app = await w.boot()
    w.vast.addOffer()
    // Vast creates the instance, then the connection drops before the reply.
    w.vast.loseReply('createInstance', new Error('read ECONNRESET'))

    // The instance bills under this node's label, which is all the app has
    // to find it by: the reply that named it never came. The label lookup
    // finds it and the rental carries on, where it used to be left billing
    // unseen until the next start's orphan sweep.
    const [id] = await app.nodeManager.requestNodes(1)
    const live = w.vast.live()
    expect(live).toHaveLength(1)
    expect(w.vast.instance(live[0])?.label).toBe(labelOf(id))
    await w.until(() => app.nodeManager.get(id)?.state === 'ready', 'node ready')
    expect(w.get('SELECT instance_id, create_unknown_since FROM nodes WHERE id = ?', id)).toEqual({
      instance_id: live[0],
      create_unknown_since: null
    })
    expect(app.nodeManager.activeCount()).toBe(1)
    expect(w.vast.count('createInstance')).toBe(1)
  })

  it('onReady receives the same connection the node keeps', async () => {
    const app = await w.boot()
    let seen: SshConnection | null = null
    app.nodeManager.onReady = async ({ ssh }) => {
      seen = ssh
    }
    const id = await w.readyNode(app)
    expect(seen).not.toBeNull()
    expect(seen).toBe(app.nodeManager.get(id)?.ssh)
  })
})

// Plan 1.1: the cost timer charges one minute a tick, and a computer asleep
// runs no ticks. A night asleep with the fleet billing was metered as one
// minute: not in the session total, History or a job's cost (#66).
describe('1.1 time asleep is metered', () => {
  it('accrueElapsed charges each billing node for the time, less the tick that follows', async () => {
    const app = await w.boot()
    const id = await w.readyNode(app, { dph_total: 0.6 })
    const before = app.nodeManager.get(id)!.snapshot.accumulatedCost
    const logged = (): number =>
      w.get<{ t: number }>('SELECT COALESCE(SUM(delta_cost), 0) AS t FROM cost_log')!.t
    const usage = (): number =>
      w.get<{ t: number }>('SELECT COALESCE(SUM(delta_cost), 0) AS t FROM usage_log')!.t
    const [log0, use0] = [logged(), usage()]

    app.nodeManager.accrueElapsed(3 * 60 * 60_000)

    // 3 h less the minute the next tick charges: 179 min at $0.60/h.
    const expected = (0.6 * 179) / 60
    expect(app.nodeManager.get(id)!.snapshot.accumulatedCost - before).toBeCloseTo(expected, 6)
    expect(logged() - log0).toBeCloseTo(expected, 6)
    expect(usage() - use0).toBeCloseTo(expected, 6)
    // A sleep no longer than a tick is the tick's.
    app.nodeManager.accrueElapsed(45_000)
    expect(logged() - log0).toBeCloseTo(expected, 6)
  })
})
