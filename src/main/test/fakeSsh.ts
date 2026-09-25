/**
 * The node side of the harness: fake machines behind a fake SSH transport.
 *
 * A `FakeMachine` is one rented box: an in-memory filesystem, a small emulator
 * for the shell commands the app actually sends (echo, cat, rm -f, sha256sum,
 * mkdir -p, tail, nvidia-smi...), SFTP over the same filesystem, and a
 * `FakeAgent` that writes the state and manifest files noderunner.py would.
 * `FakeSshConnection` stands in for ssh/sshConnection's `SshConnection`: the
 * app constructs it with a host and port exactly as it would the real one,
 * and it finds the machine listening there on the `FakeNetwork`.
 *
 * Everything answers through promises (microtasks), never timers, so a reply
 * lands on the next `await` whatever the fake clock is doing. The one real
 * asynchrony left is the local disk: SFTP uploads read, and downloads write,
 * real files under the harness's temp directory.
 *
 * When a connection closes — the app's close(), or the instance destroyed —
 * every channel on it ends the way ssh2 ends a channel whose connection went:
 * - an exec resolves with exit code null and whatever output had arrived
 *   (none, here), and an execStream's `done` resolves null;
 * - the SFTP channel fails every request still waiting for an answer with
 *   "No response from server" (ssh2's cleanupRequests) and emits 'end' and
 *   'close'. A request made on the old wrapper after that is never answered
 *   at all: ssh2 registers it once its cleanup has run and drops the write
 *   (the channel is closed, or the dead connection's cipher discards it), so
 *   only a timeout of the app's own ends it — pipelinedGet's stall watchdog,
 *   say. The connection opens a fresh channel on the next sftp().
 * - a command or SFTP channel that had not opened yet fails with "No response
 *   from server": nothing ever runs on a machine after it is killed.
 * The real client notices a destroyed box only when keepalive gives up
 * (~30 s); the fake notices at once.
 *
 * resetSftp() ends the SFTP channel on a live connection the same way, as
 * ssh2's end() does.
 *
 * Script SFTP with `machine.onSftp(method, HANG | Error | fn)`, as exec is
 * scripted with onExec. A HANG'd request waits until its channel closes.
 */

import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import { posix } from 'path'
import type { ExecResult, SshTarget } from '../ssh/sshConnection'

/**
 * Mirrors provisioner's REMOTE_ROOT. Not imported: provisioner pulls in the
 * DB and electron, and the harness loads before any vi.mock is registered.
 * The smoke tests assert the two agree.
 */
export const REMOTE_ROOT = '/root/vastai'

/**
 * Reply that never arrives — a wedged channel. Only an exec timeout, or the
 * connection closing under it, ends it.
 */
export const HANG: unique symbol = Symbol('hang')

/** Plain string = stdout with exit code 0. */
export type ExecReply = string | Partial<ExecResult>
type ReplyOrHang = ExecReply | typeof HANG
export type ExecHandler =
  | ReplyOrHang
  | ((
      command: string,
      match: RegExpMatchArray,
      machine: FakeMachine
    ) => ReplyOrHang | Promise<ReplyOrHang>)

interface Rule {
  pattern: RegExp
  handler: ExecHandler
  /** remaining uses; Infinity = sticky */
  times: number
}

/** The SFTP requests the app makes (sftp.ts, pipelinedGet), each scriptable with onSftp. */
export type SftpMethod =
  'open' | 'read' | 'close' | 'readFile' | 'writeFile' | 'rename' | 'unlink' | 'fastPut'

/** A scripted answer to an SFTP request: never answer it, or fail it with this error. */
export type SftpReply = typeof HANG | Error

/**
 * `HANG`, an Error, or a function of the request's remote path (for read and
 * close, the path its handle was opened on) that returns one of those — or
 * undefined to let the request through to the built-in behaviour.
 */
export type SftpHandler =
  SftpReply | ((path: string, machine: FakeMachine) => SftpReply | undefined)

