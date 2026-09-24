/**
 * SFTP download with a stall watchdog and resume.
 *
 * ssh2's `fastGet` pipelines reads well but has neither: when the channel (or
 * the TCP connection under it) wedges mid-file, its callback simply never
 * fires. That was observed in a real fleet run — four frames stopped at
 * ~200 KB, their chunks sat in 'downloading' forever, and because a chunk
 * still downloading keeps its node busy, three nodes stayed rented and billing
 * with nothing to do.
 *
 * This is the same pipelined scheme (many READ requests in flight, positional
 * writes into a local `.part` file), plus:
 *
 * - a watchdog that fails the transfer with `TransferStalledError` when no
 *   bytes have arrived for `stallMs`, however the stall happens (open, read,
 *   a dead connection that never errors);
 * - resume: on any failure the `.part` file is truncated to the longest fully
 *   written prefix, and a later call with `start` = that size continues from
 *   there instead of from zero;
 * - `onProgress`, so a caller can tell a slow transfer from a dead one;
 * - `signal`, so a caller that has given up stops the transfer's writes
 *   instead of leaving them to land in a file someone else now owns;
 * - local disk failures (full, read-only, not ours to write) come out as
 *   `LocalSinkError`, never mistaken for a problem with the node.
 *
 * The SFTP surface is a small interface so the stall/resume logic can be
 * unit-tested against a fake.
 */

import { promises as fsp } from 'fs'
import type { FileHandle } from 'fs/promises'

export class TransferStalledError extends Error {
  constructor(
    readonly remotePath: string,
    readonly stalledMs: number,
    readonly bytes: number
  ) {
    super(
      `transfer stalled: no data for ${Math.round(stalledMs / 1000)}s at ${bytes} bytes (${remotePath})`
    )
  }
}

/** The caller's AbortSignal fired: the transfer stopped, keeping its prefix. */
export class TransferAbortedError extends Error {
  constructor(readonly remotePath: string) {
    super(`transfer aborted (${remotePath})`)
  }
}

/**
 * The local disk would not take the file: full, over quota, read-only, not
 * ours to write, or failing. Not the node's fault, nor the network's: the file
 * is still on the node, and fetching it again fails the same way until the
 * disk is fixed. So it must not count against the transfer's retries, and the
 * file must not be taken as lost, which re-renders it on a paid GPU (B6).
 */
export class LocalSinkError extends Error {
  constructor(
    /** The fs error code: ENOSPC, EACCES... */
    readonly code: string,
    message: string,
    /** The local path the failing step was writing. */
    readonly path?: string
  ) {
    super(message)
  }
}

/**
 * fs error codes that mean the local disk cannot take a file, whichever step
 * hit them. EPERM is macOS refusing an app a protected folder; EIO a failing
 * or unplugged drive.
 */
const SINK_CODES: ReadonlySet<string> = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EACCES',
  'EPERM',
  'EIO'
])

/**
 * A local fs error with one of the SINK_CODES (or `alsoCodes`) as a
 * LocalSinkError; anything else unchanged. Only for errors from local steps:
 * the codes are fs's strings, where ssh2's SFTP status codes are numbers.
 */
export function asLocalSinkError(e: unknown, alsoCodes: readonly string[] = []): unknown {
  if (e instanceof LocalSinkError) return e
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return e
  if (!SINK_CODES.has(code) && !alsoCodes.includes(code)) return e
  const path = (e as { path?: unknown }).path
  return new LocalSinkError(code, (e as Error).message, typeof path === 'string' ? path : undefined)
}

type Cb<T> = (err: Error | null | undefined, v: T) => void

/** The subset of ssh2's SFTPWrapper this needs. */
export interface SftpReader {
  open(path: string, flags: string, cb: Cb<Buffer>): void
  read(
    handle: Buffer,
    buf: Buffer,
    off: number,
    len: number,
    position: number,
    cb: (err: Error | null | undefined, bytesRead: number) => void
  ): void
  close(handle: Buffer, cb: (err?: Error | null) => void): void
}

export interface PipelinedGetOptions {
  /** expected total size (from the manifest) */
  size: number
  /** resume offset: bytes already in the local file */
  start?: number
  /** no bytes for this long = stalled */
  stallMs: number
  concurrency?: number
  chunkSize?: number
  /** watchdog tick; defaults to min(stallMs / 4, 5s) */
  checkEveryMs?: number
  now?: () => number
  /** Called with the size of each read as it arrives: bytes that just landed. */
  onProgress?: (bytes: number) => void
  /** Stop the transfer: it fails with TransferAbortedError, keeping its prefix. */
  signal?: AbortSignal
}

/**
 * Fetch `remote` into `localPart`, from `start` to `size`. Resolves when every
 * byte is written; rejects on error, stall or abort with the local file
 * truncated to its contiguous prefix (so the caller can resume from its size).
 */
