import { afterEach, describe, expect, it } from 'vitest'
import type { EngineId } from '../../shared/models'
import {
  setup,
  type AgentSpec,
  type AgentStateFile,
  type App,
  type FakeMachine,
  type SetupOptions,
  type World
} from '../test/harness'

// GPU lanes as the scheduler plans them (plan 1.11, the 93cbad4 follow-ups),
// end to end on the lifecycle harness: what each spec is sent with, and how
// many chunks a multi-GPU node is given at once.

let w: World
afterEach(() => w.dispose())

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

/** One node with `gpus` GPUs, ready. */
async function gpuNode(
  gpus: number,
  settings: SetupOptions['settings'] = {}
): Promise<{ app: App; nodeId: string; machine: FakeMachine }> {
  w = await setup({ settings: { maxActiveNodes: 1, ...settings } })
  const app = await w.boot()
  const nodeId = await w.readyNode(app, { num_gpus: gpus })
  return { app, nodeId, machine: w.machineFor(nodeId) }
}

/** Specs as they land, with how many the node's inbox held at that moment. */
function recordSpecs(machine: FakeMachine): Array<AgentSpec & { inboxAtLanding: number }> {
  const specs: Array<AgentSpec & { inboxAtLanding: number }> = []
  machine.onSpec = (spec) => {
    specs.push({ ...spec, inboxAtLanding: machine.agent.inbox().length })
  }
  return specs
}

function submit(app: App, engine: EngineId, frames: number): Promise<string> {
  return w.submitJob(app, { engine, frameStart: 1, frameEnd: frames, chunkSize: 1 })
}

/**
 * What the node's nvidia-smi and /proc/meminfo report from now on, in
 * pollMetrics' layout: every card at `vram` of 24 GB, `ram` of 125 GB in use.
 * Change the returned object to change the next sample.
 */
function reportMemory(machine: FakeMachine, load: { vram: number; ram: number }): typeof load {
  machine.onExec(/^nvidia-smi --query-gpu/, () => {
    const total = 24576
    const gpus = Array.from(
      { length: machine.numGpus },
      (_, i) => `95, ${Math.round(total * load.vram)}, ${total}, 65, 300.5, 450, ${i}`
    ).join('\n')
    const totalKb = 131072000
    const availKb = Math.round(totalKb * (1 - load.ram))
    return (
      `${gpus}\n----\n4.00 3.50 3.00 2/300 12345\n32\n----\n` +
      `MemTotal:       ${totalKb} kB\nMemAvailable:    ${availKb} kB\n` +
      `cpu  1000 0 500 8000 100 0 0 0 0 0\n`
    )
  })
  return load
}

/** The node's exclusive runs right now. */
function inFlight(app: App, nodeId: string): number {
  return app.scheduler.activeWorkForNode(nodeId).length
}

