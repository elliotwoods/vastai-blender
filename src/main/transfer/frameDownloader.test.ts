import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/sshConnection'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { setup, type FakeMachine, type World } from '../test/harness'
import type { ChunkDownloader, DrainResult } from './frameDownloader'
import type { ParsedManifest } from './manifest'

// The final download pass on its own: a real ChunkDownloader against a fake
// node's manifest, with the manifest read broken in the ways a busy or dying
// node breaks it. What must hold is that a read that did not happen is never
// mistaken for a manifest with nothing left in it.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

interface Rig {
  jobId: string
  chunkId: string
  machine: FakeMachine
  downloader: ChunkDownloader
}

/**
 * A job (frames 1-4, one chunk) and a downloader for its chunk on a fresh fake
 * node. `frames` overrides the range the downloader is told the chunk covers.
 */
async function rig(frames = { start: 1, end: 4, step: 1 }): Promise<Rig> {
  const app = await w.boot({ start: false })
  const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
  const [{ id: chunkId }] = w.all<{ id: string }>('SELECT id FROM chunks WHERE job_id = ?', jobId)
  const inst = w.vast.addInstance()
  const machine = w.vast.machine(inst.id)
  const [ep] = machine.endpoints
  // The mocked class, as the scheduler gets it.
  const ssh = await import('../ssh/sshConnection')
  const conn: SshConnection = new ssh.SshConnection({
    host: ep.host,
    port: ep.port,
    username: 'root',
    privateKey: Buffer.from('harness private key'),
    pinnedHostKey: null
  })
  const { ChunkDownloader } = await import('./frameDownloader')
  const downloader = new ChunkDownloader({
    jobId,
    chunkId,
    nodeId: 'node-under-test',
    ssh: conn,
    remoteChunkDir: `${REMOTE_ROOT}/renders/${chunkId}`,
    frames
  })
  return { jobId, chunkId, machine, downloader }
}

/** drain() to completion on the fake clock. */
async function drain(r: Rig): Promise<DrainResult> {
  let out: DrainResult | null = null
  void r.downloader.drain().then((d) => (out = d))
  await w.until(() => out !== null, 'drain returns')
  return out!
}

function downloaded(jobId: string): number[] {
  return w
    .all<{ frame: number }>(
      "SELECT frame FROM frames WHERE job_id = ? AND state = 'downloaded' ORDER BY frame",
      jobId
    )
    .map((f) => f.frame)
}

const manifest = /manifest\.jsonl/

/**
 * Save a file on the node and list it, as noderunner's FrameTracker lists
 * whatever Blender printed "Saved:" for. `onNode: false` lists a file that
 * is not there (any more).
 */
function saved(r: Rig, file: string, opts: { onNode?: boolean } = {}): void {
  const dir = `${REMOTE_ROOT}/renders/${r.chunkId}`
  const data = Buffer.from(`fake render ${r.chunkId} ${file}\n`, 'utf-8')
  if (opts.onNode !== false) r.machine.files.set(`${dir}/${file}`, data)
  const line = {
    kind: 'frame',
    file,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    mtime: 1
  }
  const prev = r.machine.files.get(`${dir}/manifest.jsonl`)?.toString('utf-8') ?? ''
  r.machine.files.set(`${dir}/manifest.jsonl`, Buffer.from(prev + JSON.stringify(line) + '\n'))
}

describe('ChunkDownloader.drain', () => {
  it('retries a final manifest read that throws, then fetches what it lists', async () => {
    const r = await rig()
    r.machine.agent.render(r.chunkId, [1, 2, 3, 4])
    // "Channel open failure" is what execChannel gives up with once the node's
    // session cap has held for its whole retry budget.
    r.machine.onExec(manifest, () => Promise.reject(new Error('(SSH) Channel open failure')), 2)

    const result = await drain(r)

    expect(r.machine.ran(manifest)).toHaveLength(3)
    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })

  it('treats a read whose channel closed (exit null) as failed, not as an empty manifest', async () => {
    const r = await rig()
    r.machine.agent.render(r.chunkId, [1, 2, 3, 4])
    // ssh2 resolves, rather than rejects, when the channel closes under a
    // command: exit null and whatever output had arrived.
    r.machine.onExec(manifest, { code: null, stdout: '' }, 1)

    const result = await drain(r)

    expect(result.manifestRead).toBe(true)
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })

  it('reports a manifest it never managed to read as unread, not as nothing lost', async () => {
    const r = await rig()
    r.machine.agent.render(r.chunkId, [1, 2, 3, 4])
    r.machine.onExec(manifest, () => Promise.reject(new Error('exec timeout after 30000ms')))
    const started = Date.now()

    const result = await drain(r)

    expect(result.manifestRead).toBe(false)
    expect(r.machine.ran(manifest).length).toBeGreaterThan(1)
    // A few tries over tens of seconds, not the whole ten-minute budget.
    expect(Date.now() - started).toBeLessThan(2 * 60_000)
    expect(downloaded(r.jobId)).toEqual([])
  })

  it('takes a manifest the agent has not written yet as read and empty, without retrying', async () => {
    const r = await rig()
    const started = Date.now()

    // cat exits 1 with nothing on stdout: a chunk that failed before its first frame.
    const result = await drain(r)

    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(r.machine.ran(manifest)).toHaveLength(1)
    expect(Date.now()).toBe(started)
  })

  it('reads the manifest no more once stopped mid-drain', async () => {
    const r = await rig()
    r.machine.onExec(manifest, () => Promise.reject(new Error('(SSH) Channel open failure')))
    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => r.machine.ran(manifest).length === 1, 'first read failed')

    r.downloader.stop()
    await w.until(() => out !== null, 'drain returns')

    // It waits out the backoff already under way, but reads nothing after the stop.
    expect(r.machine.ran(manifest)).toHaveLength(1)
  })
})