interface SftpRule {
  method: SftpMethod
  handler: SftpHandler
  /** remaining uses; Infinity = sticky */
  times: number
}

export interface Endpoint {
  host: string
  port: number
}

/** A channel open on a connection: an exec, an execStream or the SFTP channel. */
interface OpenChannel {
  /** The connection went under it: end it as ssh2 does (see the header). */
  drop(): void
}

/** What ssh2 fails a request with when its channel or connection goes before the answer. */
function noResponse(): Error {
  return new Error('No response from server')
}

/** The job spec the scheduler writes into the agent's inbox (the fields tests read). */
export interface AgentSpec {
  chunkId: string
  blendFile: string
  blenderVersion: string | null
  engine: string
  frameStart: number
  frameEnd: number
  frameStep: number
  nodeSlots: number
  exclusive: boolean
  lanes: number
  pinGpus: boolean
  [key: string]: unknown
}

/** noderunner's state/<chunkId>.json (see scheduler's AgentState). */
export interface AgentStateFile {
  status: 'rendering' | 'encoding' | 'done' | 'failed'
  currentFrame: number | null
  framesDone: number
  framesTotal?: number
  error?: string
  exitCode: number | null
  /** epoch seconds */
  updatedAt?: number
  gpu?: number | null
  /** What the real agent adds (scheduler's AgentState), for a test that writes it. */
  errorKind?: string | null
  logTail?: string[]
  lastProgressAt?: number
  engine?: string | null
  oom?: boolean
  pinFailed?: boolean
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

function unquote(s: string): string {
  return s.replace(/^'(.*)'$/, '$1')
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** An ssh2-shaped SFTP error ("No such file" is what frameDownloader matches on). */
function sftpError(message: 'No such file' | 'Failure', path: string): Error {
  return Object.assign(new Error(`${message}: ${path}`), {
    code: message === 'No such file' ? 2 : 4
  })
}

/**
 * The commands the app sends, emulated against the machine's files. Anything
 * unmatched succeeds with no output — provision.sh, pkill, chmod — and is
 * still recorded in `machine.execs`.
 */
const BUILTINS: Array<[RegExp, (m: RegExpMatchArray, machine: FakeMachine) => ReplyOrHang]> = [
  // driveToReady's and resumeNode's first-contact check.
  [/^echo ok\b/, () => ok('ok\nNVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54 (fake)\n')],
  [/^nvidia-smi --query-gpu/, (_m, machine) => ok(machine.metricsText())],
  [
    /^sha256sum '([^']+)'/,
    (m, machine) => {
      const data = machine.files.get(m[1])
      return ok(data ? `${sha256(data)}\n` : '\n')
    }
  ],
  [
    /^cat ('[^']+'|\S+)(?: 2>\/dev\/null)?$/,
    (m, machine) => {
      const data = machine.files.get(unquote(m[1]))
      return data ? ok(data.toString('utf-8')) : { code: 1, stdout: '', stderr: '' }
    }
  ],
  [
    // `rm -f a 'b'` and the cancel form `rm -f x.json; pkill -f 'id' || true`.
    /^rm -f ([^;&|]+)/,
    (m, machine) => {
      for (const p of m[1].trim().split(/\s+/)) machine.files.delete(unquote(p))
      return ok()
    }
  ],
  [
    // remoteMkdirp, and writePreviewFlag's `mkdir -p dir && touch 'flag'`.
    /^mkdir -p ('[^']+'|\S+)(?: && touch '([^']+)')?$/,
    (m, machine) => {
      if (m[2] && !machine.files.has(m[2])) machine.files.set(m[2], Buffer.alloc(0))
      return ok()
    }
  ],
  [
    // The per-chunk log tail: held open until stopped, like `tail -F`.
    /^touch ('[^']+'|\S+) && tail -n \+1 -F /,
    (m, machine) => {
      const path = unquote(m[1])
      if (!machine.files.has(path)) machine.files.set(path, Buffer.alloc(0))
      return HANG
    }
  ],
  [
    /^tail -n (\d+) '([^']+)'/,
    (m, machine) => {
      const text = machine.files.get(m[2])?.toString('utf-8') ?? ''
      return ok(text.split('\n').slice(-Number(m[1])).join('\n'))
    }
  ],
  [/state\/heartbeat/, (_m, machine) => ok(machine.agent.alive ? 'alive\n' : 'dead\n')],
  [/provision\.sh probe-eevee/, () => ok('PROBE_OK\n')]
]

