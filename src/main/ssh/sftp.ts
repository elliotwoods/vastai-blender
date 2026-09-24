/**
 * Promise helpers over ssh2's SFTPWrapper: recursive upload of the remote/
 * tree, hash-skipped big-file uploads, and verified downloads (.part →
 * verify → rename) driven by manifest entries.
 *
 * Every SFTP request goes through withSftp: on the channel current at the
 * time, under a deadline. See there for why.
 */

import { createHash } from 'crypto'
import { createReadStream, promises as fsp } from 'fs'
import { basename, dirname, join, posix, resolve as resolvePath } from 'path'
import type { SFTPWrapper } from 'ssh2'
import {
  asLocalSinkError,
  LocalSinkError,
  pipelinedGet,
  TransferAbortedError,
  TransferStalledError,
  type SftpReader
} from './pipelinedGet'
import { shq } from './shq'
import type { SshConnection } from './sshConnection'

export { LocalSinkError, TransferAbortedError, TransferStalledError } from './pipelinedGet'

/** No bytes for this long and a download is declared stalled (see pipelinedGet). */
export const DOWNLOAD_STALL_MS = 60_000

/** No bytes for this long and an upload is declared stalled: DOWNLOAD_STALL_MS's twin. */
export const UPLOAD_STALL_MS = 60_000

/**
 * No answer to a small SFTP request (a write, an unlink, a rename) for this
 * long and its channel is taken to be wedged.
 */
export const SFTP_OP_TIMEOUT_MS = 30_000

/** Deadline for a small remote command: mkdir -p, rm -f. */
const REMOTE_CMD_TIMEOUT_MS = 60_000

/**
 * Deadline for sha256sum of a file of `bytes` on a node: a minute, plus the
 * file read at a deliberately slow 20 MB/s, so only a hang trips it. A 2 GB
 * scene gets under three minutes.
 */
function hashTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 20_000)
}

/** An SFTP request unanswered (for a transfer: not moving) past its deadline. */
export class SftpTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`SFTP ${label}: no answer for ${Math.round(timeoutMs / 1000)}s`)
  }
}

export interface WithSftpOptions {
  /**
   * No answer for this long (for an op that reports progress: no progress)
   * and the op fails with SftpTimeoutError, and its channel is reset.
   */
  timeoutMs: number
  /** Names the op in errors. */
  label: string
  /**
   * The op may safely run again from the start (a write that overwrites, an
   * unlink). If its channel is closed under it, by another transfer's stall
   * reset or the node's sftp-server, it runs once more on a fresh channel
   * instead of failing a dispatch over someone else's stall (#245).
   */
  retryOnReset?: boolean
}

/**
 * Run one SFTP operation on the connection's current channel, under a
 * deadline.
 *
 * Never hold an SFTPWrapper across an await. Once a channel has been reset
 * (a stalled download anywhere on the node resets it), ssh2 registers every
 * later request made on it and never sends it, so its callback never comes.
 * uploadFileVerified held one wrapper across two execs, and a reset landing
 * during the node-side sha256sum left the rename after it waiting for good,
 * and with it the node's prep lock: every later dispatch to that node queued
 * behind it while the node billed (#244). So each operation fetches the
 * channel right before it runs, and the deadline covers the requests ssh2
 * makes on its own (fastPut's open and close, writeFile's close), which no
 * check beforehand could reach.
 *
 * `op` gets the channel and a `progress()` to call as bytes move; a transfer
 * that calls it is timed by its silences, not its length.
 */
export async function withSftp<T>(
  ssh: SshConnection,
  op: (sftp: SFTPWrapper, progress: () => void) => Promise<T>,
  opts: WithSftpOptions
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    // The open is under the same deadline: on a wedged connection it can go
    // unanswered as surely as any request.
    const sftp = await ssh.sftp({ timeoutMs: opts.timeoutMs })
    let closedUnder = false
    const onClosed = (): void => {
      closedUnder = true
    }
    sftp.on('end', onClosed).on('close', onClosed)
    try {
      return await underDeadline(ssh, sftp, op, opts)
    } catch (e) {
      if (opts.retryOnReset && attempt === 1 && closedUnder && !(e instanceof SftpTimeoutError)) {
        continue
      }
      throw e
    } finally {
      sftp.off('end', onClosed).off('close', onClosed)
    }
  }
}