export async function pipelinedGet(
  sftp: SftpReader,
  remote: string,
  localPart: string,
  opts: PipelinedGetOptions
): Promise<void> {
  const size = opts.size
  const start = Math.max(0, Math.min(opts.start ?? 0, size))
  const concurrency = Math.max(1, opts.concurrency ?? 64)
  const chunkSize = Math.max(1, opts.chunkSize ?? 32_768)
  const now = opts.now ?? Date.now
  const { signal } = opts
  if (signal?.aborted) throw new TransferAbortedError(remote)

  // Ranges not yet on disk: queued, or requested and awaiting a reply.
  const outstanding = new Map<number, number>() // position → length
  const queue: Array<[number, number]> = []
  for (let p = start; p < size; p += chunkSize) queue.push([p, Math.min(chunkSize, size - p)])
  const writes = new Set<Promise<unknown>>()
  let received = start
  let lastProgress = now()
  let handle: Buffer | null = null
  let fh: FileHandle | null = null
  let dead = false
  /** Set while the transfer runs: fails it (the abort listener's way in). */
  let failNow: ((e: Error) => void) | null = null
  const onAbort = (): void => failNow?.(new TransferAbortedError(remote))
  signal?.addEventListener('abort', onAbort, { once: true })

  const lowestIncomplete = (): number => {
    let low = size
    for (const [p] of queue) low = Math.min(low, p)
    for (const p of outstanding.keys()) low = Math.min(low, p)
    return low
  }

  // Opened (or reopened, to resume) only once the remote file has: a file
  // already gone from the node used to leave an empty .part behind in the
  // job folder, which is the user's delivery folder.
  const openLocal = (): Promise<FileHandle> =>
    fsp.open(localPart, start > 0 ? 'r+' : 'w').catch((e: unknown) => {
      throw asLocalSinkError(e)
    })

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error): void => {
        if (dead) return
        dead = true
        clearInterval(watchdog)
        reject(e)
      }
      failNow = fail
      const watchdog = setInterval(
        () => {
          const idle = now() - lastProgress
          if (idle > opts.stallMs) fail(new TransferStalledError(remote, idle, received))
        },
        opts.checkEveryMs ?? Math.max(50, Math.min(opts.stallMs / 4, 5_000))
      )
      /** The local file opened: keep it, unless the transfer ended meanwhile. */
      const adopt = (f: FileHandle): boolean => {
        if (dead) {
          void f.close().catch(() => {})
          return false
        }
        fh = f
        return true
      }

      const finishIfDone = (): void => {
        if (dead || queue.length > 0 || outstanding.size > 0) return
        dead = true
        clearInterval(watchdog)
        resolve()
      }

      const issue = (): void => {
        const out = fh
        while (!dead && handle && out && outstanding.size < concurrency && queue.length > 0) {
          const [pos, len] = queue.shift()!
          outstanding.set(pos, len)
          const buf = Buffer.allocUnsafe(len)
          sftp.read(handle, buf, 0, len, pos, (err, n) => {
            if (dead) return
            if (err) return fail(err)
            if (!n || n <= 0) {
              return fail(new Error(`unexpected EOF at ${pos} of ${size} (${remote})`))
            }
            lastProgress = now()
            received += n
            opts.onProgress?.(n)
            // Short read: the rest of this range goes back on the queue.
            if (n < len) queue.unshift([pos + n, len - n])
            const w = out.write(buf, 0, n, pos).then(
              () => {
                writes.delete(w)
                outstanding.delete(pos)
                issue()
                finishIfDone()
              },
              (e: unknown) => {
                writes.delete(w)
                fail(asLocalSinkError(e) as Error)
              }
            )
            writes.add(w)
          })
        }
      }

      if (queue.length === 0) {
        // Nothing to fetch (an empty file, or a resume that already has every
        // byte): only the local file has to exist.
        openLocal().then((f) => {
          if (adopt(f)) finishIfDone()
        }, fail)
        return
      }
      sftp.open(remote, 'r', (err, h) => {
        if (dead) {
          if (!err && h) sftp.close(h, () => {})
          return
        }
        if (err) return fail(err)
        handle = h
        openLocal().then((f) => {
          if (!adopt(f)) return
          lastProgress = now()
          issue()
        }, fail)
      })
    })
  } catch (e) {
    // Keep only what is contiguous from the start, so a resume never skips a
    // hole left by a read that was still outstanding when this gave up.
    await Promise.allSettled([...writes])
    const out = fh as FileHandle | null
    if (out) {
      await out.truncate(lowestIncomplete()).catch(() => {})
      await out.close().catch(() => {})
    }
    // Best-effort: on a wedged channel this callback may never come.
    if (handle) sftp.close(handle, () => {})
    throw e
  } finally {
    failNow = null
    signal?.removeEventListener('abort', onAbort)
  }
  await Promise.allSettled([...writes])
  if (handle) sftp.close(handle, () => {})
  // A deferred write error (a network drive, a full disk that took the
  // writes into cache) can surface only here.
  await (fh as FileHandle | null)?.close().catch((e: unknown) => {
    throw asLocalSinkError(e)
  })
}