/**
 * One rented machine. Script it with `onExec`, inspect it through `execs` and
 * `files`, drive its agent through `agent`.
 */
export class FakeMachine {
  /** Absolute posix path → contents. Directories are not modelled. */
  readonly files = new Map<string, Buffer>()
  /** Every command run on this machine, in order (exec and execStream). */
  readonly execs: string[] = []
  readonly agent: FakeAgent
  /** false once the instance is destroyed: connections are refused and dropped. */
  alive = true
  /** Refuse this many more connection attempts (sshd not listening yet). */
  refuseConnects = 0
  /** Successful connection handshakes so far. */
  connects = 0
  numGpus = 1
  /** What the TOFU pin should see; change it to simulate a different box. */
  hostKey: string
  /** Called with every spec that lands in the inbox (after its atomic rename). */
  onSpec: ((spec: AgentSpec) => void) | null = null

  private rules: Rule[] = []
  private sftpRules: SftpRule[] = []
  private openChannels = new Set<OpenChannel>()

  constructor(
    readonly name: string,
    readonly endpoints: Endpoint[]
  ) {
    this.agent = new FakeAgent(this)
    this.hostKey = createHash('sha256').update(name).digest('base64')
  }

  /**
   * Answer commands matching `pattern` with `handler` (a reply, `HANG`, or a
   * function of the command) — ahead of the built-in emulation and of rules
   * added earlier. `times` limits how many commands it answers.
   */
  onExec(pattern: RegExp, handler: ExecHandler, times = Infinity): this {
    this.rules.unshift({ pattern, handler, times })
    return this
  }

  /**
   * Answer SFTP `method` requests with `handler` instead of the built-in
   * behaviour: `HANG` (no answer until the channel closes), an Error (the
   * request fails with it: `Object.assign(new Error('Failure'), { code: 4 })`
   * is ssh2's shape for a server-side failure), or a function of the remote
   * path returning either, or undefined to let that request through. Newest
   * rule first, as onExec; `times` limits how many requests it answers.
   */
  onSftp(method: SftpMethod, handler: SftpHandler, times = Infinity): this {
    this.sftpRules.unshift({ method, handler, times })
    return this
  }

  /** @internal the scripted answer to an SFTP request, or null for the built-in one */
  sftpReply(method: SftpMethod, path: string): SftpReply | null {
    for (const rule of this.sftpRules) {
      if (rule.method !== method || rule.times <= 0) continue
      const h = rule.handler
      const reply = typeof h === 'function' ? h(path, this) : h
      if (reply === undefined) continue
      rule.times--
      return reply
    }
    return null
  }

  /** Commands run so far that match `pattern`. */
  ran(pattern: RegExp): string[] {
    return this.execs.filter((c) => pattern.test(c))
  }

  /** Run one command: the first matching rule, then the built-ins, then success. */
  async run(command: string): Promise<ReplyOrHang> {
    this.execs.push(command)
    for (const rule of this.rules) {
      const m = command.match(rule.pattern)
      if (!m || rule.times <= 0) continue
      rule.times--
      const h = rule.handler
      return typeof h === 'function' ? h(command, m, this) : h
    }
    for (const [pattern, reply] of BUILTINS) {
      const m = command.match(pattern)
      if (m) return reply(m, this)
    }
    return ok()
  }

  /** @internal a channel the machine must end when it dies — at once, if it already has */
  track(channel: OpenChannel): void {
    if (!this.alive) {
      channel.drop()
      return
    }
    this.openChannels.add(channel)
  }

