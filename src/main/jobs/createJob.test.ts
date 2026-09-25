import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
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

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// Plan 1.12: a job renders the scene as it was submitted. Every dispatch used
// to upload whatever was at blend_path at that moment, so an artist who went
// on working and saved mid-render got a job whose later chunks rendered the
// new revision, with nothing saying which frames came from which (#53 #148).
describe('the scene as submitted (plan 1.12)', () => {
  it('1.12 (#53 #148): the job keeps a copy of its scene and its hash, and a save over the original changes neither', async () => {
    const app = await w.boot({ start: false })
    const blend = w.blend('shot.blend')
    const submitted = readFileSync(blend)

    const jobId = await w.submitJob(app, { blendPath: blend })

    const row = w.get<{ output_dir: string; blend_sha256: string; scene_path: string }>(
      'SELECT output_dir, blend_sha256, scene_path FROM jobs WHERE id = ?',
      jobId
    )!
    expect(row.scene_path).toBe(join(row.output_dir, 'scene.blend'))
    expect(readFileSync(row.scene_path)).toEqual(submitted)
    expect(row.blend_sha256).toBe(sha256(submitted))
    expect((await w.invoke('job:get', jobId))?.blendSha256).toBe(sha256(submitted))

    // The artist goes on working, and saves.
    writeFileSync(blend, 'BLENDER-v402 edited after submit\n')

    expect(readFileSync(row.scene_path)).toEqual(submitted)
    expect(w.get('SELECT blend_sha256 FROM jobs WHERE id = ?', jobId)).toEqual({
      blend_sha256: sha256(submitted)
    })
  })

  it('1.12: sceneChanged says the original has been saved over, or moved, since submit', async () => {
    const app = await w.boot({ start: false })
    const sceneChanged = async (id: string): Promise<boolean | null | undefined> =>
      (await w.invoke('job:get', id))?.sceneChanged
    const saved = w.blend('saved.blend')
    const moved = w.blend('moved.blend')
    const savedJob = await w.submitJob(app, { blendPath: saved })
    const movedJob = await w.submitJob(app, { blendPath: moved })

    // Not known until the files have been looked at; the look is announced.
    expect(await sceneChanged(savedJob)).toBeNull()
    await w.until(async () => (await sceneChanged(savedJob)) === false, 'unchanged, once looked at')
    expect(w.eventsOf('job:changed').filter((j) => j.id === savedJob)).toHaveLength(2)

    // Saved again: the same bytes, a later time, as a save that changed nothing.
    const later = new Date(statSync(saved).mtimeMs + 60_000)
    utimesSync(saved, later, later)
    await w.until(async () => (await sceneChanged(savedJob)) === true, 'changed, after a save')

    renameSync(moved, `${moved}.old`)
    await w.until(async () => (await sceneChanged(movedJob)) === true, 'changed, once moved')
    expect(await app.jobs.checkSceneChanged(movedJob)).toBe(true)
  })

  it('1.12: a job from before snapshots has no scene hash, and nothing to say about its scene', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app)
    w.db.prepare('UPDATE jobs SET blend_sha256 = NULL, scene_path = NULL WHERE id = ?').run(jobId)

    const job = await w.invoke('job:get', jobId)

    expect(job).toMatchObject({ blendSha256: null, sceneChanged: null })
    expect(await app.jobs.checkSceneChanged(jobId)).toBeNull()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a scene it cannot copy, before any folder or row is left',
    async () => {
      const app = await w.boot({ start: false })
      const blend = w.blend('locked.blend')
      chmodSync(blend, 0o000)
      try {
        await expect(w.submitJob(app, { blendPath: blend })).rejects.toThrow(
          /could not copy the scene into the job's folder/
        )
      } finally {
        chmodSync(blend, 0o644)
      }
      expect([count('jobs'), count('chunks'), count('frames')]).toEqual([0, 0, 0])
      expect(renderDirs()).toEqual([])
    }
  )
})
