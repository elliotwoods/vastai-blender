import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeState } from '../../shared/models'
import { HANG, setup, type App, type World } from '../test/harness'

// What watches over a node once it is rented (plans 1.7 and 1.8): the
// deadline on provisioning, and the liveness supervision of a node in the
// fleet. Each scenario asserts what the money path must guarantee: a node
// that cannot work is destroyed rather than left billing, and one that can
// is not.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

const MIN = 60_000

/** Every state a node was shown in, consecutive repeats left out. */
function states(nodeId: string): NodeState[] {
  return w
    .eventsOf('node:changed')
    .filter((s) => s.id === nodeId)
    .map((s) => s.state)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
}

/**
 * onReady that stalls on its first command, as provision.sh does on a
 * download that neither finishes nor fails. `ended` once the command's
 * channel is closed under it.
 */
function stallProvisioning(app: App): { entered: boolean; ended: boolean } {
  const s = { entered: false, ended: false }
  app.nodeManager.onReady = async ({ id, ssh }) => {
    w.machineFor(id).onExec(/provision\.sh deps/, HANG)
    s.entered = true
    await ssh.exec('bash /root/vastai/provision.sh deps').finally(() => {
      s.ended = true
    })
  }
  return s
}

describe('1.8: provisioning has a deadline', () => {
  it('1.8 #37: a provision that stalls is failed and destroyed at 25 min, not left billing', async () => {
    const app = await w.boot()
    const prov = stallProvisioning(app)
    w.vast.addOffer()
    const [id] = await app.nodeManager.requestNodes(1)
    await w.until(() => prov.entered, 'provisioning under way')
    const start = Date.now()

    await w.advance(24 * MIN, 5_000)
    expect(app.nodeManager.get(id)?.state).toBe('provisioning')
    expect(w.vast.count('destroyInstance')).toBe(0)

    await w.until(() => app.nodeManager.get(id)?.state !== 'provisioning', 'deadline', {
      timeoutMs: 3 * MIN
    })
    expect(Date.now() - start).toBeLessThanOrEqual(25 * MIN + 500)
    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'stalled node destroyed')
    expect(states(id)).toEqual(['requested', 'provisioning', 'failed', 'destroyed'])
    expect(w.vast.live()).toEqual([])
    expect(w.vast.count('destroyInstance')).toBe(1)
    // The stalled command's channel went with the node's connection.
    expect(prov.ended).toBe(true)
    expect(w.alerts('error')).toEqual(['Node failed: provisioning did not finish within 25 min'])
    expect(app.nodeManager.activeCount()).toBe(0)
  })

  it('1.8: a resume whose provisioning stalls is destroyed at 25 min, not left provisioning', async () => {
    const app = await w.boot({ start: false })
    const prov = stallProvisioning(app)
    const id = randomUUID()
    const inst = w.vast.addInstance({ label: `vastai-blender ${id.slice(0, 8)}` })
    const machine = w.vast.machine(inst.id)
    const [ep] = machine.endpoints
    w.db
      .prepare(
        `INSERT INTO nodes (id, instance_id, state, gpu_name, num_gpus, dph_total, ssh_host,
           ssh_port, host_key, started_at, accumulated_cost, blender_versions)
         VALUES (?, ?, 'rendering', 'RTX 4090', 1, 0.4, ?, ?, ?, ?, 0, '[]')`
      )
      .run(id, inst.id, ep.host, ep.port, machine.hostKey, Date.now() - 3_600_000)
    app.nodeManager.init()
    await w.until(() => prov.entered, 'resume provisioning')

    await w.advance(24 * MIN, 5_000)
    expect(app.nodeManager.get(id)?.state).toBe('provisioning')

    await w.until(() => app.nodeManager.get(id)?.state === 'destroyed', 'stalled node destroyed', {
      timeoutMs: 3 * MIN
    })
    expect(states(id)).toEqual(['provisioning', 'failed', 'destroyed'])
    expect(w.vast.live()).toEqual([])
    expect(prov.ended).toBe(true)
    expect(w.alerts('warn')).toContain(
      `Node RTX 4090 ${id.slice(0, 8)}: provisioning did not finish within 25 min. Destroying it.`
    )
  })
})
