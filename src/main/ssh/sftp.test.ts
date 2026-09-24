import { createHash } from 'crypto'
import { existsSync, promises as fsp, readFileSync, type StatsFs } from 'fs'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { HANG, setup, type FakeMachine, type World } from '../test/harness'
import type { SshConnection } from './sshConnection'

// sftp.ts against the harness's fake node, whose SFTP channel behaves as
// ssh2's does: a request made on a channel after it was reset is never
// answered (see fakeSsh.ts). Plan 1.10 / 1.8: no SFTP step may hang, because
// the scheduler's per-node prep lock is only released when they return.

let w: World
beforeEach(async () => {
  w = await setup()
})
afterEach(() => w.dispose())

type Sftp = typeof import('./sftp')

/** Settle a promise's outcome without awaiting it, so fake time can run meanwhile. */
function watch<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const r: { done: boolean; value?: T; error?: unknown } = { done: false }
  p.then(
    (v) => Object.assign(r, { done: true, value: v }),
    (e: unknown) => Object.assign(r, { done: true, error: e })
  )
  return r
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** A fake node and a connection to it, as the app makes one (the mocked SshConnection). */
async function node(): Promise<{ machine: FakeMachine; conn: SshConnection; sftp: Sftp }> {
  const inst = w.vast.addInstance()
  const machine = w.vast.machine(inst.id)
  const [ep] = machine.endpoints
  const { SshConnection } = await import('./sshConnection')
  const conn = new SshConnection({
    host: ep.host,
    port: ep.port,
    username: 'root',
    privateKey: Buffer.from('harness private key'),
    pinnedHostKey: null
  })
  return { machine, conn, sftp: await import('./sftp') }
}

/**
 * Every connection the app has open to `machine`, found as a stalled download
 * elsewhere on the node would reach it: to reset its SFTP channel.
 */
function connectionsTo(machine: FakeMachine): Array<{ resetSftp(): void }> {
  return w.network.connections.filter((c) =>
    machine.endpoints.some((e) => e.host === c.host && e.port === c.port)
  )
}

/** Answer the node-side sha256sum of a .part, after resetting the SFTP channel (another transfer's stall). */
function resetDuringPartHash(machine: FakeMachine, reset: () => void): void {
  machine.onExec(
    /^sha256sum '([^']+\.part)'/,
    (_command, m) => {
      reset()
      const data = machine.files.get(m[1])
      return data ? `${sha256(data)}\n` : '\n'
    },
    1
  )
}

const SCENE = `${REMOTE_ROOT}/work/scenes/shot.blend`

