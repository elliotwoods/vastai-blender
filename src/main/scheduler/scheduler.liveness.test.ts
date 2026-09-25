import { afterEach, describe, expect, it } from 'vitest'
import { HANG, REMOTE_ROOT } from '../test/fakeSsh'
import {
  setup,
  type AgentSpec,
  type AgentStateFile,
  type App,
  type FakeMachine,
  type SetupOptions,
  type World
} from '../test/harness'

// A run that has lost its render must let go of its chunk and its lane
// (plan 1.7, the run's side of it), end to end on the lifecycle harness.
// Before, a run polled every 5 s for as long as the app ran whenever the
// agent's state file never appeared or could not be read: the chunk stayed
// 'rendering', its lane stayed taken, and its node never went idle.

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

function nodeState(nodeId: string): string | undefined {
  return w.get<{ state: string }>('SELECT state FROM nodes WHERE id = ?', nodeId)?.state
}

/** Chunks dispatched to a node: every 'assigned' the renderer heard with its id. */
function assignedTo(nodeId: string): number {
  return w.eventsOf('chunk:changed').filter((c) => c.state === 'assigned' && c.nodeId === nodeId)
    .length
}

async function fleet(
  n: number,
  offer: { num_gpus?: number } = {},
  settings: SetupOptions['settings'] = {}
): Promise<{ app: App; ids: string[] }> {
  w = await setup({ settings: { maxActiveNodes: n, ...settings } })
  const app = await w.boot()
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await w.readyNode(app, offer))
  return { app, ids }
}

/** What provision.sh base did to a node the second launch re-provisioned: its inbox emptied. */
function emptyInbox(machine: FakeMachine): string[] {
  const gone = machine.agent.inbox()
  for (const id of gone) machine.files.delete(`${REMOTE_ROOT}/jobs/inbox/${id}.json`)
  return gone
}

