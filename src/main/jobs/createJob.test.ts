import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobSubmission } from '../../shared/models'
import { setup, type World } from '../test/harness'

// createJob is the one way in for both the New render dialog (job:create) and
// a VR_JOB_SPEC campaign, so it is where a submission is refused. It must
// refuse before it touches anything: an impossible chunk size used to hang the
// main process in splitFrames with the fleet billing, and a refusal that came
// after the mkdir or the insert would leave an empty renders/<id> folder, or a
// job that could never run.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

/** The job folders under the project's renders folder. */
function renderDirs(): string[] {
  const dir = join(w.settings.projectRoot, 'renders')
  return existsSync(dir) ? readdirSync(dir) : []
}

function count(table: 'jobs' | 'chunks' | 'frames'): number {
  return w.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n
}

describe('createJob', () => {
  it.each<[string, Partial<JobSubmission> | (() => Partial<JobSubmission>), RegExp]>([
    // splitFrames spun on these until the heap ran out.
    ['a chunk size of 0', { chunkSize: 0 }, /chunk size/],
    ['a negative chunk size', { chunkSize: -1 }, /chunk size/],
    // Invented frame numbers Blender never renders.
    ['a fractional chunk size', { chunkSize: 2.5 }, /chunk size/],
    ['a frame step of 0', { frameStep: 0 }, /frame step/],
    // Used to make a job with no chunks, 'queued' forever.
    ['an end before the start', { frameStart: 10, frameEnd: 1 }, /before start/],
    ['more frames than a job may hold', { frameStart: 0, frameEnd: 1_000_000 }, /split the range/],
    // Only main can see the disk. With the Blender version pinned, as it is
    // here, nothing else reads the scene before dispatch, where a missing one
    // failed chunk after chunk on a rented node.
    [
      'a scene file that is not there',
      () => ({ blendPath: join(w.dir, 'scenes', 'gone.blend') }),
      /scene file not found/
    ]
  ])('refuses %s before any folder or row is made', async (_what, patch, message) => {
    const app = await w.boot({ start: false })

    await expect(w.submitJob(app, typeof patch === 'function' ? patch() : patch)).rejects.toThrow(
      message
    )

    expect([count('jobs'), count('chunks'), count('frames')]).toEqual([0, 0, 0])
    expect(renderDirs()).toEqual([])
  })

  it('makes the job, its chunks, its frames and its folder for a good submission', async () => {
    const app = await w.boot({ start: false })

    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 10, chunkSize: 4 })

    expect([count('jobs'), count('chunks'), count('frames')]).toEqual([1, 3, 10])
    expect(renderDirs()).toEqual([jobId])
    expect(w.eventsOf('job:changed').map((j) => j.id)).toEqual([jobId])
  })
})
