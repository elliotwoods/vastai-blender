import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  writeFileSync,
  type StatsFs
} from 'fs'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import type { SshConnection } from '../ssh/sshConnection'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { HANG, setup, type FakeMachine, type World } from '../test/harness'
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
  conn: SshConnection
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
  return { jobId, chunkId, machine, conn, downloader }
}

/** drain() to completion on the fake clock. */
async function drain(r: Rig): Promise<DrainResult> {
  let out: DrainResult | null = null
  void r.downloader.drain().then((d) => (out = d))
  await w.until(() => out !== null, 'drain returns')
  return out!
}

/** The .part files under the rig's job folder: a download's leftovers. */
function partsIn(r: Rig): string[] {
  const dir = join(w.settings.projectRoot, 'renders', r.jobId)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf-8' }).filter((f) => f.endsWith('.part'))
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
function saved(r: Rig, file: string, opts: { onNode?: boolean; size?: number } = {}): void {
  const dir = `${REMOTE_ROOT}/renders/${r.chunkId}`
  let data = Buffer.from(`fake render ${r.chunkId} ${file}\n`, 'utf-8')
  if (opts.size) {
    data = Buffer.alloc(opts.size)
    for (let i = 0; i < opts.size; i++) data[i] = (i * 13 + file.length) & 0xff
  }
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
    expect(result).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
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

    expect(result).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
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

describe('what a failed download says (1.20)', () => {
  it('1.20 1d59516c: a transfer that fails with no message still names its code', async () => {
    const r = await rig()
    saved(r, 'frames/0001.png')
    // A socket reset under the channel: ssh2 passes the system error on, and
    // it may have no message at all.
    r.machine.onSftp('open', Object.assign(new Error(''), { code: 'ECONNRESET' }), 1)
    const out = await drain(r)

    expect(out).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
    const failed = w.alerts('warn').filter((a) => a.startsWith('download failed'))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatch(/attempt 1\/\d+\): .*ECONNRESET/)
    expect(w.alerts().filter((a) => /:\s*$/.test(a))).toEqual([])
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

    expect(result).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
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

  it('of a legacy job with a fractional step, are judged on the grid the node renders (1.9 review)', async () => {
    // A job from before submissions were validated: frame_step 2.5. The
    // agent renders int() of the spec's numbers, so Blender saved 1, 3 and 5,
    // each paid for. Judged on 2.5, 3 and 5 were refused and never fetched.
    const r = await rig({ start: 1, end: 5.5, step: 2.5 })
    for (const f of ['0001', '0002', '0003', '0005', '0007']) saved(r, `frames/${f}.png`)

    const result = await drain(r)

    expect(result.lost).toEqual([])
    for (const f of ['0001', '0003', '0005']) expect(local(r, `frames/${f}.png`)).toBe(true)
    // Off the node's own grid, or past its end: still not this chunk's.
    expect(local(r, 'frames/0002.png') || local(r, 'frames/0007.png')).toBe(false)
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

    expect(result).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
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

  it('1.12 (Phase 0 review): with three views, one lost from every frame is still a view, and no frame is marked without it', async () => {
    // A multiview scene: left, centre and right, one file each. Every centre
    // view is listed, and none of them can be fetched.
    const r = await rig()
    for (const f of [1, 2, 3, 4]) {
      const stem = `frames/000${f}`
      saved(r, `${stem}_L.png`)
      saved(r, `${stem}_C.png`, { onNode: false })
      saved(r, `${stem}_R.png`)
    }

    const result = await drain(r)

    expect(result.lost).toEqual([1, 2, 3, 4].map((f) => `frames/000${f}_C.png`))
    // Taken from what landed, the views were left and right, and every frame
    // had both: all four were marked downloaded, and none rendered again.
    expect(downloaded(r.jobId)).toEqual([])
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

    expect(result).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })
})

describe('unlinkLater', () => {
  it("deletes only inside the project's renders folder", async () => {
    // Its paths come from assets rows, built from node-supplied names, and a
    // row written before those were checked can point anywhere.
    await w.boot({ start: false })
    const { unlinkLater } = await import('./frameDownloader')
    const root = w.settings.projectRoot
    const inside = join(root, 'renders', 'job', 'previews', 'a.mp4')
    const outside = [
      join(w.dir, 'Library', 'LaunchAgents', 'x.plist'),
      // Shares the prefix, not the folder.
      join(root, 'renders-old', 'b.mp4'),
      join(root, 'settings.json')
    ]
    for (const p of [inside, ...outside]) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'x')
    }

    unlinkLater([inside, ...outside, join(root, 'renders', '..', 'settings.json')], 0)
    await w.until(() => !existsSync(inside), 'the file inside deleted')
    await w.advance(1_000)

    for (const p of outside) expect(existsSync(p)).toBe(true)
  })
})

/** Every frame 1-4 of the chunk saved on the node and listed, at `size` bytes each. */
function savedAll(r: Rig, size?: number): void {
  for (const f of [1, 2, 3, 4]) saved(r, `frames/000${f}.exr`, { size })
}

/**
 * A thin link: reads are answered one at a time, `perReadMs` apart, in the
 * order asked. Every transfer keeps moving, just slowly.
 */
function thinLink(conn: SshConnection, perReadMs: number): void {
  const open = conn.sftp.bind(conn)
  let linkFree = 0
  conn.sftp = (async (opts?: { timeoutMs?: number }) => {
    const sftp = await open(opts)
    return new Proxy(sftp, {
      get(target, key) {
        if (key === 'read') {
          return (...args: Parameters<SFTPWrapper['read']>) => {
            const cb = args[5]
            const at = Math.max(Date.now(), linkFree) + perReadMs
            linkFree = at
            target.read(args[0], args[1], args[2], args[3], args[4], (err, n, buf, pos) => {
              setTimeout(() => cb(err, n, buf, pos), at - Date.now())
            })
          }
        }
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      }
    })
  }) as typeof conn.sftp
}

describe('the final pass on a slow or dead link (1.10 #242, #243)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../ssh/sftp')
  })

  it('1.10 #242: a slow pass that keeps moving is not cut off (the 10-minute budget re-rendered delivered frames)', async () => {
    const r = await rig()
    // 4 × ~1 MB over a link that lands one 32 KB read every 6 s: about 13
    // minutes. No transfer stalls; the old absolute budget cut it at 10. One
    // transfer at a time: this first-come link would otherwise make the
    // third wait out the first two's reads, longer than a stall.
    w.settings.concurrentTransfersPerNode = 1
    savedAll(r, 1_000_000)
    thinLink(r.conn, 6_000)
    const started = Date.now()

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => out !== null, 'drain returns', { timeoutMs: 30 * 60_000, stepMs: 2_000 })

    expect(out).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
    expect(Date.now() - started).toBeGreaterThan(10 * 60_000)
    expect(w.alerts().filter((a) => /download failed|abandoned|giving up/.test(a))).toEqual([])
  })

  it('a pass that lands nothing is given up on within minutes, its frames lost', async () => {
    const { DRAIN_IDLE_MS } = await import('./frameDownloader')
    const r = await rig()
    savedAll(r, 100_000)
    r.machine.onSftp('read', HANG)
    const started = Date.now()

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => out !== null, 'drain returns', { timeoutMs: 30 * 60_000 })

    expect(out!.lost.sort()).toEqual([1, 2, 3, 4].map((f) => `frames/000${f}.exr`))
    expect(Date.now() - started).toBeLessThanOrEqual(DRAIN_IDLE_MS + 30_000)
    expect(downloaded(r.jobId)).toEqual([])
  })

  /**
   * downloadFileVerified replaced: each call waits until the test settles it
   * or its signal aborts, as a transfer with no watchdog of its own would.
   * `ignoreAbort`: an abort does not end it either, as a local step hung on a
   * network share would not end.
   */
  function heldDownloads(opts: { ignoreAbort?: boolean } = {}): Array<{
    file: string
    aborted: boolean
    settled: boolean
    finish: () => void
  }> {
    const calls: ReturnType<typeof heldDownloads> = []
    const { ignoreAbort = false } = opts
    vi.doMock('../ssh/sftp', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../ssh/sftp')>()),
      downloadFileVerified: (
        _ssh: unknown,
        remotePath: string,
        _local: string,
        _expected: unknown,
        opts: { signal?: AbortSignal } = {}
      ): Promise<'downloaded'> =>
        new Promise((resolve, reject) => {
          const call = {
            file: remotePath.split('/').slice(-2).join('/'),
            aborted: false,
            settled: false,
            finish: () => {
              call.settled = true
              resolve('downloaded')
            }
          }
          calls.push(call)
          opts.signal?.addEventListener('abort', () => {
            call.aborted = true
            if (ignoreAbort) return
            // Winding down takes a moment (truncate, close): not synchronous.
            queueMicrotask(() => {
              call.settled = true
              reject(new Error('transfer aborted'))
            })
          })
        })
    }))
    return calls
  }

  it('1.10 #243: when the pass gives up, it stops its transfers and waits for them', async () => {
    // A transfer abandoned by the old timeout went on writing into a .part the
    // requeued chunk's download then shared, and marked its frame downloaded
    // while the frame was being re-rendered.
    const calls = heldDownloads()
    const r = await rig()
    savedAll(r)

    let out: DrainResult | null = null
    let settledAtReturn: boolean[] = []
    void r.downloader.drain().then((d) => {
      settledAtReturn = calls.map((c) => c.settled)
      out = d
    })
    await w.until(() => out !== null, 'drain returns', { timeoutMs: 30 * 60_000 })

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.aborted)).toBe(true)
    expect(settledAtReturn.every(Boolean)).toBe(true)
    expect(out!.lost).toHaveLength(4)
  })

  it('1.10 #243: a transfer that finishes after its run was stopped writes no rows', async () => {
    const calls = heldDownloads()
    const r = await rig()
    savedAll(r)
    r.downloader.start()
    await w.until(() => calls.length > 0, 'transfers under way')

    // A cancel, or its node gone: the chunk is no longer this run's.
    r.downloader.stop()
    for (const c of calls) c.finish()
    await w.advance(5_000)

    expect(downloaded(r.jobId)).toEqual([])
    expect(w.eventsOf('asset:added')).toEqual([])
  })

  it('a transfer that will not wind down holds the pass a minute at most, not for good', async () => {
    // A hash or rename on a project folder on a hung network share: the abort
    // cannot reach it, and waiting on it held the node, billing, for as long.
    const calls = heldDownloads({ ignoreAbort: true })
    const r = await rig()
    const { DRAIN_IDLE_MS } = await import('./frameDownloader')
    savedAll(r)
    const started = Date.now()

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => out !== null, 'drain returns', { timeoutMs: 30 * 60_000 })

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.aborted && !c.settled)).toBe(true)
    expect(out!.lost).toHaveLength(4)
    expect(Date.now() - started).toBeLessThanOrEqual(DRAIN_IDLE_MS + 2 * 60_000)
  })

  it('a Mac that slept through the pass does not give up on waking (the idle clock ran on through the sleep)', async () => {
    const calls = heldDownloads()
    const r = await rig()
    savedAll(r)
    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => calls.length > 0, 'transfers under way')

    // Asleep for five minutes: no timer runs, then the clock has jumped.
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await w.advance(30_000)
    expect(out).toBeNull()
    expect(calls.some((c) => c.aborted)).toBe(false)

    // Awake, the transfers deliver.
    await w.until(() => {
      for (const c of calls) if (!c.settled) c.finish()
      return out !== null
    }, 'drain returns')
    expect(out!.lost).toEqual([])
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })

  it('1.10 #240: a run stopped part-way leaves no partial in the delivery folder', async () => {
    // Named for their content, a stopped run's partials are never resumed by
    // the re-render's frames (other bytes) and were never removed.
    const r = await rig()
    savedAll(r, 200_000)
    let reads = 0
    r.machine.onSftp('read', () => (++reads > 6 ? HANG : undefined))
    r.downloader.start()
    await w.until(() => partsIn(r).length > 0 && reads > 6, 'transfers under way')

    r.downloader.stop()
    await w.until(() => partsIn(r).length === 0, 'partials removed')
    expect(downloaded(r.jobId)).toEqual([])
  })
})

