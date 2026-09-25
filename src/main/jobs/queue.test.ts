import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type App, type World } from '../test/harness'

// The render queue (jobs/queue.ts) through the IPC the Jobs screen uses:
// order, groups, removing a finished job from the list, and what a revive
// or a job's end does to its place.

let w: World
let app: App
beforeEach(async () => {
  w = await setup()
  app = await w.boot({ start: false })
})
afterEach(() => w.dispose())

async function three(): Promise<[string, string, string]> {
  const a = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
  await w.advance(1_000)
  const b = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
  await w.advance(1_000)
  const c = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
  return [a, b, c]
}

async function order(): Promise<string[][]> {
  return (await w.invoke('queue:list')).map((e) => e.jobIds)
}

function place(jobId: string): { queue_pos: number | null; group_id: string | null } {
  return w.get('SELECT queue_pos, group_id FROM jobs WHERE id = ?', jobId)!
}

describe('the render queue', () => {
  it('queues jobs in the order they were submitted, a new one at the end', async () => {
    const [a, b, c] = await three()
    expect(await order()).toEqual([[a], [b], [c]])
    expect([a, b, c].map((id) => place(id).queue_pos)).toEqual([1, 2, 3])
  })

  it('moves a job before another, or to the end, and announces the jobs that moved', async () => {
    const [a, b, c] = await three()
    const before = w.eventsOf('job:changed').length
    const q = await w.invoke('job:move', { jobId: c, before: a })
    expect(q.map((e) => [e.position, e.jobIds])).toEqual([
      [1, [c]],
      [2, [a]],
      [3, [b]]
    ])
    expect(
      w
        .eventsOf('job:changed')
        .slice(before)
        .map((j) => [j.id, j.queuePos])
        .sort()
    ).toEqual(
      [
        [a, 2],
        [b, 3],
        [c, 1]
      ].sort()
    )
    await w.invoke('job:move', { jobId: c, before: null })
    expect(await order()).toEqual([[a], [b], [c]])
  })

  it('groups two jobs at the target’s place, moves them together, and ungroups', async () => {
    const [a, b, c] = await three()
    const { groupId } = await w.invoke('job:group', { jobId: c, withJobId: a })
    expect(await order()).toEqual([[a, c], [b]])
    expect(place(a)).toEqual({ queue_pos: 1, group_id: groupId })
    expect(place(c)).toEqual({ queue_pos: 1, group_id: groupId })
    const summary = (await w.invoke('jobs:list')).find((j) => j.id === c)!
    expect(summary).toMatchObject({ queuePos: 1, groupId })

    // A group moves whole.
    await w.invoke('job:move', { jobId: a, before: null })
    expect(await order()).toEqual([[b], [a, c]])

    // Ungrouped, a job stands just after its old group; a group of one is
    // no group.
    await w.invoke('job:ungroup', a)
    expect(await order()).toEqual([[b], [c], [a]])
    expect(place(c).group_id).toBeNull()
  })

  it('a third job joins an existing group', async () => {
    const [a, b, c] = await three()
    const { groupId } = await w.invoke('job:group', { jobId: b, withJobId: a })
    expect(await w.invoke('job:group', { jobId: c, withJobId: b })).toEqual({ groupId })
    expect(await order()).toEqual([[a, b, c]])
  })

  it('a job leaves its group as it ends, and a group of one dissolves', async () => {
    const [a, b] = await three()
    await w.invoke('job:group', { jobId: b, withJobId: a })
    await app.scheduler.cancelJob(a)
    expect(place(a).group_id).toBeNull()
    expect(place(b).group_id).toBeNull()
    expect(w.eventsOf('job:changed').at(-1)).toMatchObject({ id: b, groupId: null })
  })

  it('refuses what cannot be done, saying why', async () => {
    const [a] = await three()
    await expect(w.invoke('job:move', { jobId: 'nope', before: null })).rejects.toThrow(
      /^not_found: /
    )
    await expect(w.invoke('job:group', { jobId: a, withJobId: a })).rejects.toThrow(
      /^bad_request: /
    )
    await expect(w.invoke('job:remove', a)).rejects.toThrow(/^active: .*cancel it/)
  })

  it('removes a finished job from the list, keeps it for campaigns, and restores it', async () => {
    const [a, b, c] = await three()
    await app.scheduler.cancelJob(a)
    await expect(w.invoke('job:move', { jobId: a, before: null })).rejects.toThrow(/^conflict: /)
    await w.invoke('job:remove', a)
    expect((await w.invoke('jobs:list')).map((j) => j.id)).not.toContain(a)
    const hidden = (await w.invoke('jobs:list', { includeHidden: true })).find((j) => j.id === a)
    expect(hidden?.hiddenAt).toBe(Date.now())
    expect(app.jobs.listJobs({ includeHidden: true }).map((j) => j.id)).toContain(a)

    await w.invoke('job:restore', a)
    expect((await w.invoke('jobs:list')).map((j) => j.id)).toContain(a)
    // Listed, not queued: it is still cancelled.
    expect(await order()).toEqual([[b], [c]])
  })

  it('a revived job goes to the end of the queue and is listed again', async () => {
    const [a, b, c] = await three()
    await app.scheduler.cancelJob(a)
    await w.invoke('job:remove', a)
    const { reviveFailedChunks } = await import('./revive')
    reviveFailedChunks(a)
    expect(await order()).toEqual([[b], [c], [a]])
    expect((await w.invoke('jobs:list')).map((j) => j.id)).toContain(a)
  })
})
