import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { setup, type FakeMachine, type World } from '../test/harness'

// Plan 1.13: jobs.output_dir is the one answer to where a job's files live.
// createJob fixes it under the project root of the moment, and the
// downloader used to work the folder out again from the current root for
// every file, and media URLs were made relative to it. Changing the root in
// Settings mid-job split a running job across two folders, and every
// earlier preview went blank (#9 #61 #175 #202 #214).

let w: World
beforeEach(async () => {
  // One node: the job's two chunks render on it one after the other.
  w = await setup({ settings: { maxActiveNodes: 1 } })
})
afterEach(() => w.dispose())

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** List a preview on the node as the agent's PreviewWorker does: the file, then its manifest line. */
function listPreview(
  machine: FakeMachine,
  chunkId: string,
  entry: { kind: 'thumb' | 'clip'; file: string; meta: Record<string, unknown> }
): void {
  const dir = `${REMOTE_ROOT}/renders/${chunkId}`
  const data = Buffer.from(`${entry.file} of ${chunkId}\n`, 'utf-8')
  machine.files.set(`${dir}/${entry.file}`, data)
  const manifest = `${dir}/manifest.jsonl`
  const line = JSON.stringify({
    ...entry,
    size: data.length,
    sha256: sha256(data),
    mtime: Date.now() / 1000
  })
  const before = machine.files.get(manifest)?.toString('utf-8') ?? ''
  machine.files.set(manifest, Buffer.from(`${before}${line}\n`, 'utf-8'))
}

function thumb(frame: number): { kind: 'thumb'; file: string; meta: Record<string, unknown> } {
  return {
    kind: 'thumb',
    file: `thumbs/${String(frame).padStart(4, '0')}.jpg`,
    meta: { frame, width: 320 }
  }
}

function clip(
  chunkId: string,
  kindKey: 'live' | 'previewSdr'
): { kind: 'clip'; file: string; meta: Record<string, unknown> } {
  const file =
    kindKey === 'live'
      ? `previews/${chunkId}_live_1700000000_0002.mp4`
      : `previews/${chunkId}_sdr.mp4`
  return {
    kind: 'clip',
    file,
    meta: { kindKey, file, fps: 25, frames: 2, width: 960, height: 540, codec: 'hevc', hdr: false }
  }
}

describe("a job's files and jobs.output_dir (plan 1.13)", () => {
  it('1.13 (#9 #214): the project root changed mid-job: every file lands in the job’s own folder, and its previews still load', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 2 })
    const outputDir = w.get<{ output_dir: string }>(
      'SELECT output_dir FROM jobs WHERE id = ?',
      jobId
    )!.output_dir
    const [first, second] = w.all<{ id: string }>(
      'SELECT id FROM chunks WHERE job_id = ? ORDER BY frame_start',
      jobId
    )
    const chunkState = (id: string): unknown =>
      w.get<{ state: string }>('SELECT state FROM chunks WHERE id = ?', id)?.state
    const added = (kind: string): number =>
      w.eventsOf('asset:added').filter((a) => a.kind === kind).length
    app.scheduler.kick()

    // The first chunk's thumbnail and live clip land under the old root.
    await w.until(() => machine.agent.inbox().includes(first.id), 'first spec')
    listPreview(machine, first.id, thumb(1))
    listPreview(machine, first.id, clip(first.id, 'live'))
    await w.until(() => added('thumb') === 1 && added('live') === 1, 'first previews landed')
    const live = w.eventsOf('asset:added').find((a) => a.kind === 'live')!.path

    // The user picks another project root while the job renders.
    const moved = join(w.dir, 'moved')
    w.settings.projectRoot = moved

    // The rest of the first chunk, and all of the second, arrive after it.
    listPreview(machine, first.id, clip(first.id, 'previewSdr'))
    machine.agent.finish(first.id)
    await w.until(() => chunkState(first.id) === 'complete', 'first chunk complete')
    await w.until(() => machine.agent.inbox().includes(second.id), 'second spec')
    listPreview(machine, second.id, thumb(3))
    listPreview(machine, second.id, clip(second.id, 'previewSdr'))
    machine.agent.finish(second.id)
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete'
    )

    // Every frame is in the job's folder, the one "Open output folder" opens.
    const frames = w.all<{ frame: number; local_path: string }>(
      'SELECT frame, local_path FROM frames WHERE job_id = ? ORDER BY frame',
      jobId
    )
    expect(frames.map((f) => f.local_path)).toEqual(
      [1, 2, 3, 4].map((f) => join(outputDir, 'frames', `000${f}.png`))
    )
    for (const f of frames) expect(existsSync(f.local_path)).toBe(true)
    expect(existsSync(join(moved, 'renders', jobId))).toBe(false)

    // Every preview URL the renderer was sent loads the file it names, the
    // ones handed out before the move included, as index.ts resolves them.
    const { resolveMediaUrl } = await import('../app/mediaProtocol')
    const places = {
      roots: { project: moved },
      jobDir: (id: string) =>
        w.get<{ output_dir: string }>('SELECT output_dir FROM jobs WHERE id = ?', id)?.output_dir ??
        null
    }
    const previews = w.eventsOf('asset:added').filter((a) => a.kind !== 'frame')
    expect(previews.map((p) => p.kind).sort()).toEqual([
      'live',
      'previewSdr',
      'previewSdr',
      'thumb',
      'thumb'
    ])
    for (const p of previews) {
      expect(p.path.startsWith(outputDir)).toBe(true)
      expect(resolveMediaUrl(p.mediaUrl!, places)).toEqual({ abs: p.path })
    }

    // The live clip the first chunk's SDR clip superseded is removed from the
    // job's folder, though that folder is no longer under the project root.
    await w.advance(31_000)
    expect(existsSync(live)).toBe(false)
    expect(existsSync(join(outputDir, 'previews', `${second.id}_sdr.mp4`))).toBe(true)
  })
})