  /** @internal */
  untrack(channel: OpenChannel): void {
    this.openChannels.delete(channel)
  }

  /** The instance is gone: refuse new connections, end every command running on it. */
  kill(): void {
    this.alive = false
    for (const c of [...this.openChannels]) c.drop()
  }

  /** `nvidia-smi` + loadavg + meminfo + /proc/stat, in pollMetrics' layout. */
  metricsText(): string {
    const gpus = Array.from(
      { length: this.numGpus },
      (_, i) => `95, 8000, 24576, 65, 300.5, 450, ${i}`
    ).join('\n')
    return (
      `${gpus}\n----\n4.00 3.50 3.00 2/300 12345\n32\n----\n` +
      `MemTotal:       131072000 kB\nMemAvailable:    65536000 kB\n` +
      `cpu  1000 0 500 8000 100 0 0 0 0 0\n`
    )
  }

  /** @internal SFTP rename into the inbox is the agent's pickup signal. */
  specLanded(path: string): void {
    const m = new RegExp(`^${REMOTE_ROOT}/jobs/inbox/([^/]+)\\.json$`).exec(path)
    if (!m || m[1].endsWith('.tmp') || !this.onSpec) return
    const spec = JSON.parse(this.files.get(path)!.toString('utf-8')) as AgentSpec
    const cb = this.onSpec
    queueMicrotask(() => cb(spec))
  }
}

/** What noderunner.py does with a spec, done by hand (or at once, with autoFinish). */
export class FakeAgent {
  /** Answers the heartbeat check (provisioner's agentAlive). */
  alive = true

  constructor(private readonly machine: FakeMachine) {}

  private read(path: string): string | null {
    return this.machine.files.get(path)?.toString('utf-8') ?? null
  }

  /** Chunk ids with a spec waiting in the inbox. */
  inbox(): string[] {
    const prefix = `${REMOTE_ROOT}/jobs/inbox/`
    return [...this.machine.files.keys()]
      .filter((p) => p.startsWith(prefix) && p.endsWith('.json') && !p.endsWith('.tmp.json'))
      .map((p) => posix.basename(p, '.json'))
  }

  /** The spec for a chunk: still in the inbox, or already finished. */
  spec(chunkId: string): AgentSpec | null {
    const text =
      this.read(`${REMOTE_ROOT}/jobs/inbox/${chunkId}.json`) ??
      this.read(`${REMOTE_ROOT}/jobs/done/${chunkId}.json`)
    return text ? (JSON.parse(text) as AgentSpec) : null
  }

  /** The agent's current state file for a chunk, if any. */
  stateOf(chunkId: string): AgentStateFile | null {
    const text = this.read(`${REMOTE_ROOT}/state/${chunkId}.json`)
    return text ? (JSON.parse(text) as AgentStateFile) : null
  }

  /** Write the state file, stamped with the (fake) current time. */
  writeState(chunkId: string, state: Partial<AgentStateFile>): void {
    const full: AgentStateFile = {
      status: 'rendering',
      currentFrame: null,
      framesDone: 0,
      exitCode: null,
      ...state,
      updatedAt: state.updatedAt ?? Date.now() / 1000
    }
    this.machine.files.set(
      `${REMOTE_ROOT}/state/${chunkId}.json`,
      Buffer.from(JSON.stringify(full), 'utf-8')
    )
  }

  /** Every frame number the chunk's spec asks for. */
  framesOf(chunkId: string): number[] {
    const spec = this.spec(chunkId)
    if (!spec) throw new Error(`fake agent: no spec for ${chunkId} on ${this.machine.name}`)
    const out: number[] = []
    for (let f = spec.frameStart; f <= spec.frameEnd; f += spec.frameStep) out.push(f)
    return out
  }

