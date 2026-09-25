import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_ROOT, type FakeMachine } from '../test/fakeSsh'
import { setup, type World } from '../test/harness'
import { parseFrameName, parseManifest, type ParsedManifest } from './manifest'

const HASH = 'a'.repeat(64)

/** The chunk whose manifest the parser is reading. */
const CHUNK = '0b1c2d3e-1-40'

const frame = { kind: 'frame', file: 'frames/0042.exr', size: 100, sha256: HASH, mtime: 1 }
const thumb = {
  kind: 'thumb',
  file: 'thumbs/0042.jpg',
  size: 10,
  sha256: 'b'.repeat(64),
  mtime: 2,
  meta: { frame: 42, width: 320 }
}
// Named the way the agent names them (noderunner.py _maybe_emit, encode_preview.py).
const live = {
  kind: 'clip',
  file: 'previews/0b1c2d3e-1-40_live_1700000000_0040.mp4',
  size: 20,
  sha256: 'c'.repeat(64),
  mtime: 3,
  meta: {
    kindKey: 'live',
    file: 'previews/0b1c2d3e-1-40_live_1700000000_0040.mp4',
    fps: 25,
    frames: 40,
    width: 960,
    height: 540,
    codec: 'hevc',
    hdr: true
  }
}
const sdr = {
  ...live,
  file: 'previews/0b1c2d3e-1-40_sdr.mp4',
  meta: {
    ...live.meta,
    kindKey: 'previewSdr',
    file: 'previews/0b1c2d3e-1-40_sdr.mp4',
    fps: 23.976,
    codec: 'av1',
    hdr: false
  }
}

const lines = (...objs: unknown[]): string => objs.map((o) => JSON.stringify(o)).join('\n')

/** Parse one line; expect it refused, and return why. */
function refused(obj: unknown): ParsedManifest['rejected'][number] {
  const out = parseManifest(lines(obj), CHUNK)
  expect(out.entries).toEqual([])
  expect(out.rejected).toHaveLength(1)
  return out.rejected[0]
}

