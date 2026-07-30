import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'

const frame = { kind: 'frame', file: 'frames/0042.exr', size: 100, sha256: 'a', mtime: 1 }
const thumb = {
  kind: 'thumb',
  file: 'thumbs/0042.jpg',
  size: 10,
  sha256: 'b',
  mtime: 2,
  meta: { frame: 42, width: 320 }
}
const live = {
  kind: 'clip',
  file: 'previews/c_live_0040.mp4',
  size: 20,
  sha256: 'c',
  mtime: 3,
  meta: {
    kindKey: 'live',
    file: 'previews/c_live_0040.mp4',
    fps: 25,
    frames: 40,
    width: 960,
    height: 540,
    codec: 'hevc',
    hdr: true
  }
}

const lines = (...objs: unknown[]): string => objs.map((o) => JSON.stringify(o)).join('\n')

describe('parseManifest', () => {
  it('accepts frames, thumbs and clips', () => {
    const out = parseManifest(lines(frame, thumb, live))
    expect(out.map((e) => e.kind)).toEqual(['frame', 'thumb', 'clip'])
  })

  it('tolerates a torn tail line', () => {
    // The agent appends while we read, so the last line is routinely a
    // fragment. It must not discard the complete lines before it.
    const text = lines(frame, thumb) + '\n' + '{"kind":"clip","fi'
    const out = parseManifest(text)
    expect(out).toHaveLength(2)
  })

  it('ignores blank lines and unknown kinds', () => {
    const text = lines(frame) + '\n\n' + lines({ kind: 'mystery', file: 'x', size: 1 })
    expect(parseManifest(text)).toHaveLength(1)
  })

  it('rejects entries with no file or zero size', () => {
    const text = lines({ ...frame, file: '' }, { ...frame, size: 0 })
    expect(parseManifest(text)).toHaveLength(0)
  })

  it('keeps live clips distinguishable from definitive ones', () => {
    // The downloader's supersede filter and its class-priority ordering both
    // key on meta.kindKey, so it has to survive parsing intact.
    const out = parseManifest(lines(live))
    expect(out[0].kind).toBe('clip')
    expect(out[0].kind === 'clip' && out[0].meta.kindKey).toBe('live')
  })

  it('carries the frame number on a thumb', () => {
    // frames.thumb_path is keyed by frame, so losing this would orphan it.
    const out = parseManifest(lines(thumb))
    expect(out[0].kind === 'thumb' && out[0].meta.frame).toBe(42)
  })
})
