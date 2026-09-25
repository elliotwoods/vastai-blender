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
    // The job's copy of its scene is sent, named by its hash (plan 1.12).
    const { blend_sha256: sha } = w.get<{ blend_sha256: string }>(
      'SELECT blend_sha256 FROM jobs WHERE id = ?',
      jobId
    )!
    app.scheduler.kick()

    // The spec lands in the agent's inbox, whole (via the atomic tmp → rename).
    await w.until(() => machine.agent.inbox().includes(chunk.id), 'spec in the inbox')
    const spec = machine.agent.spec(chunk.id)!
    expect(spec).toMatchObject({
      chunkId: chunk.id,
      blendFile: `${sha}.blend`,
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
    expect(machine.files.has(`/root/vastai/work/scenes/${sha}.blend`)).toBe(true)
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

// A test may stop watching in the middle of anything, a download included.
// dispose() closes the fake connections, which fails the transfers as ssh2
// fails them, and waits for what that sets off to finish, so none of it
// reaches the next test. Each shape runs both before and after the other: a
// leak would fail the test after it (and dispose() names the test it came from).
describe('a test that ends mid-download', () => {
  /** How many of a job's frames have landed locally. */
  function downloaded(jobId: string): number {
    return w.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM frames WHERE job_id = ? AND state = 'downloaded'`,
      jobId
    )!.n
  }

  async function endsMidDownload(): Promise<void> {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    w.machineFor(nodeId).agent.autoFinish()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 24, chunkSize: 24 })
    app.scheduler.kick()
    await w.until(() => downloaded(jobId) > 0, 'the first frame downloaded')
    // Most of the chunk is still on its way when the test ends.
    expect(downloaded(jobId)).toBeLessThan(24)
  }

  async function completesAJob(): Promise<void> {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    w.machineFor(nodeId).agent.autoFinish()
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(
      () => w.get('SELECT state FROM jobs WHERE id = ?', jobId)?.state === 'complete',
      'job complete'
    )
    expect(downloaded(jobId)).toBe(4)
    expect(w.alerts('error')).toEqual([])
  }

  it('ends with frames still downloading', endsMidDownload)
  it('the next test runs as if it were first', completesAJob)
  it('ends with frames still downloading, after a test that did not', endsMidDownload)
  it('and the test after that runs clean too', completesAJob)
})
