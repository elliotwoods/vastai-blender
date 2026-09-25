import { mkdirSync, promises as fsp, readFileSync, writeFileSync, type StatsFs } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddonInfo } from '../../shared/models'
import { fakeOctane } from '../test/fakeOctane'
import { FakeSshConnection, HANG } from '../test/fakeSsh'
import {
  setup,
  type AgentSpec,
  type AgentStateFile,
  type App,
  type FakeMachine,
  type SetupOptions,
  type World
} from '../test/harness'

// The retry policy (plans 1.16, 1.17, 1.20), end to end on the lifecycle
// harness: a failed attempt is charged to whoever failed it. The machines'
// and the network's failures never spend a render retry, a scene no node can
// render fails its job once, and the same failure on two nodes holds the job
// for the user instead of spending the fleet on it.

let w: World
afterEach(async () => {
  await w.dispose()
  vi.restoreAllMocks()
})

interface ChunkRow {
  id: string
  state: string
  node_id: string | null
  retries: number
  infra_retries: number
  not_before: number | null
  error_kind: string | null
  frame_start: number
  frame_end: number
}

function chunksOf(jobId: string): ChunkRow[] {
  return w.all<ChunkRow>('SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start', jobId)
}

function chunkRow(id: string): ChunkRow {
  return w.get<ChunkRow>('SELECT * FROM chunks WHERE id = ?', id)!
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

function settled(jobId: string): boolean {
  return ['complete', 'partial', 'failed'].includes(jobState(jobId) ?? '')
}

function downloaded(jobId: string): number[] {
  return w
    .all<{ frame: number }>(
      "SELECT frame FROM frames WHERE job_id = ? AND state = 'downloaded' ORDER BY frame",
      jobId
    )
    .map((f) => f.frame)
}

/** Chunks dispatched to a node: every 'assigned' the renderer heard with its id. */
function assignedTo(nodeId: string): number {
  return w.eventsOf('chunk:changed').filter((c) => c.state === 'assigned' && c.nodeId === nodeId)
    .length
}

function nodeError(nodeId: string): string | null {
  return w.get<{ last_error: string | null }>('SELECT last_error FROM nodes WHERE id = ?', nodeId)!
    .last_error
}

async function nodes(
  n: number,
  opts: Pick<SetupOptions, 'secrets'> = {}
): Promise<{ app: App; ids: string[] }> {
  w = await setup({ settings: { maxActiveNodes: n }, ...opts })
  const app = await w.boot()
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await w.readyNode(app))
  return { app, ids }
}

function nodeState(nodeId: string): string {
  return w.get<{ state: string }>('SELECT state FROM nodes WHERE id = ?', nodeId)!.state
}

function attentionOf(jobId: string): string | null {
  return w.get<{ attention: string | null }>('SELECT attention FROM jobs WHERE id = ?', jobId)!
    .attention
}

/** addons.ts's registry.json, under the harness's userData, as `text`. */
function writeRegistry(text: string): void {
  const dir = join(w.dir, 'electron', 'userData', 'addons')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'registry.json'), text)
}

/** Every command any machine of the world was sent that matches. */
function ranAnywhere(ids: string[], pattern: RegExp): string[] {
  return ids.flatMap((id) => w.machineFor(id).ran(pattern))
}

/** What the agent reports for a render stopped out of GPU memory. */
const outOfMemory = {
  error: 'out of GPU memory on GPU 0 (exit -15): CUDA error: Out of memory in cuMemAlloc',
  exitCode: -15,
  errorKind: 'machine',
  oom: true,
  gpu: 0
}

/**
 * Give each node the job's scene as dispatch sends it (plan 1.12), as nodes
 * that already hold it do. A node's first dispatch otherwise uploads it while
 * its retries only check for it, and a test whose bound assumes two nodes
 * failing in step would see one node retry alone while the other uploads.
 */
function sceneAlreadyOn(ids: string[], jobId: string): void {
  const scene = w.get<{ blend_sha256: string; scene_path: string }>(
    'SELECT blend_sha256, scene_path FROM jobs WHERE id = ?',
    jobId
  )!
  for (const id of ids) {
    w.machineFor(id).files.set(
      `/root/vastai/work/scenes/${scene.blend_sha256}.blend`,
      readFileSync(scene.scene_path)
    )
  }
}

/** The agent reports a failed chunk, with what the real one adds to a failure. */
function failWith(machine: FakeMachine, chunkId: string, state: Record<string, unknown>): void {
  machine.agent.fail(chunkId, String(state.error ?? ''), (state.exitCode as number) ?? 1)
  machine.agent.writeState(chunkId, {
    status: 'failed',
    framesDone: 0,
    logTail: ['Blender 4.2.3', 'Read blend: /root/vastai/work/scenes/x.blend'],
    ...state
  } as Partial<AgentStateFile>)
}

