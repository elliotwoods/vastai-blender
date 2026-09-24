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
 *   there instead of from zero.
 *
 * The SFTP surface is a small interface so the stall/resume logic can be
 * unit-tested against a fake.
 */

import { promises as fsp } from 'fs'

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
}

/**
 * Fetch `remote` into `localPart`, from `start` to `size`. Resolves when every
 * byte is written; rejects on error or stall with the local file truncated to
 * its contiguous prefix (so the caller can resume from its size).
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
  const fh = await fsp.open(localPart, start > 0 ? 'r+' : 'w')

  // Ranges not yet on disk: queued, or requested and awaiting a reply.
  const outstanding = new Map<number, number>() // position → length
  const queue: Array<[number, number]> = []
  for (let p = start; p < size; p += chunkSize) queue.push([p, Math.min(chunkSize, size - p)])
  const writes = new Set<Promise<unknown>>()
  let received = start
  let lastProgress = now()
  let handle: Buffer | null = null
  let dead = false

  const lowestIncomplete = (): number => {
    let low = size
    for (const [p] of queue) low = Math.min(low, p)
    for (const p of outstanding.keys()) low = Math.min(low, p)
    return low
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error): void => {
        if (dead) return
        dead = true
        clearInterval(watchdog)
        reject(e)
      }
      const watchdog = setInterval(
        () => {
          const idle = now() - lastProgress
          if (idle > opts.stallMs) fail(new TransferStalledError(remote, idle, received))
        },
        opts.checkEveryMs ?? Math.max(50, Math.min(opts.stallMs / 4, 5_000))
      )

      const finishIfDone = (): void => {
        if (dead || queue.length > 0 || outstanding.size > 0) return
        dead = true
        clearInterval(watchdog)
        resolve()
      }

      const issue = (): void => {
        while (!dead && handle && outstanding.size < concurrency && queue.length > 0) {
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
            // Short read: the rest of this range goes back on the queue.
            if (n < len) queue.unshift([pos + n, len - n])
            const w = fh.write(buf, 0, n, pos).then(
              () => {
                writes.delete(w)
                outstanding.delete(pos)
                issue()
                finishIfDone()
              },
              (e: Error) => {
                writes.delete(w)
                fail(e)
              }
            )
            writes.add(w)
          })
        }
      }

      if (queue.length === 0) {
        dead = true
        clearInterval(watchdog)
        resolve()
        return
      }
      sftp.open(remote, 'r', (err, h) => {
        if (dead) {
          if (!err && h) sftp.close(h, () => {})
          return
        }
        if (err) return fail(err)
        handle = h
        lastProgress = now()
        issue()
      })
    })
  } catch (e) {
    // Keep only what is contiguous from the start, so a resume never skips a
    // hole left by a read that was still outstanding when this gave up.
    await Promise.allSettled([...writes])
    const keep = lowestIncomplete()
    await fh.truncate(keep).catch(() => {})
    await fh.close().catch(() => {})
    // Best-effort: on a wedged channel this callback may never come.
    if (handle) sftp.close(handle, () => {})
    throw e
  }
  await Promise.allSettled([...writes])
  await fh.close()
  if (handle) sftp.close(handle, () => {})
}
