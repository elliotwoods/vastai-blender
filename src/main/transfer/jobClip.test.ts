import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type World } from '../test/harness'

// Job clip stitching on the lifecycle harness, with an ffmpeg that records the
// concat list it was handed instead of running. Chunk clip paths come from
// assets rows, built from node-supplied names (and, before those were checked,
// from anything at all), and ffmpeg reads the list with `-safe 0`. So nothing
// outside the job's folder may go in, and the job clip is written to the job's
// own previews folder, never to one derived from a clip's path.

let w: World
/** Every concat list ffmpeg was asked to stitch, as written. */
let lists: string[]

beforeEach(async () => {
  w = await setup()
  lists = []
  vi.doMock('../media/ffmpeg', () => ({
    ffmpegPath: async () => 'ffmpeg',
    runFfmpeg: async (_bin: string, args: string[]) => {
      lists.push(readFileSync(args[args.indexOf('-i') + 1], 'utf-8'))
      writeFileSync(args[args.length - 1], 'stitched')
    }
  }))
})

afterEach(() => {
  vi.doUnmock('../media/ffmpeg')
  return w.dispose()
})

interface Seeded {
  jobId: string
  jobDir: string
  chunkIds: string[]
}

/** A finished job of three two-frame chunks (frames 1-6), with no clips yet. */
async function finishedJob(): Promise<Seeded> {
  const app = await w.boot({ start: false })
  const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 6, chunkSize: 2 })
  w.db.prepare("UPDATE chunks SET state = 'complete' WHERE job_id = ?").run(jobId)
  w.db.prepare("UPDATE frames SET state = 'downloaded' WHERE job_id = ?").run(jobId)
  w.db.prepare("UPDATE jobs SET state = 'complete' WHERE id = ?").run(jobId)
  const chunkIds = w
    .all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ? ORDER BY frame_start', jobId)
    .map((c) => c.id)
  return { jobId, jobDir: join(w.settings.projectRoot, 'renders', jobId), chunkIds }
}

/** A chunk's SDR preview clip: a file, and an assets row saying where it is. */
function chunkClip(jobId: string, chunkId: string, absPath: string): void {
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, `clip ${chunkId}`)
  w.db
    .prepare(
      `INSERT INTO assets (job_id, chunk_id, kind, abs_path, fps, frames, width, height, codec, hdr, created_at)
       VALUES (?, ?, 'previewSdr', ?, 25, 2, 960, 540, 'hevc', 0, ?)`
    )
    .run(jobId, chunkId, absPath, Date.now())
}

/** Build the job's clips; the job clip's row once it is in. */
async function stitch(jobId: string): Promise<{ abs_path: string }> {
  const { jobClips } = await import('./jobClip')
  const row = (): { abs_path: string } | undefined =>
    w.get('SELECT abs_path FROM assets WHERE job_id = ? AND chunk_id IS NULL', jobId)
  jobClips.schedule(jobId)
  await w.until(() => row() !== undefined, 'job clip built')
  return row()!
}

describe('job clips', () => {
  it('leave out a chunk clip that is not inside the job folder', async () => {
    const {
      jobId,
      jobDir,
      chunkIds: [a, b, c]
    } = await finishedJob()
    chunkClip(jobId, a, join(jobDir, 'previews', `${a}_sdr.mp4`))
    chunkClip(jobId, b, join(jobDir, 'previews', `${b}_sdr.mp4`))
    // A row written before manifest names were checked, pointing anywhere.
    const elsewhere = join(w.dir, 'elsewhere', `${c}_sdr.mp4`)
    chunkClip(jobId, c, elsewhere)

    await stitch(jobId)

    expect(lists).toHaveLength(1)
    expect(lists[0]).toContain(join(jobDir, 'previews', `${a}_sdr.mp4`))
    expect(lists[0]).toContain(join(jobDir, 'previews', `${b}_sdr.mp4`))
    expect(lists[0]).not.toContain(elsewhere)
  })

  it("are written to the job's own previews folder, never a chunk clip's", async () => {
    const {
      jobId,
      jobDir,
      chunkIds: [a, b]
    } = await finishedJob()
    // Inside the job, but not where the job clip belongs. The first clip in
    // frame order used to decide where the job clip went.
    chunkClip(jobId, a, join(jobDir, 'frames', `${a}_sdr.mp4`))
    chunkClip(jobId, b, join(jobDir, 'previews', `${b}_sdr.mp4`))

    const clip = await stitch(jobId)

    expect(clip.abs_path).toBe(join(jobDir, 'previews', 'job_previewSdr.v1.mp4'))
    expect(existsSync(clip.abs_path)).toBe(true)
  })
})