describe('1.11 #229 #235: lanes by engine', () => {
  it('an EEVEE job on a 4-GPU node is one unpinned lane, one chunk at a time', async () => {
    const { app, machine } = await gpuNode(4)
    const specs = recordSpecs(machine)
    const jobId = await submit(app, 'eevee', 4)
    app.scheduler.kick()
    await w.until(() => specs.length > 0, 'first spec')
    // A tick later, still only one: EEVEE renders on the card its OpenGL or
    // Vulkan context lands on, so four "pinned" lanes all rendered on card 0
    // while three paid cards idled.
    await w.advance(20_000)
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ lanes: 1, pinGpus: false })

    // Each chunk gets the whole node in turn.
    machine.onSpec = (spec) => {
      specs.push({ ...spec, inboxAtLanding: machine.agent.inbox().length })
      machine.agent.finish(spec.chunkId)
    }
    machine.agent.finish(specs[0].chunkId)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(specs).toHaveLength(4)
    expect(specs.map((s) => [s.lanes, s.pinGpus, s.inboxAtLanding])).toEqual(
      specs.map(() => [1, false, 1])
    )
  })

  it('an Octane job on a 4-GPU node is one unpinned lane', async () => {
    const { app, machine } = await gpuNode(4)
    // Past the Octane setup (plan 1.18's), which is not what this is about.
    w.db.prepare('UPDATE nodes SET octane_ready = 1').run()
    const specs = recordSpecs(machine)
    await submit(app, 'octane', 2)
    app.scheduler.kick()
    await w.until(() => specs.length > 0, 'first spec')
    await w.advance(20_000)
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ engine: 'octane', lanes: 1, pinGpus: false })
  })

  it('a Cycles job on the same node still gets a pinned lane per GPU', async () => {
    const { app, machine } = await gpuNode(4)
    const specs = recordSpecs(machine)
    await submit(app, 'cycles', 4)
    app.scheduler.kick()
    await w.until(() => specs.length === 4, 'four specs')
    expect(specs.map((s) => [s.lanes, s.pinGpus])).toEqual(specs.map(() => [4, true]))
  })

  it('an EEVEE chunk waits for pinned Cycles lanes to finish, and Cycles waits for it', async () => {
    const { app, nodeId, machine } = await gpuNode(4)
    const specs = recordSpecs(machine)
    const cyclesJob = await submit(app, 'cycles', 4)
    app.scheduler.kick()
    await w.until(() => specs.length === 4, 'four Cycles lanes')
    const cycles = chunksOf(cyclesJob)
    // Two lanes free up.
    machine.agent.finish(cycles[0].id)
    machine.agent.finish(cycles[1].id)
    await w.until(
      () => app.scheduler.activeWorkForNode(nodeId).length === 2,
      'two Cycles lanes still running'
    )

    // An EEVEE chunk is not sent into a free lane: the agent would hold it at
    // the head of its inbox until the node emptied, and every spec behind it
    // with it.
    const eeveeJob = await submit(app, 'eevee', 1)
    app.scheduler.kick()
    await w.advance(20_000)
    expect(specs).toHaveLength(4)
    const [eevee] = chunksOf(eeveeJob)
    expect(eevee.state).toBe('pending')

    machine.agent.finish(cycles[2].id)
    machine.agent.finish(cycles[3].id)
    await w.until(() => specs.length === 5, 'EEVEE dispatched once the node is empty')
    expect(specs[4]).toMatchObject({ chunkId: eevee.id, lanes: 1, pinGpus: false })

    // And a Cycles chunk is not sent beside it: the EEVEE render has every
    // card there is, and the agent would start a pinned spec next to it.
    const moreCycles = await submit(app, 'cycles', 1)
    app.scheduler.kick()
    await w.advance(20_000)
    expect(specs).toHaveLength(5)
    expect(chunksOf(moreCycles)[0].state).toBe('pending')

    machine.agent.finish(eevee.id)
    await w.until(() => specs.length === 6, 'Cycles dispatched once EEVEE is done')
    expect(app.scheduler.activeWorkForNode(nodeId)).toHaveLength(1)
  })

  it('scale-up counts one lane per node for EEVEE work', async () => {
    // One 4-GPU node busy with nothing; 3 EEVEE chunks wait. Counted as four
    // free lanes, the queue looked covered and nothing was rented; each chunk
    // then waited for the last to finish.
    w = await setup({ settings: { maxActiveNodes: 3, eagerFleet: false } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app, { num_gpus: 4 })
    const machine = w.machineFor(nodeId)
    const specs = recordSpecs(machine)
    await submit(app, 'eevee', 3)
    // Offers to rent more with.
    w.vast.addOffer({ num_gpus: 4 })
    w.vast.addOffer({ num_gpus: 4 })
    app.scheduler.kick()
    await w.until(() => specs.length === 1, 'one EEVEE chunk on the node')
    await w.until(() => w.vast.count('createInstance') > 1, 'scale-up rents for the rest')
    expect(app.scheduler.scaleStatus()?.reason ?? '').not.toMatch(/covers the queue/)
  })
})

