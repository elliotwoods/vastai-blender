import { readFileSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HARNESS_BLENDER, setup, type World } from '../test/harness'

// Smoke scenarios for the lifecycle harness (src/main/test/harness.ts): the
// real scheduler dispatching to a fake node and downloading what its fake
// agent renders.

let w: World
beforeEach(async () => {
  // One node is the whole fleet: nothing here should rent a second.
  w = await setup({ settings: { maxActiveNodes: 1 } })
})
afterEach(() => w.dispose())

describe('scheduler dispatch', () => {
  it("dispatches a job's chunk to a ready node and completes it from the agent's manifest", async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)

    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    app.scheduler.kick()

    // The spec lands in the agent's inbox, whole (via the atomic tmp → rename).
    await w.until(() => machine.agent.inbox().includes(chunk.id), 'spec in the inbox')
    const spec = machine.agent.spec(chunk.id)!
    expect(spec).toMatchObject({
      chunkId: chunk.id,
      blendFile: `${jobId}.blend`,
      blenderVersion: HARNESS_BLENDER,
      frameStart: 1,
      frameEnd: 4,
      frameStep: 1,
      exclusive: true
    })
    await w.until(
      () => w.get('SELECT state FROM chunks WHERE id = ?', chunk.id)?.state === 'rendering',
      'chunk rendering'
    )
    expect(w.get('SELECT node_id FROM chunks WHERE id = ?', chunk.id)).toEqual({ node_id: nodeId })

    // The agent renders every frame, manifests them, and reports done.
    machine.agent.finish(chunk.id)
    await w.until(
      () => w.get('SELECT state FROM chunks WHERE id = ?', chunk.id)?.state === 'complete',
      'chunk complete'
    )

    // Complete means downloaded: every frame is on the local disk, byte for byte.
    const frames = w.all<{ frame: number; state: string; local_path: string }>(
      'SELECT frame, state, local_path FROM frames WHERE job_id = ? ORDER BY frame',
      jobId
    )
    expect(frames.map((f) => [f.frame, f.state])).toEqual([
      [1, 'downloaded'],
      [2, 'downloaded'],
      [3, 'downloaded'],
      [4, 'downloaded']
    ])
    for (const f of frames) {
      expect(readFileSync(f.local_path, 'utf-8')).toBe(`fake render ${chunk.id} frame ${f.frame}\n`)
    }
    expect(w.get('SELECT state FROM jobs WHERE id = ?', jobId)).toEqual({ state: 'complete' })
    expect(app.nodeManager.get(nodeId)?.state).toBe('idle')
    // The scene went up once, and the fleet was never widened.
    expect(machine.files.has(`/root/vastai/work/scenes/${jobId}.blend`)).toBe(true)
    expect(w.vast.count('createInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])

    // The renderer heard the chunk's lifecycle.
    const chunkStates = w
      .eventsOf('chunk:changed')
      .filter((c) => c.chunkId === chunk.id)
      .map((c) => c.state)
    expect(chunkStates).toEqual(['assigned', 'rendering', 'downloading', 'complete'])
  })

  it("an agent that reports 'failed' sends the chunk back to pending for another attempt", async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const jobId = await w.submitJob(app)
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    // Fail the first attempt the moment it lands; render the retry.
    machine.onSpec = (spec) => {
      machine.onSpec = (retry) => machine.agent.finish(retry.chunkId)
      machine.agent.fail(spec.chunkId, 'blender exited with code 1')
    }
    app.scheduler.kick()

    await w.until(
      () => w.get('SELECT state FROM jobs WHERE id = ?', jobId)?.state === 'complete',
      'job complete after a retry'
    )
    expect(w.get('SELECT retries FROM chunks WHERE id = ?', chunk.id)).toEqual({ retries: 1 })
    expect(w.alerts('warn').join('\n')).toContain('blender exited with code 1')
  })
})