describe('field incident 1d59516c: two of three nodes stopped by Vast at a $0 balance', () => {
  /**
   * What a stopped instance looks like from here. Vast stops it; the app
   * still has the node idle; every SSH connect is refused. Node refuses a
   * host with several addresses as an AggregateError with an empty message
   * and the code on it, which is how every alert of the incident read
   * "dispatch … failed: " with nothing after the colon.
   */
  function stopAtZeroBalance(nodeId: string): void {
    const instanceId = w.get<{ instance_id: number }>(
      'SELECT instance_id FROM nodes WHERE id = ?',
      nodeId
    )!.instance_id
    const machine = w.machineFor(nodeId)
    w.vast.patchInstance(instanceId, { actual_status: 'stopped', cur_state: 'stopped' })
    machine.kill()
    stopped.add(machine)
  }

  const stopped = new Set<FakeMachine>()

  function refusedLikeNode(host: string, port: number): Error {
    const part = (address: string): Error =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:${port}`), {
        code: 'ECONNREFUSED',
        errno: -61,
        syscall: 'connect',
        address,
        port
      })
    return Object.assign(new AggregateError([part(host), part('::1')], ''), {
      code: 'ECONNREFUSED'
    })
  }

  it('1.20 1d59516c: dispatches to the stopped nodes spend no render retry, every alert says why, and the healthy node renders the job', async () => {
    const { app, ids } = await nodes(3)
    stopped.clear()
    const acquire = FakeSshConnection.prototype.acquire
    vi.spyOn(FakeSshConnection.prototype, 'acquire').mockImplementation(async function (
      this: FakeSshConnection
    ) {
      const machine = w.network.find(this.host, this.port)
      if (machine && stopped.has(machine)) throw refusedLikeNode(this.host, this.port)
      return acquire.call(this)
    })
    // The healthy node is last, so the stopped ones are offered work first.
    const [deadA, deadB, healthy] = ids
    w.machineFor(healthy).agent.autoFinish()
    stopAtZeroBalance(deadA)
    stopAtZeroBalance(deadB)

    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 16, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled', { timeoutMs: 60 * 60_000 })

    // Every chunk moved to the node that works, and every frame arrived.
    expect(jobState(jobId)).toBe('complete')
    expect(downloaded(jobId)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    const chunks = chunksOf(jobId)
    // Not one render retry spent on a node that could not be reached; the
    // machines' failures are counted apart.
    expect(chunks.map((c) => c.retries)).toEqual(chunks.map(() => 0))
    expect(chunks.reduce((n, c) => n + c.infra_retries, 0)).toBeGreaterThanOrEqual(2)
    expect(chunks.filter((c) => c.infra_retries > 0).map((c) => c.error_kind)).toEqual(
      chunks.filter((c) => c.infra_retries > 0).map(() => 'machine')
    )
    // Each stopped node was tried, then rested, not fed chunk after chunk.
    for (const dead of [deadA, deadB]) {
      expect(assignedTo(dead)).toBeGreaterThanOrEqual(1)
      expect(assignedTo(dead)).toBeLessThanOrEqual(4)
    }
    // No reason is empty, and each names what happened.
    const alerts = w.alerts()
    expect(alerts.filter((a) => /:\s*$/.test(a) || /: —/.test(a))).toEqual([])
    const dispatchFailed = alerts.filter((a) => a.startsWith('dispatch '))
    expect(dispatchFailed.length).toBeGreaterThanOrEqual(2)
    for (const a of dispatchFailed) {
      expect(a).toMatch(/node unreachable over SSH: .*ECONNREFUSED/)
      expect(a).toContain('without charging the render')
    }
    // The stopped nodes say why they get no work; the healthy one says nothing.
    expect(nodeError(deadA)).toMatch(/ECONNREFUSED/)
    expect(nodeError(deadB)).toMatch(/ECONNREFUSED/)
    expect(nodeError(healthy)).toBeNull()
    // Not the job's fault: nothing held it.
    expect(w.get('SELECT attention FROM jobs WHERE id = ?', jobId)).toEqual({ attention: null })
  })
})

describe('1.16: a job no node can render fails once, with the reason', () => {
  const summary =
    "1 file(s) not packed into the .blend and not on the node: image 'wood' (//tex/wood.png)"
  const cases = [
    {
      name: 'a scene the preflight refuses',
      attention: 'scene',
      said: 'not packed',
      state: {
        error: `scene preflight failed: ${summary}`,
        exitCode: 32,
        errorKind: 'scene',
        preflight: {
          ok: false,
          summary,
          missing: [{ kind: 'image', name: 'wood', path: '//tex/wood.png', packable: true }],
          problems: [],
          warnings: []
        }
      }
    },
    {
      name: 'an Octane job on nodes without OctaneBlender',
      attention: 'engine',
      said: 'OctaneBlender is not installed',
      state: {
        error:
          'Octane job, but OctaneBlender is not installed on this node ' +
          '(/usr/local/OctaneBlender/blender); stock Blender would render it with another engine',
        exitCode: null,
        errorKind: 'job'
      }
    }
  ]

  for (const c of cases) {
    it(`1.16: ${c.name} fails the job once, with the reason, and nothing more of it is sent`, async () => {
      const { app, ids } = await nodes(2)
      const specs: AgentSpec[] = []
      for (const id of ids) {
        const machine = w.machineFor(id)
        machine.onSpec = (spec) => {
          specs.push(spec)
          failWith(machine, spec.chunkId, c.state)
        }
      }
      const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
      app.scheduler.kick()
      await w.until(() => jobState(jobId) === 'failed', 'job failed')
      // Ticks enough to have retried every chunk several times over.
      await w.advance(5 * 60_000)

      // Failed, and it stays failed while the chunk still in flight settles.
      expect(jobState(jobId)).toBe('failed')
      const job = await w.invoke('job:get', jobId)
      expect(job?.attention).toMatchObject({
        kind: c.attention,
        message: expect.stringContaining(c.said)
      })
      // One attempt per node, then nothing: no chunk was sent again.
      expect(specs).toHaveLength(2)
      expect(chunksOf(jobId).map((r) => [r.state, r.retries])).toEqual(
        chunksOf(jobId).map(() => ['failed', 0])
      )
      // Said once, as the job's failure, not once per chunk.
      expect(w.alerts('error').filter((a) => a.includes(c.said))).toHaveLength(1)
      expect(w.alerts().filter((a) => /^chunk .* failed/.test(a))).toEqual([])
      // Nothing rented for it either.
      expect(w.vast.count('createInstance')).toBe(2)
    })
  }

  it('1.16: the spec tells the preflight how many chunks the job is split into', async () => {
    const { app, ids } = await nodes(1)
    const specs: AgentSpec[] = []
    const machine = w.machineFor(ids[0])
    machine.onSpec = (spec) => {
      specs.push(spec)
      machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 6, chunkSize: 2 })
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(specs.map((s) => s.jobChunks)).toEqual([3, 3, 3])
  })

  it("1.16: the scene's real engine, as the agent reports it, becomes the job's", async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    machine.onSpec = (spec) => {
      machine.agent.writeState(spec.chunkId, {
        status: 'rendering',
        engine: 'eevee'
      } as Partial<AgentStateFile>)
      // The next poll reads that before the chunk finishes.
      setTimeout(() => machine.agent.finish(spec.chunkId), 6_000)
    }
    const jobId = await w.submitJob(app, { engine: 'cycles' })
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(w.get('SELECT engine FROM jobs WHERE id = ?', jobId)).toEqual({ engine: 'eevee' })
    expect(w.eventsOf('job:changed').at(-1)).toMatchObject({ id: jobId, engine: 'eevee' })
  })

  it('A12: an add-on gone from the registry fails the job; it never renders without it', async () => {
    const { app, ids } = await nodes(1)
    // The registry reads, and lists add-ons, just not this one.
    const other: AddonInfo = {
      id: 'still-registered',
      name: 'Still registered',
      version: '1.0.0',
      zipPath: join(w.dir, 'still-registered.zip'),
      zipHash: 'a'.repeat(64),
      mechanism: 'install'
    }
    writeRegistry(JSON.stringify([other]))
    const specs: AgentSpec[] = []
    w.machineFor(ids[0]).onSpec = (spec) => void specs.push(spec)
    const jobId = await w.submitJob(app, { addonIds: ['gone-from-the-registry'] })
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'failed', 'job failed')
    await w.advance(60_000)

    expect(specs).toEqual([])
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'extension',
      message: expect.stringContaining('gone-from-the-registry')
    })
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'failed', retries: 0 })
    expect(w.alerts().filter((a) => a.includes('skipped'))).toEqual([])
  })

  it('A12: a registry that cannot be read is not an add-on gone: the job is held, never failed', async () => {
    const { app, ids } = await nodes(1)
    // What loadRegistry makes of an EMFILE, or of an EBUSY while Windows
    // renames the file under it: nothing, the same as no add-ons at all.
    writeRegistry('{ "half-written')
    const specs: AgentSpec[] = []
    w.machineFor(ids[0]).onSpec = (spec) => void specs.push(spec)
    const jobId = await w.submitJob(app, { addonIds: ['my-addon'] })
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => attentionOf(jobId) !== null, 'job held')

    // Tried again after a wait, then held on the second: this computer's
    // registry is the same whichever node asks.
    expect(jobState(jobId)).not.toBe('failed')
    expect(specs).toEqual([])
    expect(chunkRow(chunk.id)).toMatchObject({
      state: 'pending',
      retries: 0,
      infra_retries: 2,
      error_kind: 'localFs'
    })
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'repeatedFailure',
      errorClass: 'localFs',
      message: expect.stringContaining('add-on registry could not be read')
    })
    // The node was not the problem: nothing rests it or marks it.
    expect(nodeError(ids[0])).toBeNull()
  })
})

describe("1.16: the engine a node reports is the node's word", () => {
  const otoy = { secrets: { otoyUsername: 'someone@example.com', otoyPassword: 'hunter2' } }

  it('1.16: a Cycles job whose node says Octane keeps its engine, fails, and no OTOY credential is sent', async () => {
    const { app, ids } = await nodes(1, otoy)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      // A host that wants the user's OTOY sign-in writes this, and finishes
      // (unless the app has withdrawn the spec by then).
      machine.agent.writeState(spec.chunkId, {
        status: 'rendering',
        engine: 'octane'
      } as Partial<AgentStateFile>)
      setTimeout(() => {
        if (machine.agent.spec(spec.chunkId)) machine.agent.finish(spec.chunkId)
      }, 6_000)
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled')
    await w.advance(2 * 60_000)

    expect(jobState(jobId)).toBe('failed')
    expect(w.get('SELECT engine FROM jobs WHERE id = ?', jobId)).toEqual({ engine: 'cycles' })
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'engine',
      message: expect.stringContaining('renders with Octane')
    })
    // Nothing Octane ran anywhere, and no credential left this computer.
    expect(ranAnywhere(ids, /setup_octane|OCTANE_USER|OCTANE_PASS|hunter2/)).toEqual([])
    // The render was stopped (withdrawn once, and killed again once the
    // agent could have relaunched it), and the job's other chunk never sent.
    expect(specs).toHaveLength(1)
    expect(
      machine.ran(new RegExp(`inbox/${specs[0].chunkId}\\.json'; pkill -f '${specs[0].chunkId}'`))
    ).toHaveLength(1)
  })

  it("1.16: the node's engine is quoted to the user only when it is an engine's name", async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    fakeOctane(machine)
    // Whatever a host writes into the state file reaches the job's reason.
    const said =
      'cycles. your otoy licence has expired: sign in again at https://example.invalid/otoy ' +
      'x'.repeat(2_000)
    machine.onSpec = (spec) => {
      machine.agent.writeState(spec.chunkId, {
        status: 'rendering',
        engine: said
      } as Partial<AgentStateFile>)
      setTimeout(() => {
        if (machine.agent.spec(spec.chunkId)) machine.agent.finish(spec.chunkId)
      }, 6_000)
    }
    const jobId = await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled')

    expect(jobState(jobId)).toBe('failed')
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'engine',
      message: expect.stringContaining('the scene renders with an unknown engine')
    })
    expect(job?.attention?.message).not.toContain('example.invalid')
    expect(w.alerts().filter((a) => a.includes('example.invalid') || a.includes('xxxx'))).toEqual(
      []
    )
  })

  it('1.16: a render stopped for its engine on a wedged connection still lets its node go', async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    machine.onSpec = (spec) => {
      machine.agent.writeState(spec.chunkId, {
        status: 'rendering',
        engine: 'octane'
      } as Partial<AgentStateFile>)
    }
    // The connection wedges as the render is withdrawn: the command is never
    // answered, as an exec on a dead socket is not.
    machine.onExec(/jobs\/inbox\/.*pkill -f/, HANG)
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()

    // Settled within the retract's own deadline, not held in flight for good
    // with its node 'rendering', which scale-down never lets go.
    await w.until(() => jobState(jobId) === 'failed', 'job failed', { timeoutMs: 2 * 60_000 })
    expect(chunkRow(chunk.id).state).toBe('failed')
    expect(app.scheduler.isLive(chunk.id)).toBe(false)
    await w.until(() => nodeState(ids[0]) === 'idle', 'node idle', { timeoutMs: 60_000 })
  })

  it('1.16: an Octane job whose node says Cycles keeps its engine and fails', async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    fakeOctane(machine)
    machine.onSpec = (spec) => {
      machine.agent.writeState(spec.chunkId, {
        status: 'rendering',
        engine: 'cycles'
      } as Partial<AgentStateFile>)
      setTimeout(() => {
        if (machine.agent.spec(spec.chunkId)) machine.agent.finish(spec.chunkId)
      }, 6_000)
    }
    const jobId = await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled')

    expect(jobState(jobId)).toBe('failed')
    expect(w.get('SELECT engine FROM jobs WHERE id = ?', jobId)).toEqual({ engine: 'octane' })
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'engine',
      message: expect.stringContaining('scene renders with cycles')
    })
  })
})