describe('1.11 #222: the lane memory guard', () => {
  it('every card nearly full at one lane per GPU keeps all four lanes working', async () => {
    const { app, nodeId, machine } = await gpuNode(4)
    // A heavy scene: 95% of every card, with one scene on each. Fewer lanes
    // cannot lower any card's VRAM; the guard used to step down anyway, to one
    // lane pinned to card 0, and leave three paid cards idle.
    reportMemory(machine, { vram: 0.95, ram: 0.3 })
    const specs = recordSpecs(machine)
    const jobId = await submit(app, 'cycles', 8)
    app.scheduler.kick()
    await w.until(() => specs.length === 4, 'four lanes')
    for (const s of specs) machine.agent.progress(s.chunkId, 0)
    // Several settle periods under that pressure.
    await w.advance(6 * 60_000)
    expect(w.alerts().join('\n')).not.toMatch(/lanes capped/)

    for (const s of specs.slice(0, 4)) machine.agent.finish(s.chunkId)
    await w.until(() => specs.length === 8, 'the next four')
    expect(specs.slice(4).map((s) => [s.lanes, s.pinGpus])).toEqual(
      specs.slice(4).map(() => [4, true])
    )
    expect(inFlight(app, nodeId)).toBe(4)
    for (const s of specs.slice(4)) machine.agent.finish(s.chunkId)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })

  it('RAM pressure steps down to one process across every card, and it recovers once RAM has room', async () => {
    const { app, nodeId, machine } = await gpuNode(4)
    const load = reportMemory(machine, { vram: 0.3, ram: 0.95 })
    const specs = recordSpecs(machine)
    const jobId = await submit(app, 'cycles', 12)
    app.scheduler.kick()
    await w.until(() => specs.length === 4, 'four lanes')
    for (const s of specs) machine.agent.progress(s.chunkId, 0)
    await w.until(
      () => w.alerts('warn').some((a) => /lanes capped/.test(a)),
      'the guard steps down'
    )
    expect(w.alerts('warn').join('\n')).toMatch(
      /lanes capped at 1 \(one process across every GPU\) — RAM at 95%/
    )

    // Once the four renders that caused it are done, one process has the node.
    for (const s of specs.slice(0, 4)) machine.agent.finish(s.chunkId)
    await w.until(() => specs.length === 5, 'the next chunk')
    await w.advance(20_000)
    expect(specs).toHaveLength(5)
    expect(specs[4]).toMatchObject({ lanes: 1, pinGpus: false })
    machine.agent.progress(specs[4].chunkId, 0)

    // RAM has room again. The guard used to stay down for the node's rental.
    load.ram = 0.1
    await w.until(() => w.alerts().some((a) => /lanes back up to 4/.test(a)), 'the guard recovers')
    machine.agent.finish(specs[4].chunkId)
    await w.until(() => specs.length === 9, 'four lanes again')
    expect(specs.slice(5).map((s) => [s.lanes, s.pinGpus])).toEqual(
      specs.slice(5).map(() => [4, true])
    )
    expect(inFlight(app, nodeId)).toBe(4)
    machine.onSpec = (spec) => machine.agent.finish(spec.chunkId)
    for (const s of specs.slice(5)) machine.agent.finish(s.chunkId)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })
})