  /**
   * Render frames: write each file and its manifest line (with size and
   * sha256, as noderunner does once a file is size-stable). Defaults to the
   * spec's whole range.
   */
  render(chunkId: string, frames: number[] = this.framesOf(chunkId), ext = 'png'): void {
    const dir = `${REMOTE_ROOT}/renders/${chunkId}`
    const manifest = `${dir}/manifest.jsonl`
    let lines = this.read(manifest) ?? ''
    for (const f of frames) {
      const file = `frames/${String(f).padStart(4, '0')}.${ext}`
      const data = Buffer.from(`fake render ${chunkId} frame ${f}\n`, 'utf-8')
      this.machine.files.set(`${dir}/${file}`, data)
      lines +=
        JSON.stringify({
          kind: 'frame',
          file,
          size: data.length,
          sha256: sha256(data),
          mtime: Date.now() / 1000
        }) + '\n'
    }
    this.machine.files.set(manifest, Buffer.from(lines, 'utf-8'))
  }

  /** Report progress without finishing. */
  progress(chunkId: string, framesDone: number, currentFrame: number | null = null): void {
    this.writeState(chunkId, { status: 'rendering', framesDone, currentFrame })
  }

  /** Render (by default every frame) and report 'done'; the spec moves to jobs/done. */
  finish(chunkId: string, opts: { frames?: number[] } = {}): void {
    const frames = opts.frames ?? this.framesOf(chunkId)
    this.render(chunkId, frames)
    this.retire(chunkId)
    this.writeState(chunkId, {
      status: 'done',
      framesDone: frames.length,
      framesTotal: frames.length,
      exitCode: 0
    })
  }

  /** Report the render as failed. */
  fail(chunkId: string, error = 'blender exited with code 1', exitCode = 1): void {
    this.retire(chunkId)
    this.writeState(chunkId, { status: 'failed', error, exitCode })
  }

  /** Finish every spec the moment it lands. */
  autoFinish(): void {
    this.machine.onSpec = (spec) => this.finish(spec.chunkId)
  }

  private retire(chunkId: string): void {
    const inbox = `${REMOTE_ROOT}/jobs/inbox/${chunkId}.json`
    const data = this.machine.files.get(inbox)
    if (!data) return
    this.machine.files.delete(inbox)
    this.machine.files.set(`${REMOTE_ROOT}/jobs/done/${chunkId}.json`, data)
  }
}

/** Every machine by endpoint, plus every connection the app opened. */
export class FakeNetwork {
  readonly machines: FakeMachine[] = []
  readonly connections: FakeSshConnection[] = []
  /**
   * Bumped by every connect, command and SFTP request or answer: while it
   * keeps moving, something is still talking to the fake machines (the
   * harness's dispose() waits for it to stop).
   */
  activity = 0
  private mismatches = new WeakSet<object>()

  constructor(
    /** Builds the real HostKeyMismatchError, so `instanceof` in the app holds. */
    private readonly makeHostKeyMismatch: (actual: string, pinned: string) => Error = () =>
      new Error('SSH host key mismatch — possible machine change or MITM')
  ) {}

  /** @internal the error a connect fails with when the machine's key isn't the pinned one */
  hostKeyMismatch(actual: string, pinned: string): Error {
    const e = this.makeHostKeyMismatch(actual, pinned)
    this.mismatches.add(e)
    return e
  }

  /** The fake's `instanceof HostKeyMismatchError`: was `e` raised by hostKeyMismatch()? */
  isHostKeyMismatch(e: unknown): boolean {
    return typeof e === 'object' && e !== null && this.mismatches.has(e)
  }

  addMachine(name: string, endpoints: Endpoint[]): FakeMachine {
    const m = new FakeMachine(name, endpoints)
    this.machines.push(m)
    return m
  }

  find(host: string, port: number): FakeMachine | undefined {
    return this.machines.find((m) => m.endpoints.some((e) => e.host === host && e.port === port))
  }

  /** End of test: drop every connection and stream. */
  shutdown(): void {
    for (const c of this.connections) c.close()
    for (const m of this.machines) m.kill()
  }
}