describe('1.20: an agent failure with no error text (field incident 1d59516c)', () => {
  it("names what blender's log says, from the failed state's logTail", async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    let failed = false
    machine.onSpec = (spec) => {
      if (failed) return machine.agent.finish(spec.chunkId)
      failed = true
      failWith(machine, spec.chunkId, {
        error: '',
        exitCode: 1,
        logTail: ['Fra:1 Mem:12M', 'Error: Cannot read file "//tex/wood.png"', 'Fra:1 Mem:12M']
      })
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(w.alerts('warn').join('\n')).toMatch(
      /chunk \S+ failed: render failed: blender's log ends: Error: Cannot read file "\/\/tex\/wood\.png" \(exit 1\)/
    )
  })
})

describe('1.17: the machines and the network are not the render', () => {
  it('1.17: a transient SSH error is retried after a backoff, without spending a render retry', async () => {
    const { app, ids } = await nodes(1)
    const [nodeId] = ids
    const machine = w.machineFor(nodeId)
    machine.agent.autoFinish()
    // The node's sshd has no channel to spare for the first scene-hash check.
    machine.onExec(
      /^sha256sum /,
      () => Promise.reject(new Error('(SSH) Channel open failure: open failed')),
      1
    )
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).infra_retries === 1, 'first attempt failed')
    const failedAt = Date.now()

    // Back in the queue, charged to the network, and waiting out a backoff.
    expect(chunkRow(chunk.id)).toMatchObject({
      state: 'pending',
      retries: 0,
      infra_retries: 1,
      error_kind: 'transient'
    })
    expect(chunkRow(chunk.id).not_before).toBeGreaterThanOrEqual(failedAt + 14_000)
    expect(w.alerts('warn').join('\n')).toMatch(
      /dispatch .* failed: SSH channel limit on the node: \(SSH\) Channel open failure.*again in 15 s/
    )
    // Not sent again at once: a tick comes and goes inside the backoff.
    await w.advance(14_000)
    expect(assignedTo(nodeId)).toBe(1)

    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(assignedTo(nodeId)).toBe(2)
    expect(chunkRow(chunk.id)).toMatchObject({ state: 'complete', retries: 0, infra_retries: 1 })
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    // The node rendered again, so the error its failed dispatch wrote is gone.
    expect(nodeError(nodeId)).toBeNull()
  })

  it('1.17: a render stopped out of GPU memory is the machine, not the render', async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    machine.onSpec = (spec) => {
      machine.onSpec = (retry) => machine.agent.finish(retry.chunkId)
      failWith(machine, spec.chunkId, {
        error: 'out of GPU memory on GPU 0 (exit -15): CUDA error: Out of memory in cuMemAlloc',
        exitCode: -15,
        errorKind: 'machine',
        oom: true,
        gpu: 0
      })
    }
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(chunkRow(chunk.id)).toMatchObject({
      retries: 0,
      infra_retries: 1,
      error_kind: 'machine'
    })
  })

  it('1.17: a node that goes away mid-render costs its chunks no render retry', async () => {
    const { app, ids } = await nodes(2)
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'chunk rendering')
    const first = chunkRow(chunk.id).node_id!
    const second = ids.find((id) => id !== first)!
    w.machineFor(second).agent.autoFinish()

    // destroyNode lets the scheduler forget the node before it marks it
    // destroying: the requeue must not hand the chunk straight back to it.
    let destroyed = false
    void app.nodeManager.destroyNode(first).finally(() => (destroyed = true))
    // The destroy runs its course inside the test, not into the next one.
    await w.until(() => destroyed && jobState(jobId) === 'complete', 'destroyed, job complete')
    expect(assignedTo(first)).toBe(1)
    expect(assignedTo(second)).toBe(1)
    expect(chunkRow(chunk.id)).toMatchObject({
      retries: 0,
      infra_retries: 1,
      error_kind: 'machine'
    })
    expect(w.alerts('warn').join('\n')).toContain('render retries unchanged')
  })
})

