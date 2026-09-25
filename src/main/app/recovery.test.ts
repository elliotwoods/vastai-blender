import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HANG, setup, type App, type World } from '../test/harness'

// Recovery actions (plan 1.15): job:retryMissing and node:reprovision, called
// the way the renderer calls them. Both were empty stubs that answered
// success (#201): "Re-render missing" did nothing, and a wedged node could
// only be destroyed.

let w: World
beforeEach(async () => {
  // One node is the whole fleet: nothing here should rent a second.
  w = await setup({ settings: { maxActiveNodes: 1 } })
})
afterEach(() => w.dispose())

function chunkState(id: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM chunks WHERE id = ?', id)?.state
}

function jobState(jobId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state
}

function nodeState(app: App, nodeId: string): string | undefined {
  return app.nodeManager.get(nodeId)?.state
}

describe('job:retryMissing', () => {
  it('1.15: Re-render missing sends the node only the frames not on disk, and the job completes', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const specs: Array<[number, number]> = []
    machine.onSpec = (spec) => {
      specs.push([spec.frameStart, spec.frameEnd])
      machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 8 })
    // A chunk out of retries, with the frames of its last attempt on disk:
    // the job ends 'partial'.
    w.db
      .prepare(`UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame IN (1, 2, 5)`)
      .run(jobId)
    w.db.prepare(`UPDATE chunks SET state = 'failed', retries = 4 WHERE job_id = ?`).run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    expect(await w.invoke('job:retryMissing', jobId)).toEqual({ frames: 5, chunks: 2 })

    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(specs.sort((a, b) => a[0] - b[0])).toEqual([
      [3, 4],
      [6, 8]
    ])
    expect(w.alerts('error')).toEqual([])
  })

  it('releases a hold the breaker put on the job, so what it queued is rendered', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    w.machineFor(nodeId).agent.autoFinish()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    const [a, b] = w.all<{ id: string }>(
      'SELECT id FROM chunks WHERE job_id = ? ORDER BY frame_start',
      jobId
    )
    w.db.prepare(`UPDATE chunks SET state = 'failed', retries = 4 WHERE id = ?`).run(a.id)
    w.db.prepare(`UPDATE jobs SET state = 'running', attention = ? WHERE id = ?`).run(
      JSON.stringify({
        kind: 'repeatedFailure',
        message: 'the same failure on 2 nodes',
        since: 1
      }),
      jobId
    )
    // Held: nothing of the job is sent.
    app.scheduler.kick()
    await w.advance(10_000)
    expect(chunkState(b.id)).toBe('pending')

    await w.invoke('job:retryMissing', jobId)

    expect(w.get('SELECT attention FROM jobs WHERE id = ?', jobId)).toEqual({ attention: null })
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })

  it('a job failed outright: the invoke says why, and nothing is queued', async () => {
    const app = await w.boot()
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    w.db.prepare(`UPDATE chunks SET state = 'failed' WHERE job_id = ?`).run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'failed' WHERE id = ?`).run(jobId)

    await expect(w.invoke('job:retryMissing', jobId)).rejects.toThrow(/failed outright/)
    expect(w.all('SELECT state FROM chunks WHERE job_id = ?', jobId)).toEqual([{ state: 'failed' }])
  })
})

describe('node:reprovision', () => {
  /** A job rendering on the node, its agent holding the render. */
  async function rendering(app: App, nodeId: string): Promise<string> {
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    const [chunk] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
    app.scheduler.kick()
    await w.until(() => chunkState(chunk.id) === 'rendering', 'chunk rendering')
    expect(w.machineFor(nodeId).agent.inbox()).toContain(chunk.id)
    return chunk.id
  }

  it('1.15: restarts the agent and requeues its render, sending the node nothing while it restarts', async () => {
    // Field incident 81fe2875: an agent restarted under live runs deleted
    // the specs in its inbox, and the runs polled for renders that were gone
    // (phantom runs, 7 of 24 GPUs idle). Here the runs go first, and nothing
    // is sent to the node until the restart is over.
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const chunkId = await rendering(app, nodeId)
    const log: string[] = []
    machine.onSpec = (spec) => log.push(`spec ${spec.chunkId}`)
    machine.onExec(/provision\.sh restart-agent --force/, () => {
      log.push(`restart while ${nodeState(app, nodeId)}, chunk ${chunkState(chunkId)}`)
      // What restart-agent does to the node: every render killed, the inbox emptied.
      for (const id of machine.agent.inbox()) {
        machine.files.delete(`/root/vastai/jobs/inbox/${id}.json`)
      }
      return 'AGENT_RESTARTED forced\n'
    })

    expect(await w.invoke('node:reprovision', nodeId)).toEqual({ requeued: 1 })

    expect(nodeState(app, nodeId)).toBe('ready')
    // The scripts went up again first: a tree from an older build has no
    // restart-agent to run.
    expect(machine.ran(/provision\.sh deps/)).toHaveLength(1)
    expect(machine.ran(/provision\.sh restart-agent --force/)).toHaveLength(1)
    // The chunk was back in the queue, and not on the node, before the restart.
    expect(log[0]).toBe('restart while provisioning, chunk pending')
    // Its render retries untouched.
    expect(w.get('SELECT retries FROM chunks WHERE id = ?', chunkId)).toEqual({ retries: 0 })
    expect(w.alerts('info')).toContainEqual(expect.stringMatching(/reprovisioned: agent restarted/))

    // Once the node is back, the chunk goes out to it again, to the new agent.
    await w.until(() => log.includes(`spec ${chunkId}`), 'chunk sent again')
    expect(log.indexOf(`spec ${chunkId}`)).toBeGreaterThan(0)
  })

  it('a restart that fails destroys the node, rather than leave it billing with its work forgotten', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const chunkId = await rendering(app, nodeId)
    machine.onExec(/provision\.sh restart-agent/, {
      code: 1,
      stdout: 'agent exited at startup; logs/agent.log ends:\nImportError: no module\n'
    })

    await expect(w.invoke('node:reprovision', nodeId)).rejects.toThrow(
      /could not be reprovisioned .*being destroyed/
    )
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(nodeState(app, nodeId)).toBe('destroyed')
    expect(chunkState(chunkId)).toBe('pending')
    expect(w.alerts('error')).toContainEqual(expect.stringMatching(/could not be reprovisioned/))
  })

  it('a node destroyed while it restarts stays destroyed, destroyed once', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    await rendering(app, nodeId)
    machine.onExec(/provision\.sh restart-agent/, HANG)

    const call = w.invoke('node:reprovision', nodeId)
    await w.until(() => machine.ran(/restart-agent/).length > 0, 'restart under way')
    await app.nodeManager.destroyNode(nodeId)

    await expect(call).resolves.toEqual({ requeued: 1 })
    expect(nodeState(app, nodeId)).toBe('destroyed')
    expect(w.vast.count('destroyInstance')).toBe(1)
    expect(w.alerts('error')).toEqual([])
  })

  it('another restart already under way: the node goes back to ready, with a warning', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    await rendering(app, nodeId)
    machine.onExec(/provision\.sh restart-agent/, {
      code: 1,
      stdout: 'another restart-agent still running after 90s — nothing done\n'
    })

    await expect(w.invoke('node:reprovision', nodeId)).rejects.toThrow(/another agent restart/)
    expect(nodeState(app, nodeId)).toBe('ready')
    expect(w.vast.count('destroyInstance')).toBe(0)
    expect(w.alerts('warn')).toContainEqual(expect.stringMatching(/was not reprovisioned/))
  })

  it('refuses a node that is not up, forgetting nothing', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const chunkId = await rendering(app, nodeId)
    w.db.prepare(`UPDATE nodes SET state = 'unreachable' WHERE id = ?`).run(nodeId)

    await expect(w.invoke('node:reprovision', nodeId)).rejects.toThrow(
      /is unreachable: only a node that is up/
    )
    expect(chunkState(chunkId)).toBe('rendering')
    expect(w.machineFor(nodeId).ran(/restart-agent/)).toEqual([])
  })
})