/** An execStream in flight. */
class FakeStream implements OpenChannel {
  private finished = false
  private resolveDone!: (code: number | null) => void
  readonly done = new Promise<number | null>((r) => (this.resolveDone = r))

  constructor(
    private readonly machine: FakeMachine,
    private readonly onLine: (line: string) => void
  ) {
    machine.track(this)
  }

  write(text: string): void {
    if (this.finished) return
    for (const line of text.split('\n')) if (line) this.onLine(line)
  }

  end(code: number | null): void {
    if (this.finished) return
    this.finished = true
    this.machine.untrack(this)
    this.resolveDone(code)
  }

  drop(): void {
    this.end(null)
  }
}

/**
 * In-memory SFTP: the SFTPWrapper calls sftp.ts and pipelinedGet make, over
 * the machine's files. Callbacks arrive on a microtask, as errors in ssh2's
 * shape. Like SFTP v3, rename onto an existing file fails.
 *
 * It is a channel like any other: it ends with its connection or its machine
 * (drop) or by end() (resetSftp), as the header describes.
 */
class FakeSftp extends EventEmitter implements OpenChannel {
  private handles = new Map<string, string>()
  private nextHandle = 1
  /** Requests not answered yet, each by how it fails: closing the channel fails them all. */
  private waiting = new Set<{ fail: (err: Error) => void }>()
  private closed = false

  constructor(
    private readonly machine: FakeMachine,
    private readonly network: FakeNetwork,
    /** Called once, as the channel closes: the connection forgets it. */
    private readonly onClosed: (sftp: FakeSftp) => void
  ) {
    super()
  }

  private later(fn: () => void): void {
    queueMicrotask(fn)
  }

  /**
   * One request: the scripted answer (onSftp) or `builtin`, which answers
   * through `answer` — on a microtask, and only if the channel has not closed
   * in the meantime.
   */
  private request(
    method: SftpMethod,
    path: string,
    fail: (err: Error) => void,
    builtin: (answer: (fn: () => void) => void) => void
  ): void {
    this.network.activity++
    // Made on a channel that has closed: ssh2 never answers it (see the header).
    if (this.closed) return
    const req = { fail }
    this.waiting.add(req)
    const answer = (fn: () => void): void =>
      this.later(() => {
        if (!this.waiting.delete(req)) return
        this.network.activity++
        fn()
      })
    const scripted = this.machine.sftpReply(method, path)
    if (scripted === HANG) return
    if (scripted) return answer(() => fail(scripted))
    builtin(answer)
  }

  writeFile(path: string, data: Buffer | string, ...rest: unknown[]): void {
    const cb = rest[rest.length - 1] as (err?: Error | null) => void
    this.request('writeFile', path, cb, (answer) => {
      this.machine.files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'))
      answer(() => cb(null))
    })
  }

  readFile(path: string, ...rest: unknown[]): void {
    const cb = rest[rest.length - 1] as (err: Error | null, data?: Buffer) => void
    this.request('readFile', path, cb, (answer) => {
      const data = this.machine.files.get(path)
      answer(() => (data ? cb(null, data) : cb(sftpError('No such file', path))))
    })
  }

  unlink(path: string, cb: (err?: Error | null) => void): void {
    this.request('unlink', path, cb, (answer) => {
      const existed = this.machine.files.delete(path)
      answer(() => cb(existed ? null : sftpError('No such file', path)))
    })
  }

  rename(from: string, to: string, cb: (err?: Error | null) => void): void {
    this.request('rename', from, cb, (answer) => {
      const data = this.machine.files.get(from)
      if (!data) return answer(() => cb(sftpError('No such file', from)))
      if (this.machine.files.has(to)) return answer(() => cb(sftpError('Failure', to)))
      this.machine.files.delete(from)
      this.machine.files.set(to, data)
      answer(() => {
        cb(null)
        this.machine.specLanded(to)
      })
    })
  }

