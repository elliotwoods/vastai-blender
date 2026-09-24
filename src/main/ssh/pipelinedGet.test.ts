import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { pipelinedGet, TransferStalledError, type SftpReader } from './pipelinedGet'

/** A remote file served by a fake SFTP channel, with knobs for misbehaviour. */
function fakeSftp(
  data: Buffer,
  opts: {
    /** stop answering reads once this many bytes have been served */
    stallAfter?: number
    /** serve at most this many bytes per read (exercises short reads) */
    maxPerRead?: number
    /** never answer the open */
    hangOpen?: boolean
  } = {}
): SftpReader & { reads: number } {
  let served = 0
  const self = {
    reads: 0,
    open(_path: string, _flags: string, cb: (e: Error | null, h: Buffer) => void) {
      if (opts.hangOpen) return
      setImmediate(() => cb(null, Buffer.from('h')))
    },
    read(
      _h: Buffer,
      buf: Buffer,
      off: number,
      len: number,
      pos: number,
      cb: (e: Error | null, n: number) => void
    ) {
      self.reads++
      if (opts.stallAfter != null && served >= opts.stallAfter) return // wedged: never calls back
      const n = Math.max(0, Math.min(len, opts.maxPerRead ?? len, data.length - pos))
      if (n > 0) data.copy(buf, off, pos, pos + n)
      served += n
      setImmediate(() => cb(null, n))
    },
    close(_h: Buffer, cb: (e?: Error | null) => void) {
      setImmediate(() => cb(null))
    }
  }
  return self
}

const payload = (n: number): Buffer => {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 3) & 0xff
  return b
}

const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'pget-')), 'file.part')

describe('pipelinedGet', () => {
  it('downloads a file in pipelined chunks', async () => {
    const data = payload(100_000)
    const part = tmp()
    await pipelinedGet(fakeSftp(data), '/r/f', part, {
      size: data.length,
      stallMs: 1_000,
      chunkSize: 4096,
      concurrency: 8
    })
    expect(readFileSync(part).equals(data)).toBe(true)
  })

  it('handles short reads by re-requesting the remainder', async () => {
    const data = payload(50_000)
    const part = tmp()
    await pipelinedGet(fakeSftp(data, { maxPerRead: 1000 }), '/r/f', part, {
      size: data.length,
      stallMs: 1_000,
      chunkSize: 4096,
      concurrency: 4
    })
    expect(readFileSync(part).equals(data)).toBe(true)
  })

  it('fails a stalled transfer instead of hanging, keeping a resumable prefix', async () => {
    const data = payload(200_000)
    const part = tmp()
    const err = await pipelinedGet(fakeSftp(data, { stallAfter: 60_000 }), '/r/f', part, {
      size: data.length,
      stallMs: 150,
      checkEveryMs: 20,
      chunkSize: 4096,
      concurrency: 4
    }).catch((e) => e)
    expect(err).toBeInstanceOf(TransferStalledError)
    // Whatever was kept is a true prefix of the remote file — no holes.
    const kept = readFileSync(part)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(data.length)
    expect(kept.equals(data.subarray(0, kept.length))).toBe(true)

    // Resume from the prefix on a healthy channel and finish the file.
    await pipelinedGet(fakeSftp(data), '/r/f', part, {
      size: data.length,
      start: statSync(part).size,
      stallMs: 1_000,
      chunkSize: 4096
    })
    expect(readFileSync(part).equals(data)).toBe(true)
  })

  it('resume only fetches the missing tail', async () => {
    const data = payload(40_000)
    const part = tmp()
    writeFileSync(part, data.subarray(0, 32_768))
    const sftp = fakeSftp(data)
    await pipelinedGet(sftp, '/r/f', part, {
      size: data.length,
      start: 32_768,
      stallMs: 1_000,
      chunkSize: 4096
    })
    expect(readFileSync(part).equals(data)).toBe(true)
    expect(sftp.reads).toBe(2) // 7232 bytes = one full 4096 chunk + one tail
  })

  it('times out an open that never answers', async () => {
    const part = tmp()
    const err = await pipelinedGet(fakeSftp(payload(10), { hangOpen: true }), '/r/f', part, {
      size: 10,
      stallMs: 100,
      checkEveryMs: 20
    }).catch((e) => e)
    expect(err).toBeInstanceOf(TransferStalledError)
  })

  it('fails on a remote file shorter than the manifest says', async () => {
    const part = tmp()
    const err = await pipelinedGet(fakeSftp(payload(1000)), '/r/f', part, {
      size: 5000,
      stallMs: 1_000,
      chunkSize: 4096
    }).catch((e) => e)
    expect(String(err)).toMatch(/unexpected EOF/)
  })
})
