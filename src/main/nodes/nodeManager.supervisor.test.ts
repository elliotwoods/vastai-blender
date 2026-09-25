import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeState } from '../../shared/models'
import type { RawInstance } from '../vast/types'
import { DEAD_HEARTBEAT_S, emulateProvision, type ProvisionLog } from '../test/fakeProvision'
import { HANG, setup, type App, type FakeMachine, type World } from '../test/harness'

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

interface ChunkRow {
  id: string
  state: string
  node_id: string | null
  retries: number
  infra_retries: number
}

function chunksOf(jobId: string): ChunkRow[] {
  return w.all<ChunkRow>('SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start', jobId)
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

function instanceOf(nodeId: string): number {
  return w.get<{ instance_id: number }>('SELECT instance_id FROM nodes WHERE id = ?', nodeId)!
    .instance_id
}

/**
 * Two ready nodes whose provision.sh answers as the real one does
 * (fakeProvision.ts), and a one-chunk job rendering on one of them: `busy`,
 * with `idle` beside it. The agents render nothing by themselves.
 */
async function renderingOnOne(): Promise<{
  app: App
  busy: string
  idle: string
  jobId: string
  chunkId: string
  prov: Map<string, ProvisionLog>
}> {
  // Nothing scales down or rents meanwhile: the scenario is the two nodes.
  w.settings.idleTimeoutMinutes = 600
  const app = await w.boot()
  const ids = [await w.readyNode(app), await w.readyNode(app)]
  const prov = new Map(ids.map((id) => [id, emulateProvision(w.machineFor(id))]))
  const jobId = await w.submitJob(app)
  app.scheduler.kick()
  await w.until(() => chunksOf(jobId)[0]?.state === 'rendering', 'chunk rendering')
  const [chunk] = chunksOf(jobId)
  const busy = chunk.node_id!
  const idle = ids.find((id) => id !== busy)!
  w.machineFor(busy).agent.progress(chunk.id, 1, 2)
  return { app, busy, idle, jobId, chunkId: chunk.id, prov }
}

/** The machine drops off the network: connections refused, every channel on it ended. */
function dropOff(machine: FakeMachine): void {
  machine.kill()
}

/** ...and comes back, as it was. */
function comeBack(machine: FakeMachine): void {
  machine.alive = true
}

/** The agent finishes every spec that lands from now on, while it is alive. */
function finishWhenAlive(machine: FakeMachine): void {
  machine.onSpec = (spec) => {
    if (machine.agent.alive) machine.agent.finish(spec.chunkId)
  }
}

describe('1.7: liveness supervision', () => {
  it('1.7 1d59516c: a node Vast stops mid-render is out within 45 s, its chunk requeued and its instance destroyed', async () => {
    const { app, busy, idle, jobId, chunkId } = await renderingOnOne()
    const instanceId = instanceOf(busy)
    finishWhenAlive(w.machineFor(idle))
    // Vast stops the instance at a $0 balance: SSH is refused from here on.
    w.vast.patchInstance(instanceId, { actual_status: 'exited', intended_status: 'stopped' })
    dropOff(w.machineFor(busy))
    const stoppedAt = Date.now()

    await w.until(() => states(busy).includes('unreachable'), 'node taken out')
    expect(Date.now() - stoppedAt).toBeLessThanOrEqual(45_000 + 500)

    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'stopped node destroyed')
    expect(states(busy).slice(-4)).toEqual(['rendering', 'unreachable', 'destroying', 'destroyed'])
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.get('SELECT last_error FROM nodes WHERE id = ?', busy)).toEqual({
      last_error: expect.stringMatching(
        /SSH stopped answering \(.*ECONNREFUSED.*\) and Vast reports its instance exited/
      )
    })
    expect(w.alerts('warn').join('\n')).toMatch(
      /Vast reports its instance exited\. Destroying it\./
    )
    // The chunk went back to the queue, charged to the machine, and rendered
    // on the node that works.
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: idle, retries: 0, infra_retries: 1 }
    ])
    expect(app.nodeManager.activeCount()).toBe(1)
  })

  it('1.7: a node whose instance Vast no longer knows is let go once its DELETE is answered 404', async () => {
    const { app, busy, jobId } = await renderingOnOne()
    const instanceId = instanceOf(busy)
    // Destroyed from the Vast console: the box is gone, and Vast says 404.
    await w.vast.destroyInstance(instanceId)

    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'node let go')
    // The console's DELETE, then the app's, which the 404 confirms.
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId], [instanceId]])
    expect(states(busy).slice(-4)).toEqual(['rendering', 'unreachable', 'destroying', 'destroyed'])
    const row = w.get<{ destroyed_at: number | null; last_error: string }>(
      'SELECT destroyed_at, last_error FROM nodes WHERE id = ?',
      busy
    )!
    expect(row.destroyed_at).not.toBeNull()
    expect(row.last_error).toMatch(/Vast no longer knows its instance/)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(chunksOf(jobId)[0].state).not.toBe('rendering')
  })

  it('1.7: a node back from a minute off the network with its agent alive keeps its render; Blender is not killed', async () => {
    const { app, busy, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    await w.advance(30_000)
    comeBack(machine)

    await w.until(() => app.nodeManager.get(busy)?.state === 'rendering', 'back in service', {
      timeoutMs: 5 * MIN
    })
    // Asked, not restarted: the live agent and its render were left alone,
    // and the chunk never left the node.
    expect(prov.get(busy)!.statusCalls).toBe(1)
    expect(prov.get(busy)!.restarts).toEqual([])
    expect(prov.get(busy)!.killed).toEqual([])
    expect(machine.ran(/pkill|restart-agent|provision\.sh base/)).toEqual([])
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, state: 'rendering', retries: 0, infra_retries: 0 }
    ])
    expect(w.vast.count('destroyInstance')).toBe(0)

    machine.agent.finish(chunkId)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: busy, retries: 0, infra_retries: 0 })
  })

  it('1.7: a node back with its agent dead (a restarted container) has the agent restarted before it takes work', async () => {
    const { app, busy, idle, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    // The idle node keeps no work: whatever is requeued comes back here.
    await app.nodeManager.destroyNode(idle)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    // The container restarted: tmux, the agent and Blender are gone.
    machine.agent.alive = false
    comeBack(machine)
    finishWhenAlive(machine)

    await w.until(() => prov.get(busy)!.restarts.length > 0, 'agent restarted', {
      timeoutMs: 5 * MIN
    })
    expect(prov.get(busy)!.restarts).toEqual([
      { force: false, restarted: true, reason: `heartbeat stale (${DEAD_HEARTBEAT_S}s)` }
    ])
    expect(states(busy).slice(-3)).toEqual(['rendering', 'unreachable', 'ready'])
    expect(w.alerts('info').join('\n')).toMatch(/is back after .*: its agent was restarted/)
    // Its render died with the container: the chunk went back to the queue,
    // charged to the machine, and renders again on the node, now with an agent.
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, retries: 0, infra_retries: 1 }
    ])
    expect(w.vast.live()).toEqual([instanceOf(busy)])
  })

  it('1.7: an agent that dies while SSH answers is restarted within about a minute, and the node takes work again', async () => {
    const { app, busy, idle, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    await app.nodeManager.destroyNode(idle)
    finishWhenAlive(machine)
    machine.agent.alive = false
    const diedAt = Date.now()

    await w.until(() => prov.get(busy)!.restarts.length > 0, 'agent restarted', {
      timeoutMs: 5 * MIN
    })
    // Two probes 15 s apart see the heartbeat stale.
    expect(Date.now() - diedAt).toBeLessThanOrEqual(35_000)
    expect(prov.get(busy)!.restarts).toEqual([
      { force: false, restarted: true, reason: `heartbeat stale (${DEAD_HEARTBEAT_S}s)` }
    ])
    expect(prov.get(busy)!.killed).toEqual([chunkId])
    expect(states(busy).slice(-3)).toEqual(['rendering', 'provisioning', 'ready'])

    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, retries: 0, infra_retries: 1 }
    ])
    expect(w.vast.count('destroyInstance')).toBe(1) // the idle node's
  })

  it('1.7: one stale heartbeat is not a dead agent: nothing is restarted', async () => {
    const { app, busy, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    await w.advance(1_000)
    machine.agent.alive = false
    await w.advance(16_000)
    machine.agent.alive = true
    await w.advance(2 * MIN)
    expect(prov.get(busy)!.statusCalls).toBe(0)
    expect(prov.get(busy)!.restarts).toEqual([])
    expect(app.nodeManager.get(busy)?.state).toBe('rendering')
  })

  it('1.7: a blip shorter than the probe window leaves the node in the fleet', async () => {
    const { app, busy, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    dropOff(machine)
    await w.advance(20_000)
    comeBack(machine)
    await w.advance(2 * MIN)
    expect(states(busy)).not.toContain('unreachable')
    expect(app.nodeManager.get(busy)?.state).toBe('rendering')
    expect(prov.get(busy)!.statusCalls).toBe(0)
  })

  it('1.7: with this computer offline the nodes stay counted and are never destroyed; they come back with it', async () => {
    const { app, busy, idle, jobId, chunkId, prov } = await renderingOnOne()
    const offline = new Error('getaddrinfo ENOTFOUND console.vast.ai')
    Object.assign(offline, { code: 'ENOTFOUND' })
    let online = false
    const show = w.vast.showInstance.bind(w.vast)
    vi.spyOn(w.vast, 'showInstance').mockImplementation((id: number) =>
      online ? show(id) : Promise.reject(offline)
    )
    for (const id of [busy, idle]) dropOff(w.machineFor(id))

    await w.advance(25 * MIN, 5_000)
    for (const id of [busy, idle]) expect(app.nodeManager.get(id)?.state).toBe('unreachable')
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(app.nodeManager.activeCount()).toBe(2)
    expect(app.nodeManager.get(busy)?.snapshot.lastError).toMatch(/nor from Vast\.ai/)
    // Its run gave the chunk back after ten silent minutes (the scheduler's
    // own bound), so the render the node still has is nobody's now.
    expect(chunksOf(jobId)[0]).toMatchObject({ id: chunkId, retries: 0, infra_retries: 1 })

    online = true
    for (const id of [busy, idle]) comeBack(w.machineFor(id))
    await w.until(
      () => prov.get(busy)!.restarts.length > 0 && prov.get(idle)!.statusCalls > 0,
      'fleet back',
      { timeoutMs: 5 * MIN }
    )
    // Back, and asked about: the idle node's agent is kept; the render nobody
    // will collect is stopped rather than paid for.
    expect(prov.get(idle)!.restarts).toEqual([])
    expect(prov.get(busy)!.restarts).toEqual([{ force: true, restarted: true, reason: 'forced' }])
    expect(prov.get(busy)!.killed).toEqual([chunkId])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(app.nodeManager.activeCount()).toBe(2)
  })

  it('1.7: a node whose SSH never comes back while Vast says it runs is given up and destroyed', async () => {
    const { app, busy, jobId } = await renderingOnOne()
    dropOff(w.machineFor(busy))
    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'dead node destroyed', {
      timeoutMs: 20 * MIN,
      stepMs: 5_000
    })
    expect(states(busy).slice(-4)).toEqual(['rendering', 'unreachable', 'failed', 'destroyed'])
    expect(w.alerts('warn').join('\n')).toMatch(
      /SSH did not come back: .*ECONNREFUSED.*Destroying it\./
    )
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
  })

  it('1.7: an agent that keeps dying is given up on after three restarts within the hour', async () => {
    const { app, busy, idle, prov } = await renderingOnOne()
    await app.nodeManager.destroyNode(idle)
    const machine = w.machineFor(busy)
    for (let i = 1; i <= 3; i++) {
      machine.agent.alive = false
      await w.until(() => prov.get(busy)!.restarts.length === i, `restart ${i}`, {
        timeoutMs: 5 * MIN
      })
      await w.until(() => app.nodeManager.get(busy)?.state === 'ready', `back ${i}`)
    }
    machine.agent.alive = false
    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'given up', {
      timeoutMs: 5 * MIN
    })
    expect(prov.get(busy)!.restarts).toHaveLength(3)
    expect(w.alerts('warn').join('\n')).toMatch(/restarted 3 times within the hour/)
  })

  it('1.7: a container back on other ports is found on the ones Vast now lists', async () => {
    const { app, busy, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    // Back, with its SSH ports mapped anew: the old endpoint leads nowhere.
    const moved = machine.endpoints.map((e) => ({ host: e.host, port: e.port + 1 }))
    machine.endpoints.splice(0, machine.endpoints.length, ...moved)
    comeBack(machine)

    await w.until(() => app.nodeManager.get(busy)?.state === 'rendering', 'back in service', {
      timeoutMs: 15 * MIN
    })
    expect(w.get('SELECT ssh_host, ssh_port FROM nodes WHERE id = ?', busy)).toEqual({
      ssh_host: moved[0].host,
      ssh_port: moved[0].port
    })
    expect(prov.get(busy)!.restarts).toEqual([])
    expect(chunksOf(jobId)[0]).toMatchObject({ id: chunkId, node_id: busy, infra_retries: 0 })
    expect(w.vast.count('destroyInstance')).toBe(0)
  })

  it('1.7: a connection back but not answering yet is not taken for the node answering', async () => {
    // ssh2 hands back a connection whose far end went silent as live until
    // its keepalive gives up on it: the first command on it waits for nothing.
    const { app, busy, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    machine.onExec(/^echo ok$|provision\.sh agent-status$/, HANG, 1)
    comeBack(machine)

    await w.until(() => app.nodeManager.get(busy)?.state === 'rendering', 'back in service', {
      timeoutMs: 5 * MIN
    })
    expect(prov.get(busy)!.restarts).toEqual([])
    expect(chunksOf(jobId)[0]).toMatchObject({ id: chunkId, node_id: busy, infra_retries: 0 })
    expect(w.vast.count('destroyInstance')).toBe(0)
  })

  it('1.7: a node Vast stops while it is being reconnected is let go within minutes, not ten', async () => {
    const { app, busy } = await renderingOnOne()
    const instanceId = instanceOf(busy)
    dropOff(w.machineFor(busy))
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    w.vast.patchInstance(instanceId, { actual_status: 'exited', intended_status: 'stopped' })
    const stoppedAt = Date.now()

    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'let go', {
      timeoutMs: 15 * MIN,
      stepMs: 5_000
    })
    expect(Date.now() - stoppedAt).toBeLessThanOrEqual(3 * MIN)
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
  })

  it('1.7: a node Vast answers about with no instance is destroyed, not written off unconfirmed', async () => {
    // showInstance reads a 200 without an instance as "gone", the same as a
    // 404. Taken on trust, the row was stamped destroyed while the instance
    // billed on.
    const { app, busy } = await renderingOnOne()
    const instanceId = instanceOf(busy)
    const show = w.vast.showInstance.bind(w.vast)
    vi.spyOn(w.vast, 'showInstance')
      .mockImplementationOnce(() => Promise.resolve(null as unknown as RawInstance))
      .mockImplementation((id: number) => show(id))
    dropOff(w.machineFor(busy))

    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'node let go')
    expect(w.vast.argsOf('destroyInstance')).toEqual([[instanceId]])
    expect(w.vast.live()).not.toContain(instanceId)
  })

  it('1.7: shutting down while a node is being recovered destroys nothing', async () => {
    // Quit with "leave running": the app closes every connection on its way
    // out, which a recovery under way must not take for the node failing.
    const { app, busy } = await renderingOnOne()
    dropOff(w.machineFor(busy))
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    await w.advance(30_000)
    app.scheduler.stop()
    app.nodeManager.shutdown()
    await w.advance(15 * MIN, 5_000)
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(app.nodeManager.get(busy)?.state).toBe('unreachable')
  })

  it('1.7: shutting down while Vast is asked about a silent node opens no connection to it', async () => {
    const { app, busy, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    const asked = w.vast.hold('showInstance')
    dropOff(machine)
    await w.until(() => asked.reached, 'Vast asked')
    app.scheduler.stop()
    app.nodeManager.shutdown()
    comeBack(machine)
    const connects = machine.connects
    asked.release()
    await w.advance(5 * MIN, 5_000)
    // Nothing reconnected to a node the user chose to leave running, and
    // nothing restarted its agent.
    expect(machine.connects).toBe(connects)
    expect(prov.get(busy)!.statusCalls).toBe(0)
    expect(prov.get(busy)!.restarts).toEqual([])
    expect(w.vast.count('destroyInstance')).toBe(0)
  })

  it('1.7: the snapshot says when the node last answered', async () => {
    const { app, busy } = await renderingOnOne()
    await w.advance(20_000)
    const answered = app.nodeManager.get(busy)!.snapshot.lastContactAt!
    expect(Date.now() - answered).toBeLessThanOrEqual(15_000)
    dropOff(w.machineFor(busy))
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    expect(app.nodeManager.get(busy)!.snapshot.lastContactAt).toBeLessThanOrEqual(answered + 15_000)
    expect(app.nodeManager.get(busy)!.snapshot.lastError).toMatch(/^no answer over SSH for \d+s: /)
  })
})

