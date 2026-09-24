import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
