import { afterEach, describe, expect, it } from 'vitest'
import { setup, type App, type World } from '../test/harness'

// The scheduler takes work in render-queue order (jobs/queue.ts): a group's
// jobs in turn, a move changing what goes next, and Blender affinity never
// letting work further down the queue go first.

let w: World
afterEach(() => w.dispose())

async function oneNode(): Promise<{ app: App; nodeId: string }> {
  w = await setup({ settings: { maxActiveNodes: 1 } })
  const app = await w.boot()
  const nodeId = await w.readyNode(app)
  return { app, nodeId }
}

/** Which job each dispatch was of, in order. */
function dispatchedJobs(): string[] {
  return w
    .eventsOf('chunk:changed')
    .filter((c) => c.state === 'assigned')
    .map((c) => c.jobId)
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

describe('the scheduler follows the render queue', () => {
  it("hands out a group's chunks in turn", async () => {
    const { app, nodeId } = await oneNode()
    w.machineFor(nodeId).agent.autoFinish()
    const a = await w.submitJob(app, { frameStart: 1, frameEnd: 6, chunkSize: 2 })
    await w.advance(1_000)
    const b = await w.submitJob(app, { frameStart: 1, frameEnd: 6, chunkSize: 2 })
    await w.invoke('job:group', { jobId: b, withJobId: a })
    await w.until(() => jobState(a) === 'complete' && jobState(b) === 'complete', 'both complete')
    expect(dispatchedJobs()).toEqual([a, b, a, b, a, b])
  })

  it('a job moved to the front goes next', async () => {
    const { app, nodeId } = await oneNode()
    w.machineFor(nodeId).agent.autoFinish()
    const a = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    await w.advance(1_000)
    const b = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    await w.invoke('job:move', { jobId: b, before: a })
    await w.until(() => jobState(a) === 'complete' && jobState(b) === 'complete', 'both complete')
    expect(dispatchedJobs()).toEqual([b, b, a, a])
  })

  it('Blender affinity does not let a job further down the queue go first', async () => {
    const { app, nodeId } = await oneNode()
    const a = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 2 })
    await w.advance(1_000)
    const b = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 2 })
    // The node has b's Blender and not a's. It used to take b, the install
    // it saved worth more than a's place in the queue.
    app.nodeManager.get(nodeId)!.update({ blender_versions: JSON.stringify(['9.9.1']) })
    w.db.prepare("UPDATE jobs SET blender_version = '9.9.0' WHERE id = ?").run(a)
    w.db.prepare("UPDATE jobs SET blender_version = '9.9.1' WHERE id = ?").run(b)
    app.scheduler.kick()
    await w.until(() => dispatchedJobs().length > 0, 'a dispatch')
    expect(dispatchedJobs()[0]).toBe(a)
  })

  it('Blender affinity still chooses within a group', async () => {
    const { app, nodeId } = await oneNode()
    const a = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 2 })
    await w.advance(1_000)
    const b = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 2 })
    app.nodeManager.get(nodeId)!.update({ blender_versions: JSON.stringify(['9.9.1']) })
    w.db.prepare("UPDATE jobs SET blender_version = '9.9.0' WHERE id = ?").run(a)
    w.db.prepare("UPDATE jobs SET blender_version = '9.9.1' WHERE id = ?").run(b)
    // One entry: the install saved decides.
    await w.invoke('job:group', { jobId: b, withJobId: a })
    await w.until(() => dispatchedJobs().length > 0, 'a dispatch')
    expect(dispatchedJobs()[0]).toBe(b)
  })
})