/**
 * The link goes again, for `downMs`, the moment the node is asked `what`:
 * a laptop's Wi-Fi flapping just after it wakes. Once.
 */
function dropUnder(machine: FakeMachine, what: RegExp, downMs: number): void {
  machine.onExec(
    what,
    (_c, _m, mc) => {
      mc.kill()
      setTimeout(() => comeBack(mc), downMs)
      return HANG
    },
    1
  )
}

describe('1.7: a link that drops under the agent check costs a round, not the node', () => {
  it('1.7: a node back from the network whose link drops again under agent-status keeps its render', async () => {
    const { app, busy, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    await w.advance(30_000)
    dropUnder(machine, /provision\.sh agent-status$/, 20_000)
    comeBack(machine)

    await w.until(() => app.nodeManager.get(busy)?.state === 'rendering', 'back in service', {
      timeoutMs: 8 * MIN
    })
    // Asked again once it answered again, and kept: nothing restarted, the
    // render and its chunk never left the node, nothing destroyed.
    expect(machine.ran(/provision\.sh agent-status$/)).toHaveLength(2)
    expect(prov.get(busy)!.statusCalls).toBe(1)
    expect(prov.get(busy)!.restarts).toEqual([])
    expect(prov.get(busy)!.killed).toEqual([])
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, state: 'rendering', retries: 0, infra_retries: 0 }
    ])
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.alerts('warn')).toEqual([])
  })

  it('1.7: a node back late in its reconnect budget survives a drop under the agent check', async () => {
    const { app, busy } = await renderingOnOne()
    const machine = w.machineFor(busy)
    const instanceId = instanceOf(busy)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    await w.advance(9 * MIN + 30_000, 5_000)
    expect(app.nodeManager.get(busy)?.state).toBe('unreachable')
    // Back just before the budget runs out, and gone again for a minute
    // under the agent check, which ends past it.
    dropUnder(machine, /provision\.sh agent-status$/, MIN)
    comeBack(machine)

    // Its chunk went back after ten silent minutes (the scheduler's own
    // bound), so the node comes back to no work: 'ready', not destroyed.
    await w.until(() => app.nodeManager.get(busy)?.state === 'ready', 'back in service', {
      timeoutMs: 8 * MIN
    })
    expect(machine.ran(/provision\.sh agent-status$/)).toHaveLength(2)
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.vast.live()).toContain(instanceId)
  })

  it('1.7: a node back with its agent dead whose link drops under restart-agent is restarted on the next round', async () => {
    const { app, busy, idle, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    await app.nodeManager.destroyNode(idle)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    machine.agent.alive = false
    dropUnder(machine, /provision\.sh restart-agent$/, 20_000)
    comeBack(machine)
    finishWhenAlive(machine)

    await w.until(() => app.nodeManager.get(busy)?.state === 'ready', 'back in service', {
      timeoutMs: 8 * MIN
    })
    expect(machine.ran(/provision\.sh restart-agent$/)).toHaveLength(2)
    expect(prov.get(busy)!.restarts).toEqual([
      { force: false, restarted: true, reason: `heartbeat stale (${DEAD_HEARTBEAT_S}s)` }
    ])
    expect(w.vast.count('destroyInstance')).toBe(1) // the idle node's
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, retries: 0, infra_retries: 1 }
    ])
    expect(w.vast.live()).toEqual([instanceOf(busy)])
  })

  it('1.7: a dead agent whose check loses the link is restarted once the node answers again', async () => {
    const { app, busy, idle, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    await app.nodeManager.destroyNode(idle)
    finishWhenAlive(machine)
    dropUnder(machine, /provision\.sh agent-status$/, 5_000)
    machine.agent.alive = false

    await w.until(() => prov.get(busy)!.restarts.length > 0, 'agent restarted', {
      timeoutMs: 5 * MIN
    })
    expect(prov.get(busy)!.restarts).toEqual([
      { force: false, restarted: true, reason: `heartbeat stale (${DEAD_HEARTBEAT_S}s)` }
    ])
    await w.until(() => app.nodeManager.get(busy)?.state === 'ready', 'back in service')
    expect(states(busy).slice(-4)).toEqual(['rendering', 'provisioning', 'unreachable', 'ready'])
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, retries: 0, infra_retries: 1 }
    ])
    expect(w.vast.count('destroyInstance')).toBe(1) // the idle node's
    expect(w.alerts('warn').join('\n')).not.toMatch(/Destroying it/)
  })

  it('1.7: a dead agent whose restart loses the link is restarted once the node answers again', async () => {
    const { app, busy, idle, jobId, chunkId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    await app.nodeManager.destroyNode(idle)
    finishWhenAlive(machine)
    dropUnder(machine, /provision\.sh restart-agent$/, 5_000)
    machine.agent.alive = false

    await w.until(() => prov.get(busy)!.restarts.length > 0, 'agent restarted', {
      timeoutMs: 5 * MIN
    })
    await w.until(() => app.nodeManager.get(busy)?.state === 'ready', 'back in service')
    expect(machine.ran(/provision\.sh restart-agent$/)).toHaveLength(2)
    expect(states(busy).slice(-4)).toEqual(['rendering', 'provisioning', 'unreachable', 'ready'])
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(chunksOf(jobId)).toMatchObject([
      { id: chunkId, node_id: busy, retries: 0, infra_retries: 1 }
    ])
    expect(w.vast.count('destroyInstance')).toBe(1) // the idle node's
    expect(w.alerts('warn').join('\n')).not.toMatch(/Destroying it/)
  })

  it('1.7: another restart-agent holding the node is waited out, not taken for a broken node', async () => {
    const { app, busy, idle, jobId, prov } = await renderingOnOne()
    const machine = w.machineFor(busy)
    await app.nodeManager.destroyNode(idle)
    finishWhenAlive(machine)
    // provision.sh's answer when another restart-agent held its lock for 90 s.
    machine.onExec(
      /provision\.sh restart-agent$/,
      {
        code: 1,
        stdout: '[provision] another restart-agent still running after 90s — nothing done\n'
      },
      2
    )
    machine.agent.alive = false

    await w.until(() => prov.get(busy)!.restarts.length > 0, 'agent restarted', {
      timeoutMs: 8 * MIN
    })
    await w.until(() => app.nodeManager.get(busy)?.state === 'ready', 'back in service')
    expect(machine.ran(/provision\.sh restart-agent$/)).toHaveLength(3)
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 20 * MIN })
    expect(w.vast.count('destroyInstance')).toBe(1) // the idle node's
    expect(w.alerts('warn').join('\n')).not.toMatch(/Destroying it/)
  })

  it('1.7: a link that drops under every agent check is given up on, bounded', async () => {
    const { app, busy, jobId } = await renderingOnOne()
    const machine = w.machineFor(busy)
    dropOff(machine)
    await w.until(() => app.nodeManager.get(busy)?.state === 'unreachable', 'unreachable')
    machine.onExec(/provision\.sh agent-status$/, (_c, _m, mc) => {
      mc.kill()
      setTimeout(() => comeBack(mc), 5_000)
      return HANG
    })
    comeBack(machine)
    const backAt = Date.now()

    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'given up', {
      timeoutMs: 30 * MIN,
      stepMs: 5_000
    })
    // The ten-minute budget, and at most three two-minute graces for the
    // agent check after a late reconnect.
    expect(Date.now() - backAt).toBeLessThanOrEqual(20 * MIN)
    expect(w.alerts('warn').join('\n')).toMatch(
      /SSH answers again, but the agent could not be brought back: .*connection closed under provision\.sh agent-status.*Destroying it\./
    )
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
  })
})