describe('1.7 field incident 81fe2875: phantom runs', () => {
  it('specs a second launch deleted from the inbox are requeued, and the lanes they held are used again', async () => {
    // One 4-GPU node, four lanes, four specs waiting in its inbox when a
    // second copy of the app re-provisioned it: `rm jobs/inbox/*.json`.
    const { app, ids } = await fleet(1, { num_gpus: 4 })
    const machine = w.machineFor(ids[0])
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 8, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => machine.agent.inbox().length === 4, 'four specs queued')
    const lost = emptyInbox(machine)
    // The node renders whatever it is sent from here on.
    machine.agent.autoFinish()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    // Each lost chunk went back in the queue, charged to the machines, not
    // to the render, and was rendered on the lanes it had held.
    for (const id of lost) {
      expect(chunksOf(jobId).find((c) => c.id === id)).toMatchObject({
        state: 'complete',
        retries: 0,
        infra_retries: 1
      })
    }
    expect(w.alerts('warn').join('\n')).toMatch(/spec left the node's inbox with no render started/)
    expect(app.scheduler.activeWorkForNode(ids[0])).toEqual([])
  })

  it('a spec waiting its turn in the inbox of a live agent is left alone', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => machine.agent.inbox().length === 1, 'spec queued')
    // Behind busy slots for half an hour: no state, the agent alive.
    await w.advance(30 * 60_000, 5_000)
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'rendering', infra_retries: 0 })
    expect(assignedTo(ids[0])).toBe(1)
    machine.agent.finish(chunksOf(jobId)[0].id)
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
  })

  it('a node whose agent is dead: the spec is withdrawn, the chunk moves on, and the node is let go', async () => {
    const { app, ids } = await fleet(2, {}, { idleTimeoutMinutes: 5 })
    const [dead, live] = ids
    w.machineFor(dead).agent.alive = false
    // The live node renders each chunk in two minutes: work stays queued
    // while the dead one should be let go.
    const liveMachine = w.machineFor(live)
    liveMachine.onSpec = (spec) =>
      setTimeout(() => liveMachine.agent.finish(spec.chunkId), 2 * 60_000)
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 10, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => assignedTo(dead) === 1, 'a chunk sent to the dead node')
    const stranded = w
      .eventsOf('chunk:changed')
      .find((c) => c.state === 'assigned' && c.nodeId === dead)!.chunkId

    await w.until(() => nodeState(dead) === 'destroyed', 'the dead node let go', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    // Before the queue ran out: nothing but the dead agent kept it from work.
    expect(chunksOf(jobId).some((c) => c.state === 'pending')).toBe(true)
    // Sent one chunk, never another, and that one withdrawn from its inbox.
    expect(assignedTo(dead)).toBe(1)
    expect(w.machineFor(dead).ran(new RegExp(`jobs/inbox/${stranded}\\.json; pkill`))).toHaveLength(
      1
    )
    expect(w.alerts('error').join('\n')).toMatch(/agent is not running.*Nothing more is sent to it/)

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 60 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId).find((c) => c.id === stranded)).toMatchObject({
      state: 'complete',
      node_id: live,
      retries: 0,
      infra_retries: 1
    })
  })

  it('a node whose agent is dead is not counted as room for the queue', async () => {
    // Kept past the test, so only scale-up can make room.
    const { app, ids } = await fleet(2, {}, { maxActiveNodes: 3, idleTimeoutMinutes: 120 })
    const [dead, live] = ids
    w.machineFor(dead).agent.alive = false
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => assignedTo(dead) === 1 && assignedTo(live) === 1, 'one chunk each')
    // The live node is busy with its chunk for a long while.
    w.vast.addOffer()
    await w.until(
      () => w.alerts('error').some((a) => /agent is not running/.test(a)),
      'the dead agent found'
    )
    // Its free lane read as room for the chunk it gave back: covered, so
    // nothing was rented, and the chunk waited for the live node's.
    await w.until(() => w.vast.count('createInstance') === 3, 'a node rented for it')
    expect(nodeState(dead)).not.toBe('destroyed')
    expect(chunksOf(jobId).filter((c) => c.state === 'pending')).toHaveLength(1)
  })

  it('a node that stops answering: the run gives its chunk back, and it renders elsewhere', async () => {
    // The other node idles through the ten minutes, and must still be there.
    const { app, ids } = await fleet(2, {}, { idleTimeoutMinutes: 60 })
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(() => chunksOf(jobId)[0].state === 'rendering', 'rendering')
    const silent = chunksOf(jobId)[0].node_id!
    const other = ids.find((id) => id !== silent)!
    w.machineFor(silent).agent.progress(chunk.id, 1)
    await w.advance(10_000)
    // Every read of the state fails from here on, as on a wedged link.
    w.machineFor(silent).onExec(/^cat \S*\/state\//, () =>
      Promise.reject(new Error('(SSH) Channel open failure'))
    )
    w.machineFor(other).agent.autoFinish()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: other, retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(
      /has not answered for 10 min \(.*Channel open failure.*requeued without charging the render/
    )
    // Withdrawn on the silent node, in case it answers again.
    expect(w.machineFor(silent).ran(new RegExp(`pkill -f '${chunk.id}'`))).not.toEqual([])
  })
})