describe('1.11 #224: a chunk with cards to spare goes out across every card', () => {
  it("a job's last chunk on an empty 4-GPU node renders on every card, and holds the node", async () => {
    const { app, nodeId, machine } = await gpuNode(4)
    const specs = recordSpecs(machine)
    const lone = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    app.scheduler.kick()
    await w.until(() => specs.length === 1, 'the chunk dispatched')
    // Pinned, it rendered on one card at single-GPU speed while three idled.
    expect(specs[0]).toMatchObject({ lanes: 1, pinGpus: false })

    // Nothing is sent beside it: it has every card, and the agent would start
    // a pinned spec next to it.
    const next = await submit(app, 'cycles', 4)
    app.scheduler.kick()
    await w.advance(20_000)
    expect(specs).toHaveLength(1)
    expect(inFlight(app, nodeId)).toBe(1)

    // Once it is done, four chunks fill the four lanes, pinned again.
    machine.agent.finish(specs[0].chunkId)
    await w.until(() => specs.length === 5, 'four lanes for the next job')
    expect(specs.slice(1).map((s) => [s.lanes, s.pinGpus])).toEqual(
      specs.slice(1).map(() => [4, true])
    )
    for (const s of specs.slice(1)) machine.agent.finish(s.chunkId)
    await w.until(
      () => jobState(lone) === 'complete' && jobState(next) === 'complete',
      'both jobs complete'
    )
  })

  it('decides per chunk: six chunks on two empty 4-GPU nodes, one across a node and four in lanes', async () => {
    // By default auto-chunking sizes a job at about 3 chunks per node, so two
    // 4-GPU nodes got 3 pinned lanes each, a card idle on each for the whole
    // job and every chunk at single-GPU speed.
    w = await setup({ settings: { maxActiveNodes: 2 } })
    const app = await w.boot()
    const ids = [await w.readyNode(app, { num_gpus: 4 }), await w.readyNode(app, { num_gpus: 4 })]
    const specs = ids.map((id) => recordSpecs(w.machineFor(id)))
    const jobId = await submit(app, 'cycles', 6)
    app.scheduler.kick()
    await w.until(() => specs[0].length + specs[1].length === 5, 'five dispatched')
    await w.advance(20_000)
    const plans = specs.map((s) => s.map((x) => [x.lanes, x.pinGpus]))
    // Eight free lanes for six chunks: the first takes a whole node. On the
    // other, four chunks for four lanes: pinned. The sixth waits for a lane.
    expect(plans.map((p) => p.length).sort()).toEqual([1, 4])
    const [whole, laned] = plans[0].length === 1 ? plans : [plans[1], plans[0]]
    expect(whole).toEqual([[1, false]])
    expect(laned).toEqual(laned.map(() => [4, true]))
    expect(chunksOf(jobId).filter((c) => c.state === 'pending')).toHaveLength(1)

    for (const id of ids)
      w.machineFor(id).onSpec = (spec) => w.machineFor(id).agent.finish(spec.chunkId)
    for (const [i, id] of ids.entries()) {
      for (const s of specs[i]) w.machineFor(id).agent.finish(s.chunkId)
    }
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })
})

describe('1.11 #225: what a pinned run teaches gpu_perf', () => {
  it('three pinned lanes on a 4-GPU node teach their own rate, not three quarters of it', async () => {
    const { app, nodeId, machine } = await gpuNode(4)
    const specs = recordSpecs(machine)
    await submit(app, 'cycles', 4)
    app.scheduler.kick()
    await w.until(() => specs.length === 4, 'four pinned lanes')
    // Each on its own card, as the agent reports.
    specs.forEach((s, gpu) => machine.agent.writeState(s.chunkId, { status: 'rendering', gpu }))
    // One finishes at once. The other three then render with a card each
    // and nothing waiting for the fourth.
    machine.agent.finish(specs[0].chunkId)
    await w.until(() => app.scheduler.activeWorkForNode(nodeId).length === 3, 'three left')
    // Whether the first taught anything depends on how long its download
    // took on this computer's clock: past 18 s of fake time it did, a much
    // faster rate. Only the three pinned runs are under test.
    const gpuName = w.get<{ gpu_name: string }>(
      'SELECT gpu_name FROM nodes WHERE id = ?',
      nodeId
    )!.gpu_name
    w.db.prepare('DELETE FROM gpu_perf WHERE gpu_name = ?').run(gpuName)
    await w.advance(10 * 60_000)
    const doneAt = Date.now()
    specs.slice(1).forEach((s, i) => {
      machine.agent.finish(s.chunkId)
      // The real agent's done state keeps every field it had, its GPU included.
      machine.agent.writeState(s.chunkId, {
        status: 'done',
        framesDone: 1,
        framesTotal: 1,
        exitCode: 0,
        gpu: i + 1
      })
    })
    await w.until(() => app.scheduler.activeWorkForNode(nodeId).length === 0, 'all done')

    // One frame in about ten minutes on one card: ~6 frames/h per GPU. Scaled
    // by the node's runs over its GPUs it was 3/4 of that.
    const perf = w.get<{ frames_per_hour: number; samples: number }>(
      'SELECT frames_per_hour, samples FROM gpu_perf WHERE gpu_name = ?',
      gpuName
    )!
    const dispatchedAt = doneAt - 10 * 60_000 - 60_000
    expect(perf.samples).toBe(3)
    expect(perf.frames_per_hour).toBeGreaterThan(3_600_000 / (Date.now() - dispatchedAt) - 0.01)
    expect(perf.frames_per_hour).toBeLessThanOrEqual(6)
  })
})