  fastPut(local: string, remote: string, ...rest: unknown[]): void {
    const cb = rest[rest.length - 1] as (err?: Error | null) => void
    this.request('fastPut', remote, cb, (answer) => {
      readFile(local).then(
        (data) =>
          answer(() => {
            this.machine.files.set(remote, data)
            cb(null)
          }),
        (e: Error) => answer(() => cb(e))
      )
    })
  }

  open(path: string, _flags: string, cb: (err: Error | null, handle?: Buffer) => void): void {
    this.request('open', path, cb, (answer) => {
      if (!this.machine.files.has(path)) return answer(() => cb(sftpError('No such file', path)))
      const id = String(this.nextHandle++)
      this.handles.set(id, path)
      answer(() => cb(null, Buffer.from(id)))
    })
  }

  read(
    handle: Buffer,
    buf: Buffer,
    off: number,
    len: number,
    position: number,
    cb: (err: Error | null, bytesRead: number) => void
  ): void {
    const path = this.handles.get(handle.toString())
    this.request(
      'read',
      path ?? '?',
      (e) => cb(e, 0),
      (answer) => {
        const data = path ? this.machine.files.get(path) : undefined
        if (!data) return answer(() => cb(sftpError('No such file', path ?? '?'), 0))
        const n = Math.max(0, Math.min(len, data.length - position))
        data.copy(buf, off, position, position + n)
        answer(() => cb(null, n))
      }
    )
  }

  close(handle: Buffer, cb: (err?: Error | null) => void): void {
    const path = this.handles.get(handle.toString())
    this.request('close', path ?? '?', cb, (answer) => {
      this.handles.delete(handle.toString())
      answer(() => cb(null))
    })
  }

  /** ssh2's end(): close the channel on a live connection (resetSftp). */
  end(): void {
    this.drop()
  }

  /** The channel closes: its connection or its machine went, or end(). */
  drop(): void {
    if (this.closed) return
    this.closed = true
    this.onClosed(this)
    const waiting = [...this.waiting]
    this.waiting.clear()
    this.later(() => {
      // One error for them all, as ssh2's cleanupRequests does.
      const err = noResponse()
      for (const req of waiting) req.fail(err)
      this.emit('end')
      this.emit('close')
    })
  }
}