describe('parseManifest', () => {
  it('accepts frames, thumbs and clips as the agent writes them', () => {
    const out = parseManifest(lines(frame, thumb, live, sdr), CHUNK)
    expect(out.entries.map((e) => e.kind)).toEqual(['frame', 'thumb', 'clip', 'clip'])
    expect(out.entries).toEqual([frame, thumb, live, sdr])
    expect(out.rejected).toEqual([])
  })

  it('tolerates a torn tail line', () => {
    // The agent appends while we read, so the last line is routinely a
    // fragment. It must not discard the complete lines before it, nor count
    // as a refusal: it will be whole on the next poll.
    const text = lines(frame, thumb) + '\n' + '{"kind":"clip","fi'
    const out = parseManifest(text, CHUNK)
    expect(out.entries).toHaveLength(2)
    expect(out.rejected).toEqual([])
  })

  it('skips blank lines, non-objects and unknown kinds without refusing them', () => {
    const text =
      lines(frame) + '\n\n' + lines({ kind: 'mystery', file: '../x', size: 1 }, null, 42, [frame])
    expect(parseManifest(text, CHUNK)).toEqual({ entries: [frame], rejected: [] })
  })

  it('refuses entries with no file or a bad size', () => {
    expect(refused({ ...frame, file: '' }).reason).toMatch(/file name/)
    expect(refused({ ...frame, file: 7 }).file).toBe('<number>')
    for (const size of [0, -1, 1.5, '100', null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(refused({ ...frame, size }).reason).toBe('bad size')
    }
  })

  it('carries only the validated fields', () => {
    const out = parseManifest(lines({ ...frame, extra: 'x', meta: { a: 1 } }), CHUNK)
    expect(out.entries).toEqual([frame])
  })

  it('keeps live clips distinguishable from definitive ones', () => {
    // The downloader's supersede filter and its class-priority ordering both
    // key on meta.kindKey, so it has to survive parsing intact.
    const out = parseManifest(lines(live), CHUNK).entries
    expect(out[0].kind).toBe('clip')
    expect(out[0].kind === 'clip' && out[0].meta.kindKey).toBe('live')
  })

  it('carries the frame number on a thumb', () => {
    // frames.thumb_path is keyed by frame, so losing this would orphan it.
    const out = parseManifest(lines(thumb), CHUNK).entries
    expect(out[0].kind === 'thumb' && out[0].meta.frame).toBe(42)
  })

  // Everything Blender prints "Saved:" for under `-o frames/####`, which the
  // agent lists as-is. Refusing any of these made every chunk of such a scene
  // fail and re-render in full, retry after retry: GPU hours for nothing.
  it.each([
    // Stereo or multiview, Views Format 'Individual': one file per view.
    ['frames/0042_L.png'],
    ['frames/0042_R.png'],
    ['frames/0042_R.exr'],
    ['frames/0042_cam-2.png'],
    ['frames/0042L.png'],
    // File Extensions off.
    ['frames/0042'],
    ['frames/0042_L'],
    // Past frame 9999, `####` just grows.
    ['frames/1048574.exr']
  ])('accepts a frame Blender saved as %j', (file) => {
    expect(parseManifest(lines({ ...frame, file }), CHUNK)).toEqual({
      entries: [{ ...frame, file }],
      rejected: []
    })
  })

  it("accepts a view's thumbnail, which the agent cannot number", () => {
    // PreviewWorker names it after the frame's stem, and int('0042_L') fails.
    const t = { ...thumb, file: 'thumbs/0042_L.jpg', meta: { frame: null, width: 320 } }
    expect(parseManifest(lines(t), CHUNK).entries).toEqual([t])
    expect(refused({ ...t, meta: { frame: 7, width: 320 } }).reason).toMatch(/meta.frame/)
  })

  it('reads the frame number and view off a frame or thumb name', () => {
    expect(parseFrameName('frames/0042.exr')).toEqual({ frame: 42, view: '' })
    expect(parseFrameName('frames/0042')).toEqual({ frame: 42, view: '' })
    expect(parseFrameName('frames/0042_L.png')).toEqual({ frame: 42, view: '_L' })
    expect(parseFrameName('frames/0000_R')).toEqual({ frame: 0, view: '_R' })
    expect(parseFrameName('thumbs/0042_R.jpg')).toEqual({ frame: 42, view: '_R' })
    // The old reading took the digits before the extension, whatever came first.
    expect(parseFrameName('frames/0042_L2.png')).toEqual({ frame: 42, view: '_L2' })
    for (const file of ['frames/-001.exr', 'frames/x0042.exr', 'previews/0042.mp4', '0042.exr']) {
      expect(parseFrameName(file)).toBeNull()
    }
  })

  // What a hostile node (or a .blend's startup script) would write to plant a
  // file on the desktop: every one of these used to be downloaded to
  // join(jobDir, file), and the node supplies the size and sha256 it is
  // checked against.
  describe('refuses a file that could land outside the job folder', () => {
    it.each([
      ['../../../../Library/LaunchAgents/x.plist'],
      ['frames/../../../../Library/LaunchAgents/0001.plist'],
      ['frames/../0001.exr'],
      ['/Users/u/Library/LaunchAgents/0001.plist'],
      ['//server/share/0001.exr'],
      ['C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat'],
      ['C:/x/0001.exr'],
      [
        '..\\..\\..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat'
      ],
      ['frames\\0001.exr'],
      ['frames/0001.exr\nfile /etc/passwd'],
      ['frames/0001.exr\u0000.plist'],
      // Shapes the agent never writes, even if harmless.
      ['frames/0001.exr:stream'],
      ['frames/-001.exr'],
      ['frames/.0001.exr'],
      ['frames/0001.exr.part'],
      ['frames/0001_L/0001.exr'],
      ['frames/0001_L R.png'],
      [`frames/0001_${'L'.repeat(64)}.png`],
      ['passes/0001.exr'],
      ['frames/sub/0001.exr']
    ])('%j', (file) => {
      const r = refused({ ...frame, file })
      expect(r.kind).toBe('frame')
      expect(r.reason).toBe('not a file name the agent writes')
    })

    it('for thumbs and clips too', () => {
      expect(refused({ ...thumb, file: '../thumbs/0042.jpg' }).kind).toBe('thumb')
      expect(refused({ ...thumb, file: 'thumbs/0042.png' }).kind).toBe('thumb')
      expect(refused({ ...thumb, file: 'thumbs/0042_L/x.jpg' }).kind).toBe('thumb')
      for (const file of [
        'previews/../../x.mp4',
        'previews/.hidden.mp4',
        'previews/a b.mp4',
        'previews/x.mp4.exe',
        'previews\\x.mp4',
        '/tmp/x.mp4'
      ]) {
        expect(refused({ ...live, file, meta: { ...live.meta, file } }).kind).toBe('clip')
      }
    })
  })

  it('makes the refused name safe to show in an alert', () => {
    // Quoted, control characters escaped, bidi overrides escaped, truncated.
    expect(refused({ ...frame, file: '../x\n.plist' }).file).toBe('"../x\\n.plist"')
    expect(refused({ ...frame, file: 'frames/\u202egnp.0001' }).file).toBe(
      '"frames/\\u202egnp.0001"'
    )
    expect(refused({ ...frame, file: `../${'a'.repeat(200)}` }).file).toHaveLength(85)
  })

  it('requires a sha256 on every kind', () => {
    // Without one, the size is the only check on the bytes.
    for (const e of [frame, thumb, live]) {
      const { sha256: _omit, ...noHash } = e
      void _omit
      expect(refused(noHash).reason).toBe('missing or malformed sha256')
      for (const sha256 of ['a', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), 42]) {
        expect(refused({ ...e, sha256 }).reason).toBe('missing or malformed sha256')
      }
    }
  })

  it('caps the declared size', () => {
    expect(parseManifest(lines({ ...frame, size: 8 * 1024 ** 3 }), CHUNK).entries).toHaveLength(1)
    expect(refused({ ...frame, size: 8 * 1024 ** 3 + 1 }).reason).toMatch(/size cap/)
    expect(refused({ ...thumb, size: 65 * 1024 ** 2 }).reason).toMatch(/size cap/)
  })

  it('refuses a clip whose meta is not what the agent writes', () => {
    const clip = (meta: Record<string, unknown>): unknown => ({
      ...live,
      meta: { ...live.meta, ...meta }
    })
    // kindKey becomes assets.kind, which the UI and the stitcher switch on.
    expect(refused(clip({ kindKey: 'thumb' })).reason).toBe('unknown meta.kindKey')
    expect(refused(clip({ kindKey: 'toString' })).reason).toBe('unknown meta.kindKey')
    expect(refused(clip({ file: 'previews/other.mp4' })).reason).toBe(
      'meta.file does not match file'
    )
    for (const bad of [{ fps: '25' }, { frames: null }, { width: -1 }, { height: '1080' }]) {
      expect(refused(clip(bad)).reason).toBe('bad clip dimensions')
    }
    expect(refused(clip({ codec: 'h264' })).reason).toBe('unknown meta.codec')
    expect(refused(clip({ hdr: 1 })).reason).toBe('bad meta.hdr')
    expect(refused({ ...live, meta: undefined }).reason).toBe('missing meta')
  })

  it("accepts only this chunk's clips, named for what they are", () => {
    const clip = (file: string, kindKey: string): unknown => ({
      ...live,
      file,
      meta: { ...live.meta, file, kindKey }
    })
    const ok = (file: string, kindKey: string, chunkId = CHUNK): void => {
      expect(parseManifest(lines(clip(file, kindKey)), chunkId).rejected).toEqual([])
    }
    const no = (file: string, kindKey: string, chunkId = CHUNK): void => {
      const out = parseManifest(lines(clip(file, kindKey)), chunkId)
      expect(out.entries).toEqual([])
      expect(out.rejected[0].reason).toBe(`not the name of this chunk's ${kindKey} clip`)
    }
    ok('previews/0b1c2d3e-1-40_sdr.mp4', 'previewSdr')
    ok('previews/0b1c2d3e-1-40_hdr.mp4', 'previewHdr')
    ok('previews/0b1c2d3e-1-40_proxy.mp4', 'proxy')
    ok('previews/0b1c2d3e-1-40_live_1700000000_0040.mp4', 'live')
    ok('previews/0b1c2d3e-41-80-r1_proxy.mp4', 'proxy', '0b1c2d3e-41-80-r1')

    // Another chunk's clip: downloading it would overwrite that chunk's file
    // and take over its assets row. So would one that only starts the same.
    no('previews/0b1c2d3e-41-80-r1_sdr.mp4', 'previewSdr')
    no('previews/0b1c2d3e-1-40_sdr.mp4', 'previewSdr', '0b1c2d3e-1-4')
    // The stitched job clip (jobClipPlan's nextVersionName). As 'live', the
    // next prune of superseded live clips would have deleted it.
    no('previews/job_previewSdr.v1.mp4', 'live')
    no('previews/job_previewSdr.v1.mp4', 'previewSdr')
    // Named for another rendition than it claims to be.
    no('previews/0b1c2d3e-1-40_sdr.mp4', 'proxy')
    no('previews/0b1c2d3e-1-40_live_1700000000_0040.mp4', 'previewSdr')
    no('previews/0b1c2d3e-1-40_sdr.mp4', 'live')
    no('previews/0b1c2d3e-1-40_live_x_0040.mp4', 'live')
    no('previews/0b1c2d3e-1-40_live_1700000000_40.mp4', 'live')
    no('previews/0b1c2d3e-1-40_sdr.v2.mp4', 'previewSdr')
  })

  it('refuses a thumb that names some other frame', () => {
    expect(refused({ ...thumb, meta: { frame: 7, width: 320 } }).reason).toMatch(/meta.frame/)
    expect(refused({ ...thumb, meta: { width: 320 } }).reason).toMatch(/meta.frame/)
    expect(refused({ ...thumb, meta: { frame: 42, width: 'x' } }).reason).toBe('bad meta.width')
    expect(
      parseManifest(lines({ ...thumb, meta: { frame: null, width: 320 } }), CHUNK).entries
    ).toHaveLength(1)
  })

  it('keeps the good lines around a bad one', () => {
    const out = parseManifest(lines(frame, { ...frame, file: '../../x/0001.exr' }, thumb), CHUNK)
    expect(out.entries).toEqual([frame, thumb])
    expect(out.rejected).toEqual([
      { kind: 'frame', file: '"../../x/0001.exr"', reason: 'not a file name the agent writes' }
    ])
  })
})

