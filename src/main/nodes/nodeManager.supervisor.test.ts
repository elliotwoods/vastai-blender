import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeState } from '../../shared/models'
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

  it('1.7: a node whose instance Vast no longer knows is let go, with no second DELETE', async () => {
    const { app, busy, jobId } = await renderingOnOne()
    const instanceId = instanceOf(busy)
    // Destroyed from the Vast console: the box is gone, and Vast says 404.
    await w.vast.destroyInstance(instanceId)

    await w.until(() => app.nodeManager.get(busy)?.state === 'destroyed', 'node let go')
    expect(w.vast.count('destroyInstance')).toBe(1)
    const row = w.get<{ destroyed_at: number | null; last_error: string }>(
      'SELECT destroyed_at, last_error FROM nodes WHERE id = ?',
      busy
    )!
    expect(row.destroyed_at).not.toBeNull()
    expect(row.last_error).toMatch(/Vast no longer knows its instance/)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(chunksOf(jobId)[0].state).not.toBe('rendering')
  })

  it('1.7 81fe2875: a node back from a minute off the network with its agent alive keeps its render; Blender is not killed', async () => {
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