function underDeadline<T>(
  ssh: SshConnection,
  sftp: SFTPWrapper,
  op: (sftp: SFTPWrapper, progress: () => void) => Promise<T>,
  opts: WithSftpOptions
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let last = Date.now()
    let settled = false
    const check = (): void => {
      if (settled) return
      const idle = Date.now() - last
      if (idle < opts.timeoutMs) {
        timer = setTimeout(check, opts.timeoutMs - idle)
        return
      }
      settled = true
      // Presumed wedged: give it up, so what comes next gets a fresh channel.
      // Only this one, though: the cache may already hold a newer channel.
      ssh.resetSftp(sftp)
      reject(new SftpTimeoutError(opts.label, opts.timeoutMs))
    }
    let timer = setTimeout(check, opts.timeoutMs)
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle()
    }
    let running: Promise<T>
    try {
      running = op(sftp, () => {
        last = Date.now()
      })
    } catch (e) {
      finish(() => reject(e))
      return
    }
    running.then(
      (v) => finish(() => resolve(v)),
      (e: unknown) => finish(() => reject(e))
    )
  })
}

/** ssh2's SFTP status code for "no such file" (err.code; fs errors carry strings). */
const SFTP_NO_SUCH_FILE = 2

/**
 * Is this ssh2's "no such file" from the node? Decided by the numeric SFTP
 * status code, never by the message: a local ENOENT (a project folder on an
 * unplugged drive) says "no such file" too, and was reported as a frame gone
 * from the node, and re-rendered.
 */
export function isRemoteMissing(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === SFTP_NO_SUCH_FILE
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function fastPut(
  sftp: SFTPWrapper,
  local: string,
  remote: string,
  onStep: () => void
): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.fastPut(local, remote, { step: onStep }, (err) => (err ? reject(err) : resolve()))
  )
}

/** One file up, over withSftp: a stall of UPLOAD_STALL_MS fails it; a reset under it retries once. */
function upload(ssh: SshConnection, local: string, remote: string): Promise<void> {
  return withSftp(ssh, (sftp, progress) => fastPut(sftp, local, remote, progress), {
    timeoutMs: UPLOAD_STALL_MS,
    label: `upload ${basename(local)}`,
    retryOnReset: true
  })
}

export function sftpWriteFile(sftp: SFTPWrapper, remote: string, data: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.writeFile(remote, Buffer.from(data, 'utf-8'), (err) => (err ? reject(err) : resolve()))
  )
}

export function sftpReadFile(sftp: SFTPWrapper, remote: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    sftp.readFile(remote, (err, data) => (err ? reject(err) : resolve(data)))
  )
}

/**
 * POSIX-overwrite rename. SFTP v3 RENAME fails with a bare "Failure" when the
 * target exists — which happens routinely on restart recovery (e.g. a chunk's
 * inbox spec re-written while the previous spec file is still there). Unlink
 * the target first (ignoring "no such file") to get mv -f semantics.
 *
 * On a wrapper the caller holds, with no deadline: use renameRemote.
 */
export function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.unlink(to, () =>
      // unlink error (target absent) is expected — rename decides the outcome
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    )
  )
}

/**
 * sftpRename's mv -f over withSftp: each of its two requests on the channel
 * current at the time, each under a deadline. As one chain on one wrapper, a
 * reset landing while the unlink was in flight stranded the rename on the
 * dead channel, never answered.
 */