describe('1.7: work the app gave back while a node was silent', () => {
  it('1.7: a chunk cancelled while its node was silent is stopped there when the node comes back; the rest keep rendering', async () => {
    w.settings.idleTimeoutMinutes = 600
    const app = await w.boot()
    const node = await w.readyNode(app, { num_gpus: 2 })
    const machine = w.machineFor(node)
    const prov = emulateProvision(machine)
    const keptJob = await w.submitJob(app, { blendPath: w.blend('kept.blend') })
    const cancelledJob = await w.submitJob(app, { blendPath: w.blend('cancelled.blend') })
    app.scheduler.kick()
    await w.until(
      () => [keptJob, cancelledJob].every((j) => chunksOf(j)[0]?.state === 'rendering'),
      'both rendering'
    )
    const [kept] = chunksOf(keptJob)
    const [cancelled] = chunksOf(cancelledJob)
    expect([kept.node_id, cancelled.node_id]).toEqual([node, node])
    for (const c of [kept, cancelled]) machine.agent.progress(c.id, 1, 2)

    dropOff(machine)
    await w.until(() => app.nodeManager.get(node)?.state === 'unreachable', 'unreachable')
    // The cancel's own pkill cannot reach the node.
    await app.scheduler.cancelJob(cancelledJob)
    comeBack(machine)

    await w.until(() => app.nodeManager.get(node)?.state === 'rendering', 'back in service', {
      timeoutMs: 5 * MIN
    })
    // The cancelled chunk's render is stopped, the kept one's left alone,
    // and the agent is not restarted.
    expect(prov.killed).toEqual([cancelled.id])
    expect(prov.restarts).toEqual([])
    expect(chunksOf(keptJob)).toMatchObject([
      { id: kept.id, node_id: node, state: 'rendering', infra_retries: 0 }
    ])
    machine.agent.finish(kept.id)
    await w.until(() => jobState(keptJob) === 'complete', 'kept job complete')
    expect(w.vast.count('destroyInstance')).toBe(0)
  })
})