describe('1.7: a hung Blender', () => {
  /**
   * An agent whose render runs as scripted: the state rewritten every 60 s,
   * as the agent's heartbeat does while Blender lives, with lastProgressAt
   * wherever the last frame left it, as `progressAt()` says at each beat.
   */
  function heartbeat(
    machine: FakeMachine,
    chunkId: string,
    progressAt: () => { at: number; frames: number }
  ): () => void {
    const beat = (): void => {
      const p = progressAt()
      machine.agent.writeState(chunkId, {
        status: 'rendering',
        framesDone: p.frames,
        currentFrame: p.frames + 1,
        lastProgressAt: p.at
      } as Partial<AgentStateFile>)
    }
    beat()
    const timer = setInterval(beat, 60_000)
    return () => clearInterval(timer)
  }

  /** lastProgressAt and framesDone for frames saved at `savedMin` minutes after `start` (epoch s). */
  function savedAt(start: number, savedMin: number[]): () => { at: number; frames: number } {
    const saved = savedMin.map((m) => start + m * 60)
    return () => {
      const now = Date.now() / 1000
      const done = saved.filter((t) => t <= now)
      return { at: done.length ? done[done.length - 1] : start, frames: done.length }
    }
  }

  it('frames saved at ten and twenty minutes, then none for 45: stopped, and only its missing frames render again', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length > 1) return machine.agent.finish(spec.chunkId)
      // Frames 1 and 2 land ten minutes apart, then Blender hangs on
      // frame 3, alive.
      setTimeout(() => machine.agent.render(spec.chunkId, [1]), 10 * 60_000)
      setTimeout(() => machine.agent.render(spec.chunkId, [2]), 20 * 60_000)
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [10, 20]))
    }
    // The heartbeat goes once Blender is killed, as the real one does.
    machine.onExec(/pkill -f/, () => {
      stop()
      return ''
    })
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    const startedAt = Date.now()
    app.scheduler.kick()

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 120 * 60_000,
      stepMs: 5_000
    })
    stop()
    // The node's failure the first time: charged to the machines, and the
    // retry leaves out the frames that had already landed.
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(specs.map((s) => [s.frameStart, s.frameEnd])).toEqual([
      [1, 4],
      [3, 4]
    ])
    expect(machine.ran(new RegExp(`pkill -f '${chunk.id}'`))).not.toEqual([])
    expect(w.alerts('warn').join('\n')).toMatch(
      /Blender made no progress \(no frame started or saved\) for 4\d min while it kept running, where this job's frames have taken up to 10 min on this hardware/
    )
    // Twenty minutes of frames and 45 without one, not three times ten.
    expect(Date.now() - startedAt).toBeLessThan(75 * 60_000)
  }, 20_000)

  it('a first frame of fifty minutes, then frames of twenty, is not taken for a hang', async () => {
    // The review's case: a chunk's first frame was judged against 45 min
    // alone, since the run had timed nothing yet, and killed on every attempt.
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [50, 70, 90, 110]))
      setTimeout(() => {
        stop()
        machine.agent.finish(spec.chunkId)
      }, 110 * 60_000)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 150 * 60_000,
      stepMs: 5_000
    })
    stop()
    expect(specs).toHaveLength(1)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 0 })
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 20_000)

  it("a Blender hung on the job's very first frame is stopped at three hours, not left for good", async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      if (specs.length > 1) return machine.agent.finish(spec.chunkId)
      // Started, and never a frame.
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, []))
    }
    machine.onExec(/pkill -f/, () => {
      stop()
      return ''
    })
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => specs.length === 1, 'dispatched')
    await w.advance(175 * 60_000, 10_000)
    // Nothing is known of what the job's frames take: not yet.
    expect(specs).toHaveLength(1)
    expect(chunksOf(jobId)[0]).toMatchObject({ state: 'rendering', infra_retries: 0 })

    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 30 * 60_000,
      stepMs: 5_000
    })
    stop()
    expect(specs).toHaveLength(2)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(
      /no progress \(no frame started or saved\) for 18\d min while it kept running, where no frame of this job had finished on this hardware yet/
    )
  }, 30_000)

  it("what a frame takes on one GPU model does not judge another's first frame", async () => {
    w = await setup({ settings: { maxActiveNodes: 2 } })
    const app = await w.boot()
    const fast = await w.readyNode(app, { gpu_name: 'RTX 4090' })
    const slow = await w.readyNode(app, { gpu_name: 'RTX 3060' })
    const specs = new Map<string, AgentSpec[]>([
      [fast, []],
      [slow, []]
    ])
    const stops: Array<() => void> = []
    // A frame takes ten minutes on the 4090 and an hour on the 3060.
    for (const [nodeId, minutes] of [
      [fast, 10],
      [slow, 60]
    ] as const) {
      const machine = w.machineFor(nodeId)
      machine.onSpec = (spec) => {
        specs.get(nodeId)!.push(spec)
        const stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [minutes]))
        stops.push(stop)
        setTimeout(
          () => {
            stop()
            machine.agent.finish(spec.chunkId)
          },
          (minutes + 1) * 60_000
        )
      }
    }
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 120 * 60_000,
      stepMs: 5_000
    })
    for (const stop of stops) stop()
    expect(specs.get(fast)).toHaveLength(1)
    expect(specs.get(slow)).toHaveLength(1)
    expect(chunksOf(jobId).map((c) => [c.retries, c.infra_retries])).toEqual([
      [0, 0],
      [0, 0]
    ])
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 20_000)

  it('frames that take twenty minutes each, and one that takes fifty, are not taken for a hang', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    const specs: AgentSpec[] = []
    let stop = (): void => {}
    machine.onSpec = (spec) => {
      specs.push(spec)
      // Saved at 20, 40, 90 and 95 minutes.
      stop = heartbeat(machine, spec.chunkId, savedAt(Date.now() / 1000, [20, 40, 90, 95]))
      setTimeout(() => {
        stop()
        machine.agent.finish(spec.chunkId)
      }, 95 * 60_000)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 120 * 60_000,
      stepMs: 5_000
    })
    stop()
    expect(specs).toHaveLength(1)
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 0 })
    expect(w.alerts().join('\n')).not.toMatch(/no progress/)
  }, 20_000)
})