describe('a line the parser should have refused', () => {
  afterEach(() => {
    vi.doUnmock('./manifest')
  })

  it('is refused by the download itself, its name made as safe to show as a parser refusal', async () => {
    // Climbs out of the job folder, and carries a bidi override that makes the
    // alert read backwards, in a name far too long for an alert.
    const file = `../\u202e${'x'.repeat(200)}.png`
    vi.doMock('./manifest', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./manifest')>()),
      parseManifest: (): ParsedManifest => ({
        entries: [{ kind: 'frame', file, size: 10, sha256: 'a'.repeat(64), mtime: 1 }],
        rejected: []
      })
    }))
    const r = await rig()

    const result = await drain(r)

    expect(result.lost).toHaveLength(1)
    const refusals = w.alerts('error').filter((m) => m.includes('refused'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('"../\\u202exxx')
    expect(refusals[0]).not.toMatch(/[^\x20-\x7e]/)
    expect(refusals[0]).not.toContain('x'.repeat(81))
  })
})

describe("frames that are not the chunk's", () => {
  function local(r: Rig, file: string): boolean {
    return existsSync(join(w.settings.projectRoot, 'renders', r.jobId, file))
  }

  it('are skipped, and not counted as lost', async () => {
    // Another chunk's frames (a retry's manifest still lists the wider first
    // attempt's), and one belonging to no chunk at all.
    const r = await rig({ start: 2, end: 3, step: 1 })
    for (const f of ['0001', '0002', '0003', '0004', '0009']) saved(r, `frames/${f}.png`)

    const result = await drain(r)

    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(downloaded(r.jobId)).toEqual([2, 3])
    expect(['0001', '0004', '0009'].some((f) => local(r, `frames/${f}.png`))).toBe(false)
  })

  it('are judged on the step grid too', async () => {
    const r = await rig({ start: 1, end: 4, step: 3 })
    for (const f of [1, 2, 3, 4]) saved(r, `frames/000${f}.png`)

    await drain(r)

    expect(downloaded(r.jobId)).toEqual([1, 4])
    expect(local(r, 'frames/0002.png') || local(r, 'frames/0003.png')).toBe(false)
  })
})

// A stereo or multiview scene with Views Format 'Individual' saves each view
// of a frame to its own file. Nothing says how many views there are, so a
// frame is marked downloaded only once the chunk's final pass has seen every
// view land: never on its first view, which would read as the whole frame.
describe('frames saved one file per view', () => {
  function stereo(r: Rig, frames: number[]): void {
    for (const f of frames) {
      for (const v of ['_L', '_R']) saved(r, `frames/${String(f).padStart(4, '0')}${v}.png`)
    }
  }

  it('marks a frame downloaded once every view of it has landed', async () => {
    const r = await rig()
    stereo(r, [1, 2, 3, 4])

    const result = await drain(r)

    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
    const jobDir = join(w.settings.projectRoot, 'renders', r.jobId)
    for (const v of ['_L', '_R']) expect(existsSync(join(jobDir, `frames/0004${v}.png`))).toBe(true)
    const row = w.get<{ local_path: string }>(
      'SELECT local_path FROM frames WHERE job_id = ? AND frame = 4',
      r.jobId
    )
    expect(row?.local_path).toBe(join(jobDir, 'frames/0004_L.png'))
    expect(w.alerts('error')).toEqual([])
  })

  it('leaves a frame with a view that never arrived to render again', async () => {
    const r = await rig()
    stereo(r, [1, 2, 3])
    // Blender died between frame 4's two views.
    saved(r, 'frames/0004_L.png')

    await drain(r)

    expect(downloaded(r.jobId)).toEqual([1, 2, 3])
  })

  it('leaves a frame with a lost view to render again', async () => {
    const r = await rig()
    stereo(r, [1, 3, 4])
    saved(r, 'frames/0002_L.png')
    saved(r, 'frames/0002_R.png', { onNode: false })

    const result = await drain(r)

    expect(result.lost).toEqual(['frames/0002_R.png'])
    expect(downloaded(r.jobId)).toEqual([1, 3, 4])
  })

  it('marks nothing when only one view ever arrived', async () => {
    // Blender adds a suffix only with two views or more, so the other one is
    // missing from every frame.
    const r = await rig()
    for (const f of [1, 2, 3, 4]) saved(r, `frames/000${f}_L.png`)

    await drain(r)

    expect(downloaded(r.jobId)).toEqual([])
  })

  it('marks nothing when the final manifest read failed', async () => {
    // The background polls fetched every view listed so far, but whatever the
    // agent listed since is unknown: frame 4 could be one view short.
    const r = await rig()
    stereo(r, [1, 2, 3, 4])
    r.downloader.start()
    await w.until(
      () => existsSync(join(w.settings.projectRoot, 'renders', r.jobId, 'frames', '0004_R.png')),
      'views fetched in the background'
    )
    r.machine.onExec(manifest, () => Promise.reject(new Error('(SSH) Channel open failure')))

    const result = await drain(r)
    r.downloader.stop()

    expect(result.manifestRead).toBe(false)
    expect(downloaded(r.jobId)).toEqual([])
  })

  it('still marks a frame saved as one file, extension or not, as it lands', async () => {
    const r = await rig()
    saved(r, 'frames/0001')
    saved(r, 'frames/0002')
    saved(r, 'frames/0003.exr')
    saved(r, 'frames/0004.exr')

    const result = await drain(r)

    expect(result).toEqual({ manifestRead: true, lost: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })
})
