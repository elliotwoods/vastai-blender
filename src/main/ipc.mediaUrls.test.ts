import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type World } from './test/harness'

// The media URLs ipc.ts hands out (plan 1.13): the filmstrip's thumbnails,
// the Gallery's clips and the node panel's latest frame. They were relative
// to the current project root, so once the root was changed in Settings
// every earlier job's previews went blank (#9 #61 #175 #202 #214). They now
// name the job, and resolve inside its own folder whatever the root is.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

function put(path: string, data: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  return path
}

describe('media URLs from ipc.ts', () => {
  it('1.13: a job’s thumbnails and clips still load after the project root moved', async () => {
    const app = await w.boot({ start: false })
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 2, chunkSize: 2 })
    const dir = w.get<{ output_dir: string }>(
      'SELECT output_dir FROM jobs WHERE id = ?',
      jobId
    )!.output_dir
    const thumb = put(join(dir, 'thumbs', '0001.jpg'), 'jpg')
    const frame = put(join(dir, 'frames', '0001.png'), 'png')
    // A name a node's encoder could give a clip: every character survives.
    const clip = put(join(dir, 'previews', 'chunk 1 #sdr (50%).mp4'), 'mp4')
    w.db
      .prepare(
        `UPDATE frames SET state = 'downloaded', local_path = ?, thumb_path = ?
          WHERE job_id = ? AND frame = 1`
      )
      .run(frame, thumb, jobId)
    w.db.prepare(`UPDATE chunks SET node_id = 'node-x' WHERE job_id = ?`).run(jobId)
    w.db
      .prepare(
        `INSERT INTO assets (job_id, chunk_id, kind, abs_path, created_at)
         VALUES (?, 'c1', 'previewSdr', ?, 0)`
      )
      .run(jobId, clip)

    // The user picks another project root.
    w.settings.projectRoot = join(w.dir, 'moved')

    const { resolveMediaUrl } = await import('./app/mediaProtocol')
    const places = {
      roots: { project: w.settings.projectRoot },
      jobDir: (id: string) =>
        w.get<{ output_dir: string }>('SELECT output_dir FROM jobs WHERE id = ?', id)?.output_dir ??
        null
    }
    const served = (url: string | null | undefined): unknown =>
      url ? resolveMediaUrl(url, places) : url

    const [t] = await w.invoke('frames:thumbs', { jobId, from: 1, to: 2 })
    expect(t.mediaUrl).toBe(`media://job/${jobId}/thumbs/0001.jpg`)
    expect(served(t.mediaUrl)).toEqual({ abs: thumb })

    const index = await w.invoke('assets:index', jobId)
    expect(served(index.clips[0].mediaUrl)).toEqual({ abs: clip })

    const [c] = await w.invoke('node:chunks', { nodeId: 'node-x' })
    expect(served(c.thumbUrl)).toEqual({ abs: thumb })
  })
})
