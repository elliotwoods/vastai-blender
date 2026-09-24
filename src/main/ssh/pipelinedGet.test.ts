import { existsSync, mkdtempSync, promises as fsp, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asLocalSinkError,
  LocalSinkError,
  pipelinedGet,
  TransferAbortedError,
  TransferStalledError,
  type SftpReader
} from './pipelinedGet'

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
    /** fail the open with this (ssh2's shape: a numeric SFTP status code) */
    openError?: Error
  } = {}
): SftpReader & { reads: number; opens: number; closes: number } {
  let served = 0
  const self = {
    reads: 0,
    opens: 0,
    closes: 0,
    open(_path: string, _flags: string, cb: (e: Error | null, h: Buffer) => void) {
      self.opens++
      if (opts.hangOpen) return
      const err = opts.openError
      setImmediate(() => (err ? cb(err, Buffer.alloc(0)) : cb(null, Buffer.from('h'))))
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
      self.closes++
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

  it('reports every byte as it lands, from the resume point on (1.10 #242)', async () => {
    const data = payload(40_000)
    const part = tmp()
    writeFileSync(part, data.subarray(0, 8_192))
    const landed: number[] = []
    await pipelinedGet(fakeSftp(data, { maxPerRead: 3000 }), '/r/f', part, {
      size: data.length,
      start: 8_192,
      stallMs: 1_000,
      chunkSize: 4096,
      onProgress: (n) => landed.push(n)
    })
    expect(landed.reduce((a, b) => a + b, 0)).toBe(data.length - 8_192)
    expect(Math.max(...landed)).toBeLessThanOrEqual(3000)
  })

  it('stops at once when aborted, keeping a resumable prefix (1.10 #243)', async () => {
    // A drain that gave up on the node, or a cancel: its writers must not go
    // on landing bytes in a .part the next attempt now owns.
    const data = payload(200_000)
    const part = tmp()
    const sftp = fakeSftp(data, { stallAfter: 60_000 })
    const ctl = new AbortController()
    let landed = 0
    const got = pipelinedGet(sftp, '/r/f', part, {
      size: data.length,
      stallMs: 60_000,
      chunkSize: 4096,
      concurrency: 4,
      signal: ctl.signal,
      onProgress: (n) => (landed += n)
    }).catch((e: unknown) => e)
    await vi.waitFor(() => expect(landed).toBeGreaterThanOrEqual(60_000))
    ctl.abort()
    const err = await got
    expect(err).toBeInstanceOf(TransferAbortedError)
    const kept = readFileSync(part)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.equals(data.subarray(0, kept.length))).toBe(true)
    // Its remote handle is closed too.
    expect(sftp.closes).toBe(1)
  })

  it('does nothing at all when already aborted', async () => {
    const part = tmp()
    const sftp = fakeSftp(payload(10))
    const ctl = new AbortController()
    ctl.abort()
    const err = await pipelinedGet(sftp, '/r/f', part, {
      size: 10,
      stallMs: 1_000,
      signal: ctl.signal
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransferAbortedError)
    expect(sftp.opens).toBe(0)
    expect(existsSync(part)).toBe(false)
  })

  it('leaves no .part behind for a file already gone from the node (1.10 #240)', async () => {
    const part = tmp()
    const gone = Object.assign(new Error('No such file'), { code: 2 })
    const err = await pipelinedGet(fakeSftp(payload(10), { openError: gone }), '/r/f', part, {
      size: 10,
      stallMs: 1_000
    }).catch((e: unknown) => e)
    expect(err).toBe(gone)
    // The job folder is the user's delivery folder: no empty litter in it.
    expect(existsSync(part)).toBe(false)
  })

  it('still creates an empty file for an empty remote file', async () => {
    const part = tmp()
    const sftp = fakeSftp(Buffer.alloc(0))
    await pipelinedGet(sftp, '/r/f', part, { size: 0, stallMs: 1_000 })
    expect(statSync(part).size).toBe(0)
    expect(sftp.opens).toBe(0)
  })
})

describe('local disk failures (1.10 B6)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Every file opened from now on refuses writes with `code`, as a full disk does. */
  function refuseWrites(code: string): void {
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await open(...args)
      fh.write = (() =>
        Promise.reject(
          Object.assign(new Error(`${code}: refused, write`), { code, syscall: 'write' })
        )) as typeof fh.write
      return fh
    })
  }

  it('a full disk fails the transfer as LocalSinkError, not as the node', async () => {
    refuseWrites('ENOSPC')
    const part = tmp()
    const err = await pipelinedGet(fakeSftp(payload(50_000)), '/r/f', part, {
      size: 50_000,
      stallMs: 1_000,
      chunkSize: 4096
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LocalSinkError)
    expect((err as LocalSinkError).code).toBe('ENOSPC')
  })

  it('a folder it may not write fails as LocalSinkError at the open', async () => {
    vi.spyOn(fsp, 'open').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied, open'), {
        code: 'EACCES',
        syscall: 'open',
        path: '/Volumes/Gone/f.part'
      })
    )
    const err = await pipelinedGet(fakeSftp(payload(10)), '/r/f', tmp(), {
      size: 10,
      stallMs: 1_000
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LocalSinkError)
    expect(err).toMatchObject({ code: 'EACCES', path: '/Volumes/Gone/f.part' })
  })

  it('asLocalSinkError: fs sink codes only; SFTP status codes are numbers and pass through', () => {
    const fsErr = (code: string): Error => Object.assign(new Error(code), { code })
    for (const code of ['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EIO']) {
      expect(asLocalSinkError(fsErr(code))).toBeInstanceOf(LocalSinkError)
    }
    const sftpGone = Object.assign(new Error('No such file'), { code: 2 })
    expect(asLocalSinkError(sftpGone)).toBe(sftpGone)
    const enoent = fsErr('ENOENT')
    expect(asLocalSinkError(enoent)).toBe(enoent)
    expect(asLocalSinkError(enoent, ['ENOENT'])).toBeInstanceOf(LocalSinkError)
    const plain = new Error('No response from server')
    expect(asLocalSinkError(plain)).toBe(plain)
  })
})