export async function renameRemote(
  ssh: SshConnection,
  from: string,
  to: string,
  timeoutMs = SFTP_OP_TIMEOUT_MS
): Promise<void> {
  await withSftp(
    ssh,
    (sftp) =>
      new Promise<void>((resolve, reject) =>
        sftp.unlink(to, (err) => (!err || isRemoteMissing(err) ? resolve() : reject(err)))
      ),
    { timeoutMs, label: `unlink ${posix.basename(to)}`, retryOnReset: true }
  )
  await withSftp(
    ssh,
    (sftp) =>
      new Promise<void>((resolve, reject) =>
        sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
      ),
    { timeoutMs, label: `rename ${posix.basename(to)}` }
  )
}

/**
 * Write a small file where a reader may pick it up at any moment (a job spec
 * in the agent's inbox): to `tmpPath`, which the reader ignores, then renamed
 * over `remotePath`. Every request under a deadline (withSftp), so a spec
 * write can fail but never hang a dispatch.
 */
export async function writeRemoteFileAtomic(
  ssh: SshConnection,
  remotePath: string,
  data: string,
  opts: { tmpPath: string; timeoutMs?: number }
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? SFTP_OP_TIMEOUT_MS
  await withSftp(ssh, (sftp) => sftpWriteFile(sftp, opts.tmpPath, data), {
    timeoutMs,
    label: `write ${posix.basename(opts.tmpPath)}`,
    retryOnReset: true
  })
  await renameRemote(ssh, opts.tmpPath, remotePath, timeoutMs)
}

/** mkdir -p via exec (simpler and more reliable than SFTP mkdir recursion). */
export async function remoteMkdirp(ssh: SshConnection, dir: string): Promise<void> {
  const r = await ssh.exec(`mkdir -p ${shq(dir)}`, {
    timeoutMs: REMOTE_CMD_TIMEOUT_MS,
    label: 'mkdir -p'
  })
  if (r.code !== 0) throw new Error(`mkdir failed: ${r.stderr}`)
}

/**
 * Upload a whole local directory tree (the repo's remote/ scripts) to
 * remoteDir. Small files — no skip logic needed.
 */
export async function uploadTree(
  ssh: SshConnection,
  localDir: string,
  remoteDir: string
): Promise<number> {
  let count = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    await remoteMkdirp(ssh, posix.join(remoteDir, rel))
    for (const e of entries) {
      const localPath = join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        await walk(localPath, relPath)
      } else {
        await upload(ssh, localPath, posix.join(remoteDir, relPath))
        count++
      }
    }
  }
  await walk(localDir, '')
  return count
}

/**
 * Upload one large file (blend/extension zip), skipping when the remote copy
 * already matches by sha256 (checked via sha256sum on the node).
 *
 * Runs inside the scheduler's per-node prep lock, so no step may hang: every
 * command has a deadline, and the SFTP steps go through withSftp.
 */
export async function uploadFileVerified(
  ssh: SshConnection,
  localPath: string,
  remotePath: string
): Promise<'uploaded' | 'skipped'> {
  const { size } = await fsp.stat(localPath)
  const hash = await sha256File(localPath)
  const hashing = {
    timeoutMs: hashTimeoutMs(size),
    label: `sha256sum ${posix.basename(remotePath)}`
  }
  const check = await ssh.exec(`sha256sum ${shq(remotePath)} 2>/dev/null | cut -d' ' -f1`, hashing)
  if (check.stdout.trim() === hash) return 'skipped'
  await remoteMkdirp(ssh, posix.dirname(remotePath))
  const part = `${remotePath}.part`
  await upload(ssh, localPath, part)
  const after = await ssh.exec(`sha256sum ${shq(part)} | cut -d' ' -f1`, hashing)
  if (after.stdout.trim() !== hash) {
    await ssh.exec(`rm -f ${shq(part)}`, { timeoutMs: REMOTE_CMD_TIMEOUT_MS, label: 'rm -f' })
    throw new Error(`upload verify failed for ${basename(localPath)}`)
  }
  await renameRemote(ssh, part, remotePath)
  return 'uploaded'
}

/**
 * Keep at least this much free on the disk frames land on. A Mac whose disk
 * filled mid-render took the app down with it (plan 1.21), and a frame
 * squeezed into the last megabytes only moves the failure later.
 */