describe('1.11 #228 #230: what a node shows it can take', () => {
  it('out of GPU memory at two renders a card drops the node to one a card before the requeue', async () => {
    const { app, nodeId, machine } = await gpuNode(2, { slotsPerGpu: 2 })
    const specs: Array<AgentSpec & { inFlight: number }> = []
    let oomed = false
    machine.onSpec = (spec) => {
      specs.push({ ...spec, inFlight: inFlight(app, nodeId) })
      if (!oomed) {
        oomed = true
        // What the agent reports for a render stopped out of GPU memory.
        machine.agent.fail(spec.chunkId, 'out of GPU memory on GPU 0 (exit -15)', -15)
        machine.agent.writeState(spec.chunkId, {
          status: 'failed',
          error: 'out of GPU memory on GPU 0 (exit -15): CUDA error: Out of memory in cuMemAlloc',
          exitCode: -15,
          errorKind: 'machine',
          oom: true,
          gpu: 0
        } as Partial<AgentStateFile>)
        return
      }
      setTimeout(() => machine.agent.finish(spec.chunkId), 60_000)
    }
    const jobId = await submit(app, 'cycles', 8)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')

    // Four lanes (two a card) at first; every spec after the OOM is two, and
    // the node never ran more than two at once again.
    expect(specs.slice(0, 4).map((s) => [s.lanes, s.pinGpus])).toEqual(
      specs.slice(0, 4).map(() => [4, true])
    )
    const after = specs.slice(4)
    expect(after.length).toBeGreaterThan(0)
    expect(after.map((s) => [s.lanes, s.pinGpus])).toEqual(after.map(() => [2, true]))
    expect(Math.max(...after.map((s) => s.inFlight))).toBeLessThanOrEqual(2)
    expect(w.alerts('warn').join('\n')).toMatch(
      /out of GPU memory with 2 renders on a card, so it now runs 1 per card/
    )
    // The machine's failure, as before: no render retry spent.
    expect(chunksOf(jobId).map((c) => c.retries)).toEqual(chunksOf(jobId).map(() => 0))
  })

  it('an agent that cannot pin has its node planned as one lane', async () => {
    const { app, nodeId, machine } = await gpuNode(4)
    const specs = recordSpecs(machine)
    const jobId = await submit(app, 'cycles', 6)
    app.scheduler.kick()
    await w.until(() => specs.length === 4, 'four pinned lanes')
    // nvidia-smi failed as the agent started: it runs these one at a time,
    // unpinned, and says so in the state it writes.
    machine.agent.writeState(specs[0].chunkId, {
      status: 'rendering',
      pinFailed: true
    } as Partial<AgentStateFile>)
    await w.until(() => w.alerts('warn').some((a) => /cannot pin renders/.test(a)), 'noticed')
    for (const s of specs.slice(0, 4)) machine.agent.finish(s.chunkId)
    await w.until(() => specs.length === 5, 'the next chunk')
    await w.advance(20_000)
    expect(specs).toHaveLength(5)
    expect(specs[4]).toMatchObject({ lanes: 1, pinGpus: false })
    expect(inFlight(app, nodeId)).toBe(1)
    machine.onSpec = (spec) => machine.agent.finish(spec.chunkId)
    machine.agent.finish(specs[4].chunkId)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })
})
