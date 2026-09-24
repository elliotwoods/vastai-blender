import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ssh2 } from '../test/fakeSsh2'
import { describeCommand, ExecTimeoutError, SshConnection } from './sshConnection'

// The real SshConnection over a fake ssh2 (see fakeSsh2.ts): the harness
// swaps SshConnection out entirely, so this is the only place its own
// deadlines, error text and SFTP channel bookkeeping are exercised.

vi.mock('ssh2', () => import('../test/fakeSsh2'))

beforeEach(() => {
  ssh2.reset()
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
})
afterEach(() => {
  vi.useRealTimers()
})

function connection(): SshConnection {
  return new SshConnection({
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    privateKey: Buffer.from('test key'),
    pinnedHostKey: null
  })
}

/** Settle a promise's outcome without awaiting it, so fake time can run meanwhile. */
function watch<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const w: { done: boolean; value?: T; error?: unknown } = { done: false }
  p.then(
    (v) => Object.assign(w, { done: true, value: v }),
    (e: unknown) => Object.assign(w, { done: true, error: e })
  )
  return w
}

/** Let microtask-driven fake ssh2 replies land. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

// The Octane start as it was: credentials in the command line, which the old
// timeout error quoted (80 characters of it) straight into an alert.
const SECRET = 'hunter2-otoy-pass'
const OCTANE_START = `OTOY_USER='artist@studio.example' OTOY_PASS='${SECRET}' bash /root/vastai/octane/setup_octane.sh start-server`

describe('exec', () => {
  it('runs a command to completion', async () => {
    const conn = connection()
    const r = watch(conn.exec('cat /root/vastai/state/c1.json'))
    await flush()
    const [ch] = ssh2.execsOf(/^cat /)
    ch.write('{"status":"done"}')
    ch.stderr.emit('data', Buffer.from('warn'))
    ch.exit(0)
    await flush()
    expect(r.value).toEqual({ code: 0, stdout: '{"status":"done"}', stderr: 'warn' })
  })

  it('1.8: a timeout names the label, never the command line (Octane credentials reached an alert)', async () => {
    const conn = connection()
    const labelled = watch(
      conn.exec(OCTANE_START, { timeoutMs: 60_000, label: 'start OctaneServer' })
    )
    const bare = watch(conn.exec(OCTANE_START, { timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(labelled.error).toBeInstanceOf(ExecTimeoutError)
    expect((labelled.error as Error).message).toBe('exec timeout after 60000ms: start OctaneServer')
    // No label: still nothing of the command line but a program name, and
    // this one starts with an assignment, so not even that.
    expect((bare.error as Error).message).toBe('exec timeout after 60000ms: command')
    for (const r of [labelled, bare]) {
      expect(String(r.error)).not.toContain(SECRET)
      expect(String(r.error)).not.toContain('OTOY')
    }
    // Both channels were closed at the deadline.
    expect(ssh2.execs.every((e) => e.closeCalls === 1)).toBe(true)
  })

  it('1.8: the deadline covers a channel open that is never answered', async () => {
    const conn = connection()
    await conn.acquire()
    ssh2.holdOpens = true
    const r = watch(conn.exec('cat /root/vastai/renders/c1/manifest.jsonl', { timeoutMs: 30_000 }))

    await vi.advanceTimersByTimeAsync(30_000)
    expect(r.done).toBe(true)
    expect((r.error as Error).message).toBe('exec timeout after 30000ms: cat')

    // The connection un-wedges: the late channel is closed, not left open.
    ssh2.releaseOpens()
    await flush()
    const [late] = ssh2.execs
    expect(late.closeCalls).toBe(1)
  })

  it('stops retrying a busy channel cap once its deadline has passed', async () => {
    const conn = connection()
    await conn.acquire()
    const client = ssh2.clients[0]
    let opens = 0
    // Every open refused, as with the server's session cap held.
    client.exec = (_command, cb) => {
      opens++
      queueMicrotask(() => cb(new Error('(SSH) Channel open failure: open failed'), null as never))
    }
    const r = watch(conn.exec('cat x', { timeoutMs: 2_000 }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect((r.error as Error).message).toBe('exec timeout after 2000ms: cat')
    // The first retry (at 1.5 s) runs; the next (at 1.5 + 3 s) would not
    // have been worth making.
    expect(opens).toBe(2)
  })
})

describe('describeCommand', () => {
  it('names a command by its label, or else only by the program it runs', () => {
    expect(describeCommand('rm -f /x', 'retract spec')).toBe('retract spec')
    expect(describeCommand('cat /root/vastai/state/c1.json 2>/dev/null')).toBe('cat')
    expect(describeCommand('  /root/vastai/blender/4.2.3/blender -b x.blend')).toBe('blender')
    expect(describeCommand('A=1 bash x.sh')).toBe('command')
    expect(describeCommand(`'${SECRET}' | sh`)).toBe('command')
    expect(describeCommand('')).toBe('command')
  })
})

describe('execStream', () => {
  it('streams lines and resolves done with the exit code', async () => {
    const conn = connection()
    const lines: string[] = []
    const call = watch(conn.execStream('bash provision.sh base', (l) => lines.push(l)))
    await flush()
    const [ch] = ssh2.execs
    ch.write('one\r\ntw')
    ch.write('o\nthree')
    ch.exit(0)
    await flush()
    expect(await call.value!.done).toBe(0)
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('1.8: a command still running at its deadline is closed, and done rejects', async () => {
    // A stalled download inside provision.sh: runLogged waited on `done` forever.
    const conn = connection()
    const call = watch(
      conn.execStream(`bash /root/vastai/provision.sh install-blender 4.2.3`, () => {}, {
        timeoutMs: 25 * 60_000,
        label: 'install blender 4.2.3'
      })
    )
    await flush()
    const done = watch(call.value!.done)
    await vi.advanceTimersByTimeAsync(25 * 60_000 - 1)
    expect(done.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    expect(done.error).toBeInstanceOf(ExecTimeoutError)
    expect((done.error as Error).message).toBe(
      'execStream timeout after 1500000ms: install blender 4.2.3'
    )
    expect(ssh2.execs[0].closeCalls).toBe(1)
  })

  it('1.8: the deadline covers a channel open that is never answered', async () => {
    const conn = connection()
    await conn.acquire()
    ssh2.holdOpens = true
    const call = watch(conn.execStream(OCTANE_START, () => {}, { timeoutMs: 10_000 }))
    await vi.advanceTimersByTimeAsync(10_000)

    expect((call.error as Error).message).toBe('execStream timeout after 10000ms: command')
    ssh2.releaseOpens()
    await flush()
    expect(ssh2.execs[0].closeCalls).toBe(1)
  })

  it('a stream stopped before its deadline ends normally, and nothing fires later', async () => {
    const conn = connection()
    const call = watch(conn.execStream('tail -F x.log', () => {}, { timeoutMs: 5_000 }))
    await flush()
    // A caller that never awaits `done`, like the log tail: its deadline must
    // not become an unhandled rejection either (vitest fails the run on one).
    call.value!.stop()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await call.value!.done).toBeUndefined()
  })

  it('a deadline on a stream whose done nobody awaits is not an unhandled rejection', async () => {
    const conn = connection()
    await conn.execStream('tail -F x.log', () => {}, { timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()
    expect(ssh2.execs[0].closeCalls).toBe(1)
  })
})

describe('the SFTP channel', () => {
  it('#245: resetSftp(stale) ends only the channel that stalled, not the fresh one after it', async () => {
    // A wedge stalls every transfer on channel A; their watchdogs fire seconds
    // apart. The first reset makes room for channel B, which the next queued
    // transfer opens at once — and the second watchdog used to end B.
    const conn = connection()
    const a = await conn.sftp()
    conn.resetSftp(a)
    const b = await conn.sftp()
    expect(b).not.toBe(a)
    const onB = watch(
      new Promise((res, rej) =>
        b.stat('/root/vastai/renders/c1/frames/0001.png', (e) => (e ? rej(e) : res(null)))
      )
    )

    conn.resetSftp(a)
    await flush()

    expect(ssh2.sftps[1].state).toBe('open')
    expect(ssh2.sftps[1].endCalls).toBe(0)
    expect(await conn.sftp()).toBe(b)
    ssh2.sftps[1].answerAll()
    await flush()
    expect(onB.error).toBeUndefined()
    expect(onB.done).toBe(true)
  })

  it('#245: an open that times out is given up on, for every caller waiting on it', async () => {
    const conn = connection()
    await conn.acquire()
    ssh2.holdOpens = true
    const timed = watch(conn.sftp({ timeoutMs: 60_000 }))
    // The spec write: no timeout of its own, waiting on the same open.
    const untimed = watch(conn.sftp())
    await vi.advanceTimersByTimeAsync(60_000)

    expect((timed.error as Error).message).toBe('SFTP channel open timed out after 60000ms')
    expect(untimed.done).toBe(true)
    expect(untimed.error).toBeInstanceOf(Error)

    // The retry opens a fresh channel instead of waiting on the hung one again.
    ssh2.holdOpens = false
    const fresh = await conn.sftp({ timeoutMs: 60_000 })
    // The hung open is answered late: ended, never cached over the fresh one.
    ssh2.releaseOpens()
    await flush()
    const late = ssh2.sftps.find((s) => (s as unknown) !== fresh)!
    expect(late.endCalls).toBe(1)
    expect(await conn.sftp()).toBe(fresh)
  })

  it('an open answered in time is cached as before', async () => {
    const conn = connection()
    const s = await conn.sftp({ timeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await conn.sftp()).toBe(s)
    expect(ssh2.sftps).toHaveLength(1)
  })

  it("a channel the node's sftp-server breaks is dropped, without crashing main", async () => {
    const conn = connection()
    const s = await conn.sftp()
    // With no 'error' listener, EventEmitter throws this out of ssh2's socket callback.
    expect(() => ssh2.sftps[0].fatal()).not.toThrow()
    expect(ssh2.sftps[0].endCalls).toBe(1)
    const next = await conn.sftp()
    expect(next).not.toBe(s)
  })

  it('a channel that closes is forgotten; the next sftp() opens another', async () => {
    const conn = connection()
    const s = await conn.sftp()
    ssh2.sftps[0].serverClose()
    expect(await conn.sftp()).not.toBe(s)
  })

  it('resetSftp() with no channel ends the cached one and gives up on an open in flight', async () => {
    const conn = connection()
    await conn.sftp()
    conn.resetSftp()
    expect(ssh2.sftps[0].endCalls).toBe(1)

    ssh2.holdOpens = true
    const opening = watch(conn.sftp())
    await flush()
    conn.resetSftp()
    await flush()
    expect(opening.error).toBeInstanceOf(Error)
    ssh2.releaseOpens()
    await flush()
    expect(ssh2.sftps[1].endCalls).toBe(1)
  })

  it('close() fails an open in flight, and the late channel is ended', async () => {
    const conn = connection()
    await conn.acquire()
    ssh2.holdOpens = true
    const opening = watch(conn.sftp())
    await flush()
    conn.close()
    await flush()
    expect((opening.error as Error).message).toBe('connection closed')
    ssh2.releaseOpens()
    await flush()
    expect(ssh2.sftps[0].endCalls).toBe(1)
  })
})