describe('a local disk that will not take the frames (1.10 B6)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const enospc = (): Error =>
    Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
      syscall: 'write'
    })

  /**
   * Every file opened while `full` refuses writes, as a full disk does; statfs
   * reports plenty (the full disk is the writes' to show), so the only thing
   * a recovery can go by is a write that lands.
   */
  function fullDisk(): { full: boolean } {
    const disk = { full: true }
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await open(...args)
      if (disk.full) fh.write = (() => Promise.reject(enospc())) as typeof fh.write
      return fh
    })
    vi.spyOn(fsp, 'statfs').mockResolvedValue({
      bavail: 100 * 1024 ** 2,
      bsize: 1024
    } as unknown as StatsFs)
    return disk
  }

  it('1.10 B6 (field: the Mac disk filled mid-render): frames wait on the node, charged nothing, and land once space returns', async () => {
    const { localSinkHold } = await import('./frameDownloader')
    const disk = fullDisk()
    const r = await rig()
    savedAll(r)

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => localSinkHold() !== null, 'downloads paused')
    expect(localSinkHold()!.reason).toMatch(/ENOSPC/)
    // Well past four attempts' worth of retries: none was charged, none lost.
    await w.advance(10 * 60_000)
    expect(out).toBeNull()
    expect(
      w.alerts().filter((a) => /download failed|giving up|gone from the node/.test(a))
    ).toEqual([])
    expect(w.alerts('error').filter((a) => /Cannot save downloaded frames/.test(a))).toHaveLength(1)

    disk.full = false
    await w.until(() => out !== null, 'drain returns')

    expect(out).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
    expect(localSinkHold()).toBeNull()
    expect(w.alerts('info').filter((a) => /taking files again/.test(a))).toHaveLength(1)
  })

  it('the hold is bounded: the node is let go, its frames reported blocked, not lost', async () => {
    const { localSinkHold, SINK_HOLD_MS } = await import('./frameDownloader')
    fullDisk()
    const r = await rig()
    savedAll(r)
    const started = Date.now()

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => out !== null, 'drain returns', { timeoutMs: SINK_HOLD_MS + 5 * 60_000 })

    expect(Date.now() - started).toBeGreaterThan(SINK_HOLD_MS)
    expect(out!.lost).toEqual([])
    expect(out!.localSinkBlocked.sort()).toEqual([1, 2, 3, 4].map((f) => `frames/000${f}.exr`))
    // Still unhealthy: whatever is dispatched next would only wait too.
    expect(localSinkHold()).not.toBeNull()
    expect(w.alerts('error').some((a) => /node is let go/.test(a))).toBe(true)
  })

  it("a project folder on a drive that is gone is not 'gone from the node'", async () => {
    const { localSinkHold } = await import('./frameDownloader')
    vi.spyOn(fsp, 'mkdir').mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory, mkdir 'E:\\\\renders'"), {
        code: 'ENOENT',
        syscall: 'mkdir'
      })
    )
    const r = await rig()
    savedAll(r)
    void r.downloader.drain()
    await w.until(() => localSinkHold() !== null, 'downloads paused')
    await w.advance(2 * 60_000)

    expect(w.alerts().filter((a) => /gone from the node/.test(a))).toEqual([])
    r.downloader.stop()
  })

  it('recheckLocalSink: a user who has freed space need not wait for the next probe', async () => {
    const { localSinkHold, recheckLocalSink } = await import('./frameDownloader')
    const disk = fullDisk()
    const r = await rig()
    savedAll(r)
    void r.downloader.drain()
    await w.until(() => localSinkHold() !== null, 'downloads paused')

    expect(await recheckLocalSink()).toBe(false)
    disk.full = false
    expect(await recheckLocalSink()).toBe(true)
    expect(localSinkHold()).toBeNull()
    await w.until(() => downloaded(r.jobId).length === 4, 'frames land')
  })

  /** statfs reports plenty: these scenarios must not hang on the test machine's own free space. */
  function plentyOfRoom(): void {
    vi.spyOn(fsp, 'statfs').mockResolvedValue({
      bavail: 100 * 1024 ** 2,
      bsize: 1024
    } as unknown as StatsFs)
  }

  it("1.10 B6 review: one frame file the disk will not replace is that file's failure, and the pass ends", async () => {
    // A frame another program holds (Windows antivirus, a viewer), or one the
    // user may not overwrite, refuses its rename while the folder takes every
    // other file. Taken as the disk's trouble, it paused every download, the
    // probe of the folder passed 30 s later, the refetch failed again, and a
    // new hold began: a drain that never returned while its node billed.
    const { localSinkHold, SINK_HOLD_MS } = await import('./frameDownloader')
    plentyOfRoom()
    const rename = fsp.rename.bind(fsp)
    let refused = 0
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(join('frames', '0004.exr'))) {
        refused++
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`),
          { code: 'EPERM', syscall: 'rename', path: String(from), dest: String(to) }
        )
      }
      return rename(from, to)
    })
    const r = await rig()
    savedAll(r)
    const started = Date.now()

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => out !== null, 'drain returns', { timeoutMs: SINK_HOLD_MS + 5 * 60_000 })

    // Its four attempts and their backoffs, not a hold.
    expect(Date.now() - started).toBeLessThan(2 * 60_000)
    expect(out).toEqual({ manifestRead: true, lost: ['frames/0004.exr'], localSinkBlocked: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3])
    expect(refused).toBe(4)
    expect(localSinkHold()).toBeNull()
    expect(w.alerts('error').filter((a) => /Cannot save downloaded frames/.test(a))).toEqual([])
    expect(
      w
        .alerts('warn')
        .some((a) =>
          /giving up on frames\/0004\.exr after 4 attempts: the project folder would not take it: EPERM/.test(
            a
          )
        )
    ).toBe(true)
    await w.until(() => partsIn(r).length === 0, 'its partial removed')
  })

  it('a frames folder that refuses writes, in a job folder that takes them, holds the pause without flapping', async () => {
    // The probe used to try the job folder, which took its write every time:
    // every 30 s the pause cleared, the downloads it woke failed again, and a
    // new pause began, with an alert each way.
    const { localSinkHold } = await import('./frameDownloader')
    plentyOfRoom()
    const r = await rig()
    const framesDir = join(w.settings.projectRoot, 'renders', r.jobId, 'frames')
    const lock = { on: true }
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const path = String(args[0])
      if (lock.on && dirname(path) === framesDir) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
          code: 'EACCES',
          syscall: 'open',
          path
        })
      }
      return open(...args)
    })
    savedAll(r)

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    await w.until(() => localSinkHold() !== null, 'downloads paused')
    await w.advance(5 * 60_000)

    expect(w.alerts('info').filter((a) => /taking files again/.test(a))).toEqual([])
    expect(w.alerts('error').filter((a) => /Cannot save downloaded frames/.test(a))).toHaveLength(1)
    expect(w.alerts().filter((a) => /download failed|giving up/.test(a))).toEqual([])

    lock.on = false
    await w.until(() => out !== null, 'drain returns')
    expect(out).toEqual({ manifestRead: true, lost: [], localSinkBlocked: [] })
    expect(downloaded(r.jobId)).toEqual([1, 2, 3, 4])
  })

  it('1.10 B6 review: a disk that clears for a moment and refuses again does not restart the hold', async () => {
    // Space freed and taken again by something else, over and over: each
    // probe's write lands, and the frames it wakes are refused straight
    // after. Every clear restarted the 20-minute hold, so it never ran out.
    const { SINK_HOLD_MS } = await import('./frameDownloader')
    plentyOfRoom()
    const disk = { probesToPass: 0 }
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await open(...args)
      const probe = basename(String(args[0])).startsWith('.vastai-render-write-check')
      if (probe ? disk.probesToPass-- <= 0 : true) {
        fh.write = (() => Promise.reject(enospc())) as typeof fh.write
      }
      return fh
    })
    const r = await rig()
    savedAll(r)
    // Each refetch takes a second or two before its first write fails, so
    // the drain sees the disk clear.
    thinLink(r.conn, 1_000)
    const started = Date.now()

    let out: DrainResult | null = null
    void r.downloader.drain().then((d) => (out = d))
    let nextClear = Date.now() + 60_000
    await w.until(
      () => {
        if (Date.now() >= nextClear) {
          disk.probesToPass = 1
          nextClear += 60_000
        }
        return out !== null
      },
      'drain returns',
      { timeoutMs: SINK_HOLD_MS + 10 * 60_000 }
    )

    expect(w.alerts('info').filter((a) => /taking files again/.test(a)).length).toBeGreaterThan(10)
    expect(Date.now() - started).toBeLessThanOrEqual(SINK_HOLD_MS + 2 * 60_000)
    expect(out!.lost).toEqual([])
    expect(out!.localSinkBlocked.sort()).toEqual([1, 2, 3, 4].map((f) => `frames/000${f}.exr`))
  })

  it('a run stopped before its final pass is not woken when the disk recovers', async () => {
    // drain() on a run already stopped put it back among the downloaders to
    // wake, where it stayed for the life of the app.
    const disk = fullDisk()
    const r = await rig()
    r.downloader.stop()
    await drain(r)
    const wake = vi.spyOn(r.downloader, 'wake')

    // Another run on the same chunk meets the full disk, and the disk recovers.
    const { ChunkDownloader, localSinkHold } = await import('./frameDownloader')
    const other = new ChunkDownloader({
      jobId: r.jobId,
      chunkId: r.chunkId,
      nodeId: 'node-under-test',
      ssh: r.conn,
      remoteChunkDir: `${REMOTE_ROOT}/renders/${r.chunkId}`,
      frames: { start: 1, end: 4, step: 1 }
    })
    savedAll(r)
    let out: DrainResult | null = null
    void other.drain().then((d) => (out = d))
    await w.until(() => localSinkHold() !== null, 'downloads paused')
    disk.full = false
    await w.until(() => out !== null, 'the other run drains')

    expect(w.alerts('info').filter((a) => /taking files again/.test(a))).toHaveLength(1)
    expect(wake).not.toHaveBeenCalled()
  })

  it('1.10 B6: a chunk whose frames the disk would not take is not rendered again once it does', async () => {
    // The whole path, through the scheduler. The frames used to burn four
    // attempts, count as lost, fail the chunk and re-render it on a paid GPU.
    const disk = fullDisk()
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const specs: string[] = []
    machine.onSpec = (spec) => {
      specs.push(spec.chunkId)
      machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    const { localSinkHold } = await import('./frameDownloader')
    await w.until(() => localSinkHold() !== null, 'downloads paused')
    await w.advance(5 * 60_000)

    disk.full = false
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete'
    )

    expect(specs).toHaveLength(1)
    expect(
      w.get<{ retries: number }>('SELECT retries FROM chunks WHERE job_id = ?', jobId)?.retries
    ).toBe(0)
    expect(downloaded(jobId)).toEqual([1, 2, 3, 4])
  })
})