describe('1.17: where a chunk the machines failed goes, and what it is told', () => {
  it('1.17: a chunk whose node losses spent its infrastructure retries says it failed for good', async () => {
    const { app, ids } = await nodes(1)
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    // Every attempt the machines' budget allows, already lost to them.
    w.db.prepare('UPDATE chunks SET infra_retries = 8 WHERE id = ?').run(chunk.id)
    app.scheduler.kick()
    await w.until(() => chunkRow(chunk.id).state === 'rendering', 'chunk rendering')

    let destroyed = false
    void app.nodeManager.destroyNode(ids[0]).finally(() => (destroyed = true))
    await w.until(() => destroyed && settled(jobId), 'destroyed, job settled')
    expect(chunkRow(chunk.id)).toMatchObject({ state: 'failed', retries: 0, infra_retries: 8 })
    expect(w.alerts('error').join('\n')).toMatch(
      new RegExp(`chunk ${chunk.id} failed for good, it failed 8 more times.*node went away`)
    )
    // Not counted among the chunks requeued with their render retries intact.
    expect(w.alerts().filter((a) => /requeued — node went away/.test(a))).toEqual([])
  })

  it('1.17: a node that goes away after every frame of its chunk arrived says nothing failed', async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    machine.onSpec = (spec) => {
      // Every frame rendered and listed; the agent is still encoding.
      machine.agent.render(spec.chunkId)
      machine.agent.writeState(spec.chunkId, { status: 'encoding', framesDone: 4 })
    }
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => downloaded(jobId).length === 4, 'every frame downloaded')

    let destroyed = false
    void app.nodeManager.destroyNode(ids[0]).finally(() => (destroyed = true))
    await w.until(() => destroyed && settled(jobId), 'destroyed, job settled')
    expect(jobState(jobId)).toBe('complete')
    expect(chunkRow(chunk.id)).toMatchObject({ state: 'complete', retries: 0 })
    // Nothing failed: no warning reads as though something had.
    expect(w.alerts().filter((a) => a.includes(chunk.id))).toEqual([])
    expect(w.alerts().filter((a) => /requeued — node went away/.test(a))).toEqual([])
  })

  it('1.17: a chunk goes back to the node it failed on when the only other node is busy', async () => {
    const { app, ids } = await nodes(2)
    const attempts = new Map<string, number>()
    let releaseLong: (() => void) | null = null
    for (const id of ids) {
      const machine = w.machineFor(id)
      machine.onSpec = (spec) => {
        const n = (attempts.get(spec.chunkId) ?? 0) + 1
        attempts.set(spec.chunkId, n)
        if (spec.frameStart !== 1) {
          // The other chunk holds its node until the test lets it finish.
          releaseLong = () => machine.agent.finish(spec.chunkId)
        } else if (n === 1) {
          failWith(machine, spec.chunkId, outOfMemory)
        } else {
          machine.agent.finish(spec.chunkId)
        }
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    const [first] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => chunkRow(first.id).infra_retries === 1, 'first attempt failed')
    const failedOn = w
      .eventsOf('chunk:changed')
      .find((c) => c.chunkId === first.id && c.state === 'assigned')!.nodeId!

    // The node it failed on is idle, the other is busy and has no room: it
    // is sent back rather than left waiting while an idle node bills.
    await w.until(() => chunkRow(first.id).state === 'complete', 'failed chunk rendered', {
      timeoutMs: 5 * 60_000
    })
    expect(assignedTo(failedOn)).toBe(2)
    expect(releaseLong).not.toBeNull()
    releaseLong!()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })
})