export const LOCAL_FREE_RESERVE_BYTES = 1024 ** 3

/** A download this big or bigger checks free space first (one statfs). */
const FREE_SPACE_CHECK_MIN_BYTES = 1024 ** 2

/**
 * The temporary file one manifest entry downloads into, named for its
 * content. It was `<file>.part` whatever the content, so a partial left by an
 * earlier render of the same frame name (a requeue to another node, whose
 * bytes differ) was resumed as if it were a prefix of the new file, failed
 * its hash, and cost an attempt and a whole wasted transfer (#240).
 */
export function partPathFor(
  localPath: string,
  expected: { size: number; sha256?: string }
): string {
  const key = expected.sha256 ? expected.sha256.slice(0, 16) : `size${expected.size}`
  return `${localPath}.${key}.part`
}

/** Remove what a download given up on left behind: the job folder is the user's delivery folder. */
export async function discardPartial(
  localPath: string,
  expected: { size: number; sha256?: string }
): Promise<void> {
  await fsp.rm(partPathFor(localPath, expected), { force: true }).catch(() => {})
}

export interface DownloadOptions {
  /** No bytes for this long and the transfer is declared stalled. */
  stallMs?: number
  /**
   * Stop: the download rejects with TransferAbortedError at once, having
   * written nothing more — or, if it is still waiting its turn at this file
   * (see oneWriterAt), without ever starting.
   */
  signal?: AbortSignal
  /** Called with each read's size as it lands. */
  onProgress?: (bytes: number) => void
}

/**
 * Download one manifest-listed file: pipelined SFTP read → .part, verify size
 * + sha256 (size-only for legacy manifest entries without a hash), rename into
 * place. Skips if the local file already exists and verifies (resume after
 * restart).
 *
 * A transfer that receives nothing for `stallMs` fails with
 * TransferStalledError instead of hanging forever (ssh2's fastGet never calls
 * back on a wedged channel), and the SFTP channel it used is reset so the
 * retry gets a fresh one. A partial `.part` is kept and the next attempt at
 * the same content resumes from it.
 *
 * Every local step that fails because the disk cannot take the file (full,
 * read-only, not ours, the drive gone) rejects with LocalSinkError, never as
 * if the node or the network had failed. So does a download that would leave
 * less than LOCAL_FREE_RESERVE_BYTES free, before a byte is fetched. A file
 * the node no longer has rejects with ssh2's own error: see isRemoteMissing.
 */
export function downloadFileVerified(
  ssh: SshConnection,
  remotePath: string,
  localPath: string,
  expected: { size: number; sha256?: string },
  opts: DownloadOptions = {}
): Promise<'downloaded' | 'skipped'> {
  return oneWriterAt(localPath, remotePath, opts.signal, () =>
    fetchVerified(ssh, remotePath, localPath, expected, opts)
  )
}

/** Local writers per destination: see oneWriterAt. */
const writers = new Map<string, Promise<void>>()

/**
 * One download per local file at a time; a later one waits for the earlier to
 * finish, and then usually finds the file already in place. Two downloaders
 * on one frame (a transfer still running for a run that was stopped, as the
 * requeued chunk's starts on it) wrote the same .part at once, and each one's
 * rename or rm deleted or corrupted the other's file (#243).
 *
 * Waiting is abortable; the download itself stops through its own signal.
 */
function oneWriterAt<T>(
  localPath: string,
  remotePath: string,
  signal: AbortSignal | undefined,
  fetch: () => Promise<T>
): Promise<T> {
  const key = resolvePath(localPath)
  const prev = writers.get(key) ?? Promise.resolve()
  let started = false
  const turn = prev.then(() => {
    if (signal?.aborted) throw new TransferAbortedError(remotePath)
    started = true
    return fetch()
  })
  const done = turn.then(
    () => {},
    () => {}
  )
  writers.set(key, done)
  void done.then(() => {
    if (writers.get(key) === done) writers.delete(key)
  })
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      if (!started) reject(new TransferAbortedError(remotePath))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    turn.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
  })
}