describe('1.8: a spec write with no answer', () => {
  it('fails at its deadline, and the chunk is sent again, charged to the machines', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    // The first spec write goes out on an SFTP channel that never answers
    // it, as a channel another transfer's stall reset does (#244, #245).
    machine.onSftp('writeFile', HANG, 1)
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', { timeoutMs: 10 * 60_000 })
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
    expect(w.alerts('warn').join('\n')).toMatch(/SFTP write \S+\.tmp\.json: no answer for 30s/)
  })

  it('a rename the node applied with its answer lost is withdrawn before the chunk goes back', async () => {
    const { app, ids } = await fleet(1)
    const machine = w.machineFor(ids[0])
    // The node moves the spec into place and its answer never comes (a
    // channel reset under it, #245): the spec is live while the dispatch
    // fails, and an agent would render it with nobody polling it.
    machine.onSftp(
      'rename',
      (from, m) => {
        if (!from.endsWith('.tmp.json')) return undefined
        m.files.set(from.replace(/\.tmp\.json$/, '.json'), m.files.get(from)!)
        m.files.delete(from)
        return HANG
      },
      1
    )
    const jobId = await w.submitJob(app)
    const [chunk] = chunksOf(jobId)
    app.scheduler.kick()
    await w.until(
      () => w.alerts('warn').some((a) => a.startsWith(`dispatch ${chunk.id} failed`)),
      'the dispatch failed'
    )
    expect(machine.agent.inbox()).not.toContain(chunk.id)
    expect(machine.ran(new RegExp(`pkill -f '${chunk.id}'`))).toHaveLength(1)

    machine.agent.autoFinish()
    await w.until(() => jobState(jobId) === 'complete', 'job complete')
    expect(chunksOf(jobId)[0]).toMatchObject({ retries: 0, infra_retries: 1 })
  })
})