describe('1.17: the job breaker, the same failure on two nodes', () => {
  it('1.17: the same render failure on two nodes holds the job with one alert, until it is resumed', async () => {
    const { app, ids } = await nodes(2)
    let crashing = true
    const specs: AgentSpec[] = []
    for (const id of ids) {
      const machine = w.machineFor(id)
      machine.onSpec = (spec) => {
        specs.push(spec)
        if (crashing) machine.agent.fail(spec.chunkId, 'blender exited -11', -11)
        else machine.agent.finish(spec.chunkId)
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
    // In step, as the bounds below assume (sceneAlreadyOn).
    sceneAlreadyOn(ids, jobId)
    app.scheduler.kick()
    const attention = (): string | null =>
      w.get<{ attention: string | null }>('SELECT attention FROM jobs WHERE id = ?', jobId)!
        .attention
    const dispatched = (): number =>
      w.eventsOf('chunk:changed').filter((c) => c.jobId === jobId && c.state === 'assigned').length
    await w.until(() => attention() !== null, 'job held')
    const sent = dispatched()
    await w.advance(5 * 60_000)

    // Held: nothing more of it is sent (a dispatch already under way when it
    // tripped runs its course), and the fleet is not widened for it.
    expect(dispatched()).toBe(sent)
    expect(specs.length).toBeLessThanOrEqual(sent)
    expect(w.vast.count('createInstance')).toBe(2)
    expect(['queued', 'running']).toContain(jobState(jobId))
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'repeatedFailure',
      errorClass: 'job',
      message: expect.stringMatching(/on 2 nodes .*blender exited -11/)
    })
    expect(w.alerts('error').filter((a) => a.includes('is held'))).toHaveLength(1)
    // It names the way out: resuming it (job:resume), never cancelling and
    // submitting again, which pays for every rendered frame once more.
    const held = w.alerts('error').find((a) => a.includes('is held'))
    expect(held).toMatch(/until you resume it from the job's page/)
    expect(held).not.toMatch(/submit it again/)
    // A crash is the render's failure: each attempt before the hold cost a
    // render retry, and it held after a handful, not after every chunk had
    // spent all of its (4 chunks x 5 attempts).
    const chunks = chunksOf(jobId)
    expect(chunks.reduce((n, c) => n + c.retries, 0)).toBe(sent)
    expect(chunks.reduce((n, c) => n + c.infra_retries, 0)).toBe(0)
    expect(sent).toBeLessThanOrEqual(4)

    // The user fixes whatever it was, and resumes.
    crashing = false
    expect(app.scheduler.resumeJob(jobId)).toBe(true)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(attention()).toBeNull()
  })

  it('1.17: a Blender install that fails on two nodes holds the job, and costs no render retry', async () => {
    const { app, ids } = await nodes(2)
    for (const id of ids) {
      w.machineFor(id).onExec(/provision\.sh install-blender/, {
        code: 1,
        stdout: '',
        stderr: 'no mirror has Blender 4.2.3'
      })
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(
      () =>
        w.get<{ attention: string | null }>('SELECT attention FROM jobs WHERE id = ?', jobId)!
          .attention !== null,
      'job held'
    )
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'repeatedFailure',
      errorClass: 'machine',
      message: expect.stringContaining('install blender 4.2.3 failed (exit 1)')
    })
    expect(chunksOf(jobId).map((c) => c.retries)).toEqual([0, 0, 0, 0])
  })

  it('1.17: a scene that runs out of GPU memory on every node holds the job after 2 nodes', async () => {
    const { app, ids } = await nodes(2)
    const specs: AgentSpec[] = []
    for (const id of ids) {
      const machine = w.machineFor(id)
      machine.onSpec = (spec) => {
        specs.push(spec)
        failWith(machine, spec.chunkId, outOfMemory)
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    // In step, as the bound below assumes: with one node still uploading, the
    // other retries its chunk alone meanwhile.
    sceneAlreadyOn(ids, jobId)
    app.scheduler.kick()
    const dispatched = (): number =>
      w.eventsOf('chunk:changed').filter((c) => c.jobId === jobId && c.state === 'assigned').length
    await w.until(() => attentionOf(jobId) !== null, 'job held')
    const sent = dispatched()
    await w.advance(10 * 60_000)

    // Each attempt is a paid render. A chunk failing the same way a second
    // time counts, and that on 2 nodes is taken as the scene's: here each
    // chunk twice on the node it began on (the other was busy each time it
    // came back), with one more attempt already under way when it tripped.
    // Not 2 chunks x 9 attempts on the machines' budget.
    expect(dispatched()).toBe(sent)
    expect(specs.length).toBeLessThanOrEqual(sent)
    expect(sent).toBeLessThanOrEqual(5)
    const job = await w.invoke('job:get', jobId)
    expect(job?.attention).toMatchObject({
      kind: 'repeatedFailure',
      errorClass: 'machine',
      message: expect.stringMatching(/on 2 nodes .*out of GPU memory/)
    })
    expect(w.alerts('error').filter((a) => a.includes('is held'))).toHaveLength(1)
    expect(w.vast.count('createInstance')).toBe(2)
  })

  it('1.17: one host-RAM kill on each 4-GPU node, as every lane loads the scene, never holds the job', async () => {
    w = await setup({ settings: { maxActiveNodes: 2 } })
    const app = await w.boot()
    const ids = [await w.readyNode(app, { num_gpus: 4 }), await w.readyNode(app, { num_gpus: 4 })]
    const specs: AgentSpec[] = []
    for (const id of ids) {
      const machine = w.machineFor(id)
      let killed = false
      machine.onSpec = (spec) => {
        specs.push(spec)
        if (!killed) {
          killed = true
          // Four Blenders load the scene at once, and the kernel's OOM killer
          // takes one of them. Every render after that has the room.
          setTimeout(() => machine.agent.fail(spec.chunkId, 'blender exited -9', -9), 10_000)
        } else {
          setTimeout(() => {
            if (machine.agent.spec(spec.chunkId)) machine.agent.finish(spec.chunkId)
          }, 120_000)
        }
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 16, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled', { timeoutMs: 60 * 60_000 })

    // One kill on each node, before any chunk of the job had rendered, is
    // each node's packing, not the scene: both killed chunks render on the
    // other node, and nothing waits on the user.
    expect(jobState(jobId)).toBe('complete')
    expect(attentionOf(jobId)).toBeNull()
    expect(w.alerts('error').filter((a) => a.includes('is held'))).toEqual([])
    expect(downloaded(jobId)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    const chunks = chunksOf(jobId)
    expect(chunks.map((c) => c.retries)).toEqual(chunks.map(() => 0))
    expect(chunks.filter((c) => c.infra_retries > 0)).toHaveLength(2)
    expect(specs).toHaveLength(18)
  })

  it('1.17: on a one-node fleet, a render out of GPU memory every time stops at its render retries', async () => {
    const { app, ids } = await nodes(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      failWith(machine, spec.chunkId, outOfMemory)
    }
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled', { timeoutMs: 60 * 60_000 })

    // The first failure is the machine's; the same one again, with no other
    // node to try, is the render's: 1 + 4 retries + the last, not 1 + 8.
    expect(jobState(jobId)).toBe('partial')
    expect(chunkRow(chunk.id)).toMatchObject({ state: 'failed', retries: 4, infra_retries: 1 })
    expect(specs).toHaveLength(6)
    expect(w.alerts('warn').join('\n')).toContain('it failed this way before')
  })

  it('1.17: a crash now and then, between chunks that render, never holds the job', async () => {
    const { app, ids } = await nodes(2)
    let n = 0
    for (const id of ids) {
      const machine = w.machineFor(id)
      machine.onSpec = (spec) => {
        // Every third attempt crashes, on whichever node it lands.
        if (++n % 3 === 0) machine.agent.fail(spec.chunkId, 'blender exited -11', -11)
        else machine.agent.finish(spec.chunkId)
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 12, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => settled(jobId), 'job settled')
    expect(jobState(jobId)).toBe('complete')
    expect(w.get('SELECT attention FROM jobs WHERE id = ?', jobId)).toEqual({ attention: null })
  })
})

describe('1.10 / 1.17: frames the local disk will not take', () => {
  /**
   * Every file opened while `full` refuses writes, as a full disk does, and
   * statfs reports room, so only a write that lands shows it has recovered
   * (as frameDownloader.test.ts's fullDisk).
   */
  function fullDisk(): { full: boolean } {
    const disk = { full: true }
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await open(...args)
      if (disk.full) {
        fh.write = (() =>
          Promise.reject(
            Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
              syscall: 'write'
            })
          )) as typeof fh.write
      }
      return fh
    })
    vi.spyOn(fsp, 'statfs').mockResolvedValue({
      bavail: 100 * 1024 ** 2,
      bsize: 1024
    } as unknown as StatsFs)
    return disk
  }

  it('1.10 B6 / 1.17: a chunk whose frames the disk held back is charged nothing, and waits for the disk before it is sent again', async () => {
    const { app, ids } = await nodes(1)
    const [nodeId] = ids
    w.machineFor(nodeId).agent.autoFinish()
    const disk = fullDisk()
    const { SINK_HOLD_MS } = await import('../transfer/frameDownloader')
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()

    // The final pass holds the node for the disk, then lets it go with the
    // frames reported held back, not lost.
    await w.until(() => chunkRow(chunk.id).state === 'pending', 'chunk back in the queue', {
      timeoutMs: SINK_HOLD_MS + 10 * 60_000
    })
    expect(chunkRow(chunk.id)).toMatchObject({
      retries: 0,
      infra_retries: 0,
      error_kind: 'localFs'
    })
    expect(w.alerts('warn').join('\n')).toMatch(/held back by the local disk.*nothing charged/)
    expect(app.scheduler.fleetHolds().localSink?.reason).toMatch(/ENOSPC/)

    // Nothing is rendered again while the disk still refuses: it would only
    // be held back again, on a paid node. And the node, with nothing it can
    // be sent, is let go after the idle timeout, not kept billing for as
    // long as the disk stays full. Nothing is rented meanwhile.
    await w.until(() => nodeState(nodeId) === 'destroyed', 'idle node destroyed', {
      timeoutMs: (w.settings.idleTimeoutMinutes + 2) * 60_000
    })
    await w.advance(10 * 60_000)
    expect(assignedTo(nodeId)).toBe(1)
    expect(w.vast.count('createInstance')).toBe(1)

    // The disk takes files again: a node is rented for the chunk, which
    // renders there, still charged nothing.
    w.vast.addOffer()
    disk.full = false
    await w.until(() => w.vast.count('createInstance') === 2, 'a node rented for the chunk')
    const fresh = w.vast.live()[0]
    w.vast.machine(fresh).agent.autoFinish()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(assignedTo(nodeId)).toBe(1)
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
    expect(chunkRow(chunk.id)).toMatchObject({ retries: 0, infra_retries: 0 })
    expect(app.scheduler.fleetHolds().localSink).toBeUndefined()
  })

  it('1.10 B6: an idle fleet during a local-disk hold scales down, and rents nothing', async () => {
    const { app, ids } = await nodes(2)
    for (const id of ids) w.machineFor(id).agent.autoFinish()
    fullDisk()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    app.scheduler.kick()

    // The disk stays full. Each node renders its chunk, holds its frames for
    // SINK_HOLD_MS, goes idle, and is let go after the idle timeout: an hour
    // on, neither bills, and nothing new was rented for the waiting work.
    await w.advance(60 * 60_000, 5_000)
    expect(ids.map(nodeState)).toEqual(['destroyed', 'destroyed'])
    expect(w.vast.live()).toEqual([])
    expect(w.vast.count('createInstance')).toBe(2)
    // The work waits for the disk, charged nothing, and the job with it.
    expect(['queued', 'running']).toContain(jobState(jobId))
    expect(chunksOf(jobId).map((c) => [c.state, c.retries, c.infra_retries])).toEqual([
      ['pending', 0, 0],
      ['pending', 0, 0]
    ])
  })
})