/** A local fs step: its sink failures (see asLocalSinkError) as LocalSinkError. */
function local<T>(step: Promise<T>, alsoCodes?: readonly string[]): Promise<T> {
  return step.catch((e: unknown) => {
    throw asLocalSinkError(e, alsoCodes)
  })
}

/** Fail with LocalSinkError, before fetching anything, when `bytes` would eat into the reserve. */
async function ensureRoom(dir: string, bytes: number): Promise<void> {
  if (bytes < FREE_SPACE_CHECK_MIN_BYTES) return
  let free: number
  try {
    const st = await fsp.statfs(dir)
    free = Number(st.bavail) * Number(st.bsize)
  } catch {
    return // a filesystem statfs cannot read is no reason to stop
  }
  if (free - bytes >= LOCAL_FREE_RESERVE_BYTES) return
  const mb = (n: number): string => `${Math.floor(n / 1024 ** 2)} MB`
  throw new LocalSinkError(
    'ENOSPC',
    `not enough free space in ${dir}: ${mb(free)} free, ${mb(bytes)} to download, and ${mb(LOCAL_FREE_RESERVE_BYTES)} kept free`,
    dir,
    bytes
  )
}

/** Resolves with the channel, or rejects as soon as `signal` fires. */
function unlessAborted<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  remotePath: string
): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new TransferAbortedError(remotePath))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function fetchVerified(
  ssh: SshConnection,
  remotePath: string,
  localPath: string,
  expected: { size: number; sha256?: string },
  opts: DownloadOptions
): Promise<'downloaded' | 'skipped'> {
  const { signal } = opts
  try {
    const st = await fsp.stat(localPath)
    if (
      st.size === expected.size &&
      (!expected.sha256 || (await sha256File(localPath)) === expected.sha256)
    ) {
      return 'skipped'
    }
  } catch {
    // not present — download
  }
  const dir = dirname(localPath)
  // ENOENT here is the project folder's drive gone (Windows, Linux; macOS
  // says EACCES): the local disk, not the node.
  await local(fsp.mkdir(dir, { recursive: true }), ['ENOENT', 'ENOTDIR'])
  const part = partPathFor(localPath, expected)
  // Resume from a previous attempt's prefix of this same content. A .part at
  // or past the expected size cannot be one (it is corrupt) — start over.
  let start = 0
  try {
    const prev = await fsp.stat(part)
    if (prev.size < expected.size) start = prev.size
    else await fsp.rm(part, { force: true })
  } catch {
    // no partial — start from zero
  }
  await ensureRoom(dir, expected.size - start)
  const stallMs = opts.stallMs ?? DOWNLOAD_STALL_MS
  // The channel open is inside the stall budget too: sftp() on a wedged
  // connection can hang as surely as a read can.
  const sftp = await unlessAborted(ssh.sftp({ timeoutMs: stallMs }), signal, remotePath)
  try {
    await pipelinedGet(sftp as unknown as SftpReader, remotePath, part, {
      size: expected.size,
      start,
      stallMs,
      signal,
      onProgress: opts.onProgress
    })
  } catch (e) {
    // This transfer's channel, and only it: by now the cache may hold a
    // fresh one that another transfer opened after an earlier reset (#245).
    if (e instanceof TransferStalledError) ssh.resetSftp(sftp)
    throw e
  }
  const st = await local(fsp.stat(part))
  if (st.size !== expected.size) {
    await fsp.rm(part, { force: true })
    throw new Error(`size mismatch downloading ${remotePath}: ${st.size} != ${expected.size}`)
  }
  if (expected.sha256) {
    const hash = await local(sha256File(part))
    if (hash !== expected.sha256) {
      await fsp.rm(part, { force: true })
      throw new Error(`hash mismatch downloading ${remotePath}`)
    }
  }
  await local(fsp.rename(part, localPath))
  return 'downloaded'
}