describe('uploadFileVerified', () => {
  it('1.10 #244: a channel reset during the hash check does not strand the rename', async () => {
    // The upload held one SFTP wrapper across the node-side sha256sum. A reset
    // landing then (any stalled download on the node resets the channel) left
    // the rename on the dead channel, never answered, inside the prep lock.
    const { machine, conn, sftp } = await node()
    resetDuringPartHash(machine, () => conn.resetSftp())
    const local = w.blend('shot.blend')

    const up = watch(sftp.uploadFileVerified(conn, local, SCENE))
    await w.until(() => up.done, 'upload settles')

    expect(up.error).toBeUndefined()
    expect(up.value).toBe('uploaded')
    expect(machine.files.get(SCENE)?.equals(readFileSync(local))).toBe(true)
    expect(machine.files.has(`${SCENE}.part`)).toBe(false)
  })

  it('1.10 #244: a rename the node never answers fails at its deadline, and the channel is reset', async () => {
    const { machine, conn, sftp } = await node()
    const before = await conn.sftp()
    let asked = 0
    machine.onSftp(
      'rename',
      () => {
        asked = Date.now()
        return HANG
      },
      1
    )

    const up = watch(sftp.uploadFileVerified(conn, w.blend(), SCENE))
    await w.until(() => up.done, 'upload settles')

    expect(up.error).toBeInstanceOf(sftp.SftpTimeoutError)
    expect(Date.now() - asked).toBeLessThanOrEqual(sftp.SFTP_OP_TIMEOUT_MS + 1_000)
    // Given up on: what comes next runs on a fresh channel.
    expect(await conn.sftp()).not.toBe(before)
    await expect(sftp.renameRemote(conn, `${SCENE}.part`, SCENE)).resolves.toBeUndefined()
  })

  it('an upload that stops moving fails at UPLOAD_STALL_MS', async () => {
    const { machine, conn, sftp } = await node()
    let asked = 0
    machine.onSftp('fastPut', () => {
      asked = Date.now()
      return HANG
    })

    const up = watch(sftp.uploadFileVerified(conn, w.blend(), SCENE))
    await w.until(() => up.done, 'upload settles')

    expect(up.error).toBeInstanceOf(sftp.SftpTimeoutError)
    expect(Date.now() - asked).toBeLessThanOrEqual(sftp.UPLOAD_STALL_MS + 1_000)
  })

  it('a node-side hash that never returns fails at its deadline', async () => {
    const { machine, conn, sftp } = await node()
    machine.onExec(/^sha256sum /, HANG)

    const up = watch(sftp.uploadFileVerified(conn, w.blend(), SCENE))
    await w.until(() => up.done, 'upload settles')

    expect((up.error as Error).message).toMatch(/^exec timeout after \d+ms/)
  })

  it('skips a file the node already has', async () => {
    const { machine, conn, sftp } = await node()
    const local = w.blend()
    machine.files.set(SCENE, readFileSync(local))
    await expect(sftp.uploadFileVerified(conn, local, SCENE)).resolves.toBe('skipped')
    expect(machine.ran(/^mkdir/)).toEqual([])
  })
})

describe('writeRemoteFileAtomic', () => {
  const inbox = `${REMOTE_ROOT}/jobs/inbox`

  it('writes the file under its temporary name, then renames it into place', async () => {
    const { machine, conn, sftp } = await node()
    const landed: string[] = []
    machine.onSpec = (spec) => landed.push(spec.chunkId)
    machine.files.set(`${inbox}/c1.json`, Buffer.from('{"chunkId":"old"}'))

    await sftp.writeRemoteFileAtomic(conn, `${inbox}/c1.json`, '{"chunkId":"c1"}', {
      tmpPath: `${inbox}/c1.tmp.json`
    })

    expect(machine.files.get(`${inbox}/c1.json`)?.toString()).toBe('{"chunkId":"c1"}')
    expect(machine.files.has(`${inbox}/c1.tmp.json`)).toBe(false)
    await w.until(() => landed.length === 1, 'the agent sees the spec')
  })

  it("#245: a reset from another transfer's stall does not fail it", async () => {
    // The spec write shared the channel with the node's downloads, and a stall
    // reset there failed it: dispatch rejected, and requeue charged the chunk
    // a retry for a hiccup on some other chunk's transfer.
    const { machine, conn, sftp } = await node()
    machine.onSftp('writeFile', HANG, 1)

    const write = watch(
      sftp.writeRemoteFileAtomic(conn, `${inbox}/c1.json`, '{"chunkId":"c1"}', {
        tmpPath: `${inbox}/c1.tmp.json`
      })
    )
    await w.advance(1_000)
    expect(write.done).toBe(false)
    conn.resetSftp()
    await w.until(() => write.done, 'write settles')

    expect(write.error).toBeUndefined()
    expect(machine.files.get(`${inbox}/c1.json`)?.toString()).toBe('{"chunkId":"c1"}')
  })

  it('fails, rather than hangs, when the node never answers the write', async () => {
    const { machine, conn, sftp } = await node()
    machine.onSftp('writeFile', HANG)
    const write = watch(
      sftp.writeRemoteFileAtomic(conn, `${inbox}/c1.json`, '{}', {
        tmpPath: `${inbox}/c1.tmp.json`
      })
    )
    await w.until(() => write.done, 'write settles')
    expect(write.error).toBeInstanceOf(sftp.SftpTimeoutError)
  })
})

