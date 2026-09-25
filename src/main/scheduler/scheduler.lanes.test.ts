import { afterEach, describe, expect, it } from 'vitest'
import type { EngineId } from '../../shared/models'
import {
  setup,
  type AgentSpec,
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