// End to end, on the lifecycle harness: the real scheduler and downloader
// against a fake node whose manifest lists frame 3 under a path that climbs
// out of the job folder, with a size and sha256 that verify.
describe('the downloader, given a manifest line that escapes the job folder', () => {
  let w: World
  beforeEach(async () => {
    w = await setup({ settings: { maxActiveNodes: 1 } })
  })
  afterEach(() => {
    vi.doUnmock('./manifest')
    return w.dispose()
  })

  // Three levels up from <projectRoot>/renders/<jobId> is the harness's own
  // temp dir, so even a regression's write stays inside the sandbox.
  const HOSTILE = '../../../escaped/0003.png'

  function sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex')
  }

  /**
   * First attempt: frames 1, 2 and 4 as the agent writes them, and frame 3 as
   * the hostile line. The retry is an honest render of what is still missing.
   */
  function hostileFirstAttempt(machine: FakeMachine): void {
    machine.onSpec = (spec) => {
      machine.onSpec = (retry) => machine.agent.finish(retry.chunkId)
      const dir = `${REMOTE_ROOT}/renders/${spec.chunkId}`
      const data = Buffer.from('#!/bin/sh\necho planted\n')
      machine.files.set(`${dir}/${HOSTILE}`, data)
      const line = {
        kind: 'frame',
        file: HOSTILE,
        size: data.length,
        sha256: sha256(data),
        mtime: 1
      }
      machine.files.set(`${dir}/manifest.jsonl`, Buffer.from(JSON.stringify(line) + '\n'))
      machine.agent.finish(spec.chunkId, { frames: [1, 2, 4] })
    }
  }

  async function runJob(): Promise<{ jobId: string; jobDir: string }> {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const jobId = await w.submitJob(app, { frameStart: 1, frameEnd: 4, chunkSize: 4 })
    const jobDir = join(w.settings.projectRoot, 'renders', jobId)
    expect(resolve(jobDir, HOSTILE)).toBe(join(w.dir, 'escaped', '0003.png'))
    hostileFirstAttempt(w.machineFor(nodeId))
    app.scheduler.kick()
    await w.until(
      () => w.get('SELECT state FROM jobs WHERE id = ?', jobId)?.state === 'complete',
      'job complete'
    )
    return { jobId, jobDir }
  }

  function expectContained(jobId: string, jobDir: string): void {
    expect(existsSync(join(w.dir, 'escaped'))).toBe(false)
    // Frame 3 counted as lost, so the chunk went back through requeue and
    // only frame 3 re-rendered: complete means every frame, from inside the
    // job folder. A frame the node listed and could not be fetched is the
    // node's failure, not the render's (1.17): charged to the machines.
    const frames = w.all<{ frame: number; state: string; local_path: string }>(
      'SELECT frame, state, local_path FROM frames WHERE job_id = ? ORDER BY frame',
      jobId
    )
    expect(frames.map((f) => [f.frame, f.state])).toEqual([
      [1, 'downloaded'],
      [2, 'downloaded'],
      [3, 'downloaded'],
      [4, 'downloaded']
    ])
    for (const f of frames) expect(f.local_path.startsWith(jobDir + sep)).toBe(true)
    expect(w.get('SELECT retries, infra_retries FROM chunks WHERE job_id = ?', jobId)).toEqual({
      retries: 0,
      infra_retries: 1
    })
    // Polled every 5 s, and read again by the retry, yet reported once.
    const refusals = w.alerts('error').filter((m) => m.includes('refused'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('escaped/0003.png')
  }

  it('is refused by parseManifest: nothing lands outside, the frame re-renders, one alert', async () => {
    const { jobId, jobDir } = await runJob()
    expectContained(jobId, jobDir)
  })

  it('is refused by the download itself, should the parser ever let it through', async () => {
    // The parser the downloader used to have: anything with a known kind.
    // The rest of the module is the real one.
    vi.doMock('./manifest', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./manifest')>()),
      parseManifest: (text: string): ParsedManifest => ({
        entries: text
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as ParsedManifest['entries'][number]),
        rejected: []
      })
    }))
    const { jobId, jobDir } = await runJob()
    expectContained(jobId, jobDir)
  })
})