describe('the scheduler, uploading a scene', () => {
  it("1.10 #244: a channel reset mid-upload does not hold the node's prep lock", async () => {
    // The whole path: the scene upload runs inside withNodePrep, so a hang
    // there left the chunk 'assigned' and the node 'rendering', billing,
    // with every later dispatch to it queued behind the lock.
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    machine.agent.autoFinish()
    resetDuringPartHash(machine, () => {
      for (const c of connectionsTo(machine)) c.resetSftp()
    })

    const jobId = await w.submitJob(app)
    app.scheduler.kick()
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete'
    )

    expect(machine.ran(/^sha256sum '.*\.part'/)).toHaveLength(1)
  })
})

describe('downloadFileVerified', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const FRAME = `${REMOTE_ROOT}/renders/c1/frames/0001.exr`

  /** A frame of `n` bytes on the node, as manifested: its bytes and entry. */
  function frameOn(
    machine: FakeMachine,
    n: number,
    seed = 1
  ): { data: Buffer; entry: { size: number; sha256: string } } {
    const data = Buffer.alloc(n)
    for (let i = 0; i < n; i++) data[i] = (i * 31 + seed * 7) & 0xff
    machine.files.set(FRAME, data)
    return { data, entry: { size: n, sha256: sha256(data) } }
  }

  function localFrame(): string {
    return join(w.settings.projectRoot, 'renders', 'job1', 'frames', '0001.exr')
  }

  /**
   * Let the first `n` reads through, then leave every later one unanswered: a
   * wedge, until `release()`.
   */
  function wedgeAfterReads(machine: FakeMachine, n: number): { release(): void } {
    let reads = 0
    let wedged = true
    machine.onSftp('read', () => (wedged && ++reads > n ? HANG : undefined))
    return {
      release: () => {
        wedged = false
      }
    }
  }

  /** Count SFTP reads from now on, letting them through. */
  function countReads(machine: FakeMachine): { n: number } {
    const count = { n: 0 }
    machine.onSftp('read', () => {
      count.n++
      return undefined
    })
    return count
  }

  it('1.10 #240: a partial of other content is never resumed as a prefix', async () => {
    // Frame 1 half-downloaded from one render, then requeued to another node,
    // whose bytes differ (EXR metadata alone makes them). The partial was
    // resumed anyway, failed its hash, and cost an attempt and a transfer.
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000, 1)
    const wedge = wedgeAfterReads(machine, 3)
    const first = watch(
      sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, { stallMs: 5_000 })
    )
    await w.until(() => first.done, 'first attempt stalls')
    expect(first.error).toBeInstanceOf(sftp.TransferStalledError)
    expect(readFileSync(sftp.partPathFor(localFrame(), a.entry)).length).toBeGreaterThan(0)

    // The re-render's frame, same name and size, different bytes. Its own
    // download on the default stall budget: the watchdog counts reads, and
    // the real disk writes behind them can lag several fake-clock steps.
    wedge.release()
    const b = frameOn(machine, 200_000, 2)
    const second = watch(sftp.downloadFileVerified(conn, FRAME, localFrame(), b.entry))
    await w.until(() => second.done, 'second download settles')

    expect(second.error).toBeUndefined()
    expect(readFileSync(localFrame()).equals(b.data)).toBe(true)
  })

  it('1.10 #240: a partial of the same content resumes, fetching only the rest', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    const wedge = wedgeAfterReads(machine, 3)
    const first = watch(
      sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, { stallMs: 5_000 })
    )
    await w.until(() => first.done, 'first attempt stalls')
    wedge.release()
    const kept = readFileSync(sftp.partPathFor(localFrame(), a.entry)).length
    expect(kept).toBe(3 * 32_768)

    const reads = countReads(machine)
    const second = watch(sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry))
    await w.until(() => second.done, 'second download settles')

    expect(second.value).toBe('downloaded')
    expect(reads.n).toBe(Math.ceil((200_000 - kept) / 32_768))
    expect(readFileSync(localFrame()).equals(a.data)).toBe(true)
    expect(existsSync(sftp.partPathFor(localFrame(), a.entry))).toBe(false)
  })

  it('a whole partial whose rename failed is checked and renamed, not fetched again', async () => {
    // A frame file another program held (Windows antivirus, a viewer, a
    // Finder lock) refused the rename after the whole file had landed, and
    // every retry deleted the .part and fetched it all again.
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    const rename = fsp.rename.bind(fsp)
    const refuse = vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}'`), {
        code: 'EPERM',
        syscall: 'rename',
        path: String(from)
      })
    })
    const first = await sftp
      .downloadFileVerified(conn, FRAME, localFrame(), a.entry)
      .catch((e: unknown) => e)
    expect(first).toBeInstanceOf(sftp.LocalSinkError)
    expect(readFileSync(sftp.partPathFor(localFrame(), a.entry)).length).toBe(200_000)
    refuse.mockImplementation(rename)

    const reads = countReads(machine)
    await expect(sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry)).resolves.toBe(
      'downloaded'
    )

    expect(reads.n).toBe(0)
    expect(readFileSync(localFrame()).equals(a.data)).toBe(true)
    expect(existsSync(sftp.partPathFor(localFrame(), a.entry))).toBe(false)
  })

  it('a partial of the whole size but the wrong bytes is fetched again, in the same attempt', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    const part = sftp.partPathFor(localFrame(), a.entry)
    await fsp.mkdir(dirname(part), { recursive: true })
    await fsp.writeFile(part, Buffer.alloc(200_000, 7))

    await expect(sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry)).resolves.toBe(
      'downloaded'
    )
    expect(readFileSync(localFrame()).equals(a.data)).toBe(true)
  })

  it('discardPartial waits for the download writing that file to let go', async () => {
    // Called as a transfer is stopped: removing the .part while it was still
    // open for writing pulled the file from under that writer (and on
    // Windows fails outright).
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    wedgeAfterReads(machine, 2)
    const ctl = new AbortController()
    const got = watch(
      sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, { signal: ctl.signal })
    )
    const part = sftp.partPathFor(localFrame(), a.entry)
    await w.until(() => existsSync(part), 'transfer under way')

    const discard = watch(sftp.discardPartial(localFrame(), a.entry))
    await w.advance(2_000)
    expect(discard.done).toBe(false)
    expect(existsSync(part)).toBe(true)

    ctl.abort()
    await w.until(() => discard.done, 'the discard runs')
    expect(got.error).toBeInstanceOf(sftp.TransferAbortedError)
    expect(existsSync(part)).toBe(false)
  })

  it('#245: a stall resets the channel it stalled on, by name', async () => {
    // Not "whatever is cached": see sshConnection.test.ts for why that matters.
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    const used = await conn.sftp()
    const reset = vi.spyOn(conn, 'resetSftp')
    wedgeAfterReads(machine, 1)
    const got = watch(
      sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, { stallMs: 5_000 })
    )
    await w.until(() => got.done, 'download stalls')

    expect(reset).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledWith(used)
  })

  it('1.10 #243: two downloads of one file never write it at once', async () => {
    // A stopped run's transfer still going as the requeued chunk's starts on
    // the same frame: each one's rename or rm pulled the other's file away.
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 300_000)
    const one = watch(sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry))
    const two = watch(sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry))
    await w.until(() => one.done && two.done, 'both settle')

    expect(one.error).toBeUndefined()
    expect(two.error).toBeUndefined()
    expect([one.value, two.value].sort()).toEqual(['downloaded', 'skipped'])
    expect(readFileSync(localFrame()).equals(a.data)).toBe(true)
  })

  it('1.10 #243: an aborted download stops at once, not at its stall timeout', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    wedgeAfterReads(machine, 2)
    const ctl = new AbortController()
    const got = watch(
      sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, { signal: ctl.signal })
    )
    await w.until(() => existsSync(sftp.partPathFor(localFrame(), a.entry)), 'transfer under way')
    const abortedAt = Date.now()
    ctl.abort()
    await w.until(() => got.done, 'download settles')

    expect(got.error).toBeInstanceOf(sftp.TransferAbortedError)
    expect(Date.now() - abortedAt).toBeLessThan(sftp.DOWNLOAD_STALL_MS)
  })

  it('a download aborted while waiting for another writer of the file never starts', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 200_000)
    wedgeAfterReads(machine, 2)
    const first = watch(sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry))
    const ctl = new AbortController()
    const waiting = watch(
      sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, { signal: ctl.signal })
    )
    await w.advance(1_000)
    ctl.abort()
    await w.until(() => waiting.done, 'the waiting one settles', { timeoutMs: 1_000 })
    expect(waiting.error).toBeInstanceOf(sftp.TransferAbortedError)
    expect(first.done).toBe(false)
  })

  it('reports each read as it lands', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 100_000)
    let landed = 0
    await sftp.downloadFileVerified(conn, FRAME, localFrame(), a.entry, {
      onProgress: (n) => (landed += n)
    })
    expect(landed).toBe(100_000)
  })

  it('B6: no room for the frame fails as LocalSinkError before a byte is fetched', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 8 * 1024 ** 2)
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 100, bsize: 4096 } as unknown as StatsFs)
    let opened = 0
    machine.onSftp('open', () => {
      opened++
      return undefined
    })

    const err = await sftp
      .downloadFileVerified(conn, FRAME, localFrame(), a.entry)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(sftp.LocalSinkError)
    expect(err).toMatchObject({ code: 'ENOSPC' })
    expect(opened).toBe(0)
  })

  it('B6: the reserve is kept, not just the frame', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 8 * 1024 ** 2)
    // Room for the frame, but it would leave less than the reserve.
    const free = sftp.LOCAL_FREE_RESERVE_BYTES + 4 * 1024 ** 2
    vi.spyOn(fsp, 'statfs').mockResolvedValue({
      bavail: free / 4096,
      bsize: 4096
    } as unknown as StatsFs)
    const err = await sftp
      .downloadFileVerified(conn, FRAME, localFrame(), a.entry)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(sftp.LocalSinkError)
  })

  it('B6: a disk that fills mid-write fails as LocalSinkError', async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 100_000)
    const open = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await open(...args)
      fh.write = (() =>
        Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
            syscall: 'write'
          })
        )) as typeof fh.write
      return fh
    })
    const err = await sftp
      .downloadFileVerified(conn, FRAME, localFrame(), a.entry)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(sftp.LocalSinkError)
    expect(sftp.isRemoteMissing(err)).toBe(false)
  })

  it("B6: a project folder whose drive is gone is the local disk's fault, not the node's", async () => {
    const { machine, conn, sftp } = await node()
    const a = frameOn(machine, 1_000)
    vi.spyOn(fsp, 'mkdir').mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory, mkdir 'D:\\\\renders'"), {
        code: 'ENOENT',
        syscall: 'mkdir'
      })
    )
    const err = await sftp
      .downloadFileVerified(conn, FRAME, localFrame(), a.entry)
      .catch((e: unknown) => e)
    // It says "no such file", which frameDownloader used to read as "gone from the node".
    expect(err).toBeInstanceOf(sftp.LocalSinkError)
    expect(sftp.isRemoteMissing(err)).toBe(false)
  })

  it('a file gone from the node is isRemoteMissing, and leaves nothing behind', async () => {
    const { conn, sftp } = await node()
    const err = await sftp
      .downloadFileVerified(conn, FRAME, localFrame(), { size: 10, sha256: 'a'.repeat(64) })
      .catch((e: unknown) => e)
    expect(sftp.isRemoteMissing(err)).toBe(true)
    expect(err).not.toBeInstanceOf(sftp.LocalSinkError)
    expect(existsSync(sftp.partPathFor(localFrame(), { size: 10, sha256: 'a'.repeat(64) }))).toBe(
      false
    )
  })
})