describe('1.8: a node prep that hangs', () => {
  it('releases the prep lock at its deadline: the chunks waiting on it move on, and the stuck node is let go', async () => {
    w = await setup({ settings: { maxActiveNodes: 2, idleTimeoutMinutes: 8 } })
    const app = await w.boot()
    const stuckId = await w.readyNode(app, { num_gpus: 4 })
    // Its Blender download never ends. Every dispatch to it waits on the
    // one prep lock the first one holds.
    w.machineFor(stuckId).onExec(/provision\.sh install-blender/, HANG)
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 1 })
    app.scheduler.kick()
    await w.until(() => assignedTo(stuckId) === 4, 'four lanes in node prep')
    // install-blender's own ceiling is 130 min: on healthy mirrors it may
    // take that long, so nothing is given up before.
    await w.advance(125 * 60_000, 5_000)
    expect(chunksOf(jobId).map((c) => c.state)).toEqual([
      'assigned',
      'assigned',
      'assigned',
      'assigned'
    ])

    // A second node joins; it renders a chunk in four minutes.
    const otherId = await w.readyNode(app)
    const other = w.machineFor(otherId)
    other.onSpec = (spec) => setTimeout(() => other.agent.finish(spec.chunkId), 4 * 60_000)

    // At the deadline the lock goes, and the three waiting behind it with it:
    // all four back in the queue at once, charged to the machines.
    await w.until(
      () => chunksOf(jobId).every((c) => c.node_id !== stuckId || c.state !== 'assigned'),
      'the stuck node lets go of its chunks',
      { timeoutMs: 10 * 60_000 }
    )
    expect(chunksOf(jobId).map((c) => [c.retries, c.infra_retries])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1]
    ])
    expect(w.alerts('warn').join('\n')).toMatch(
      /setting up the node did not finish: installing Blender 4\.2\.3 ran past its own 130 min limit/
    )

    // Sent nothing more, it is let go of while work is still queued.
    await w.until(() => nodeState(stuckId) === 'destroyed', 'the stuck node let go', {
      timeoutMs: 20 * 60_000,
      stepMs: 5_000
    })
    expect(chunksOf(jobId).some((c) => c.state === 'pending')).toBe(true)
    expect(assignedTo(stuckId)).toBe(4)
    // Forgotten with the node, not kept for good.
    expect(app.scheduler.nodeUnfit(stuckId)).toBeNull()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 60 * 60_000,
      stepMs: 5_000
    })
  }, 20_000)

  it('a 70-minute Blender install and a scene upload moving for 70 minutes both finish, and the chunk renders on that node', async () => {
    // The review's case: one deadline over the whole prep, 60 min, took a
    // node still installing within install-blender's own ceiling for stuck,
    // and destroyed it five minutes before the install would have finished.
    w = await setup({ settings: { maxActiveNodes: 1, idleTimeoutMinutes: 5 } })
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    machine.onExec(
      /provision\.sh install-blender/,
      () => new Promise((resolve) => setTimeout(() => resolve(''), 70 * 60_000))
    )
    slowUploads(app.nodeManager.get(nodeId)!.ssh, 70 * 60_000)
    machine.agent.autoFinish()
    const jobId = await w.submitJob(app)
    const startedAt = Date.now()
    app.scheduler.kick()
    await w.until(() => jobState(jobId) === 'complete', 'job complete', {
      timeoutMs: 180 * 60_000,
      stepMs: 5_000
    })
    // Both ran their whole length, one after the other.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140 * 60_000)
    expect(chunksOf(jobId)[0]).toMatchObject({ node_id: nodeId, retries: 0, infra_retries: 0 })
    expect(assignedTo(nodeId)).toBe(1)
    expect(nodeState(nodeId)).not.toBe('destroyed')
    expect(app.scheduler.nodeUnfit(nodeId)).toBeNull()
    expect(w.alerts().join('\n')).not.toMatch(/did not finish|is stuck/)
  }, 20_000)
})

/** The SFTP channel as slowUploads handles it. */
interface UploadChannel {
  slowed?: boolean
  fastPut: (
    local: string,
    remote: string,
    opts: { step?: () => void },
    cb: (err?: Error | null) => void
  ) => void
}

/**
 * Every upload on this connection takes `ms`, reporting progress every 20 s
 * as a transfer that keeps moving does: its stall guard never fires.
 */
function slowUploads(ssh: unknown, ms: number): void {
  const conn = ssh as { sftp: (...args: unknown[]) => Promise<UploadChannel> }
  const open = conn.sftp.bind(conn)
  conn.sftp = async (...args) => {
    const sftp = await open(...args)
    if (!sftp.slowed) {
      sftp.slowed = true
      const put = sftp.fastPut.bind(sftp)
      sftp.fastPut = (local, remote, opts, cb) => {
        const moving = setInterval(() => opts.step?.(), 20_000)
        setTimeout(() => {
          clearInterval(moving)
          put(local, remote, opts, cb)
        }, ms)
      }
    }
    return sftp
  }
}
