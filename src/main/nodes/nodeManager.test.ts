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
    expect(opts.label).toBe(`vastai-blender ${id.slice(0, 8)}`)

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
    expect(w.vast.instance(live[0])?.label).toBe(`vastai-blender ${id.slice(0, 8)}`)
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
