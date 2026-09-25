import { afterEach, describe, expect, it } from 'vitest'
import type { EngineId, SceneRenderTimes } from '../../shared/models'
import { setup, type AgentSpec, type App, type FakeMachine, type World } from '../test/harness'

// Where a scene's render time goes (scenePerf): the render driver is asked
// for on Cycles specs, and each chunk's final agent state is added to the
// scene's row for its GPU model.

let w: World
afterEach(() => w.dispose())

async function oneNode(): Promise<{ app: App; machine: FakeMachine }> {
  w = await setup({ settings: { maxActiveNodes: 1 } })
  const app = await w.boot()
  const nodeId = await w.readyNode(app, { num_gpus: 1 })
  return { app, machine: w.machineFor(nodeId) }
}

/** The job's scene times, as the job screen gets them (scenePerf.sceneRenderTimes). */
function timesOf(app: App, jobId: string): SceneRenderTimes[] {
  return app.jobs.getJob(jobId)?.renderTimes ?? []
}

const TIMINGS = { loadS: 30, frames: 2, evalS: 2, syncS: 6, sampleS: 100, saveS: 1 }

describe('scene_perf: where the render time goes', () => {
  for (const [engine, driver] of [
    ['cycles', true],
    ['eevee', false]
  ] as Array<[EngineId, boolean]>) {
    it(`asks for the render driver on ${engine}: ${driver}`, async () => {
      const { app, machine } = await oneNode()
      const specs: AgentSpec[] = []
      machine.onSpec = (spec) => specs.push(spec)
      await w.submitJob(app, { engine, frameStart: 1, frameEnd: 2, chunkSize: 2 })
      app.scheduler.kick()
      await w.until(() => specs.length > 0, 'spec')
      expect(specs[0].renderDriver).toBe(driver)
    })
  }

  it("adds each chunk's timings and VRAM to the scene's row for its GPU model", async () => {
    const { app, machine } = await oneNode()
    machine.onSpec = (spec) => {
      machine.agent.finish(spec.chunkId)
      machine.agent.writeState(spec.chunkId, {
        status: 'done',
        framesDone: 2,
        framesTotal: 2,
        exitCode: 0,
        timings: TIMINGS,
        vram: { peakMb: 7100, gpu: null, cardBaseMb: null, cardPeakMb: null }
      })
    }
    const jobId = await w.submitJob(app, {
      engine: 'cycles',
      frameStart: 1,
      frameEnd: 4,
      chunkSize: 2
    })
    app.scheduler.kick()
    await w.until(() => (timesOf(app, jobId)[0]?.frames ?? 0) >= 4, 'both chunks recorded')
    const times = timesOf(app, jobId)
    expect(times).toHaveLength(1)
    expect(times[0]).toMatchObject({
      loads: 2,
      loadS: 30,
      frames: 4,
      evalS: 1,
      syncS: 3,
      sampleS: 50,
      saveS: 0.5,
      peakVramMb: 7100
    })
    expect(times[0].gpuName).toBeTruthy()
  })

  it('keeps the VRAM of a render that ran out of memory', async () => {
    const { app, machine } = await oneNode()
    machine.onSpec = (spec) =>
      machine.agent.writeState(spec.chunkId, {
        status: 'failed',
        error: 'out of GPU memory',
        errorKind: 'machine',
        oom: true,
        exitCode: 1,
        vram: { peakMb: 23900, gpu: null, cardBaseMb: null, cardPeakMb: null }
      })
    const jobId = await w.submitJob(app, { engine: 'cycles', frameStart: 1, frameEnd: 1 })
    app.scheduler.kick()
    await w.until(() => timesOf(app, jobId).length > 0, 'recorded')
    expect(timesOf(app, jobId)[0]).toMatchObject({ frames: 0, peakVramMb: 23900 })
  })
})