function connectRefused(target: Endpoint): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${target.host}:${target.port}`), {
    code: 'ECONNREFUSED'
  })
}

/**
 * Stands in for `SshConnection`. Same constructor argument and the same
 * public surface; the harness's vi.mock binds the network.
 */
export class FakeSshConnection extends EventEmitter {
  private machine: FakeMachine | null = null
  private closed = false
  private sftpCache: FakeSftp | null = null
  private seenHostKey: string | null = null
  private channels = new Set<OpenChannel>()

  constructor(
    private target: SshTarget,
    private readonly network: FakeNetwork
  ) {
    super()
    network.connections.push(this)
  }

  get host(): string {
    return this.target.host
  }

  get port(): number {
    return this.target.port
  }

  get hostKeyHash(): string | null {
    return this.seenHostKey
  }

  setTarget(target: SshTarget): void {
    this.target = target
  }

  /** The machine this connection is up to, connecting if needed. */
  async acquire(): Promise<FakeMachine> {
    this.network.activity++
    if (this.closed) throw new Error('connection closed')
    if (this.machine?.alive) return this.machine
    if (this.machine) {
      // The box went away under an open connection.
      this.machine = null
      this.sftpCache = null
      this.emit('disconnected')
    }
    const m = this.network.find(this.target.host, this.target.port)
    if (!m || !m.alive) throw connectRefused(this.target)
    if (m.refuseConnects > 0) {
      m.refuseConnects--
      throw connectRefused(this.target)
    }
    this.seenHostKey = m.hostKey
    if (this.target.pinnedHostKey && this.target.pinnedHostKey !== m.hostKey) {
      throw this.network.hostKeyMismatch(m.hostKey, this.target.pinnedHostKey)
    }
    this.emit('hostKey', m.hostKey)
    m.connects++
    this.machine = m
    this.emit('connected')
    return m
  }

  /** Same backoff as the real one (5s doubling to 60s), on the fake clock. */
  async reconnectWithBackoff(budgetMs = 10 * 60_000): Promise<void> {
    const start = Date.now()
    let delay = 5_000
    for (;;) {
      if (this.closed) throw new Error('connection closed')
      try {
        await this.acquire()
        return
      } catch (e) {
        // A different box behind the endpoint won't turn into the pinned one
        // by waiting: the real one gives up at once, and so does this.
        if (this.network.isHostKeyMismatch(e)) throw e
        if (Date.now() - start + delay > budgetMs) {
          throw new Error(`reconnect budget exhausted: ${(e as Error).message}`)
        }
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  /**
   * The machine a new channel opens on, once acquire() has resolved. If the
   * connection was closed or the box killed in the meantime, the channel
   * never opens: ssh2 fails the open with "No response from server" (at
   * keepalive, where the fake does it at once), and nothing runs.
   */
  private async openOn(): Promise<FakeMachine> {
    const m = await this.acquire()
    if (this.closed || !m.alive) throw noResponse()
    return m
  }

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const m = await this.openOn()
    const reply = m.run(command)
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const channel: OpenChannel = {
        drop: () => settle(() => resolve({ code: null, stdout: '', stderr: '' }))
      }
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        m.untrack(channel)
        this.channels.delete(channel)
        finish()
      }
      this.channels.add(channel)
      m.track(channel)
      if (opts.timeoutMs) {
        // The same message the real exec times out with.
        const message = `exec timeout after ${opts.timeoutMs}ms: ${command.slice(0, 80)}`
        timer = setTimeout(() => settle(() => reject(new Error(message))), opts.timeoutMs)
      }
      reply.then(
        (r) => {
          if (r === HANG) return
          settle(() =>
            resolve(typeof r === 'string' ? ok(r) : { code: 0, stdout: '', stderr: '', ...r })
          )
        },
        (e: Error) => settle(() => reject(e))
      )
    })
  }

  async execStream(
    command: string,
    onLine: (line: string) => void
  ): Promise<{ stop: () => void; done: Promise<number | null> }> {
    const m = await this.openOn()
    const stream = new FakeStream(m, onLine)
    this.channels.add(stream)
    void stream.done.then(() => this.channels.delete(stream))
    m.run(command).then(
      (r) => {
        if (r === HANG) return // held open until stop()
        const res = typeof r === 'string' ? ok(r) : { code: 0, stdout: '', ...r }
        stream.write(res.stdout ?? '')
        stream.end(res.code ?? 0)
      },
      () => stream.end(null)
    )
    return { stop: () => stream.end(null), done: stream.done }
  }

  /** One SFTP channel per connection, cached until it closes, as the real one's is. */
  async sftp(): Promise<FakeSftp> {
    const m = await this.openOn()
    if (this.sftpCache) return this.sftpCache
    const sftp = new FakeSftp(m, this.network, (closed) => {
      // The real one's sftp.on('close') does the same.
      if (this.sftpCache === closed) this.sftpCache = null
      this.channels.delete(closed)
      m.untrack(closed)
    })
    this.sftpCache = sftp
    this.channels.add(sftp)
    m.track(sftp)
    return sftp
  }

  /** Like the real one: end the cached channel (see the header) so the next sftp() opens a fresh one. */
  resetSftp(): void {
    const s = this.sftpCache
    this.sftpCache = null
    s?.end()
  }

  async forwardOut(): Promise<never> {
    throw new Error('harness: forwardOut (the VNC tunnel) is not faked')
  }

  /** Like ending the real client: every channel still open on it ends (see the header). */
  close(): void {
    this.closed = true
    this.sftpCache = null
    this.machine = null
    for (const c of [...this.channels]) c.drop()
  }
}
