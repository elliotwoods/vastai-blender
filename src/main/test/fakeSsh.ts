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
 * every command still running on it ends the way ssh2 ends a channel whose
 * connection went: an exec resolves with exit code null and whatever output
 * had arrived (none, here), and an execStream's `done` resolves null. The real
 * client notices a destroyed box only when keepalive gives up (~30 s); the
 * fake notices at once.
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

export interface Endpoint {
  host: string
  port: number
}

/** A command in flight on a connection: an exec or an execStream. */
interface OpenChannel {
  /** The connection went under it: end it as ssh2 does, with exit code null. */
  drop(): void
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
    /^touch (\S+) && tail -n \+1 -F /,
    (m, machine) => {
      if (!machine.files.has(m[1])) machine.files.set(m[1], Buffer.alloc(0))
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

  /** @internal a command the machine must end when it dies */
  track(channel: OpenChannel): void {
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
 */
class FakeSftp extends EventEmitter {
  private handles = new Map<string, string>()
  private nextHandle = 1

  constructor(private readonly machine: FakeMachine) {
    super()
  }

  private later(fn: () => void): void {
    queueMicrotask(fn)
  }

  writeFile(path: string, data: Buffer | string, ...rest: unknown[]): void {
    const cb = rest[rest.length - 1] as (err?: Error | null) => void
    this.machine.files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'))
    this.later(() => cb(null))
  }

  readFile(path: string, ...rest: unknown[]): void {
    const cb = rest[rest.length - 1] as (err: Error | null, data?: Buffer) => void
    const data = this.machine.files.get(path)
    this.later(() => (data ? cb(null, data) : cb(sftpError('No such file', path))))
  }

  unlink(path: string, cb: (err?: Error | null) => void): void {
    const existed = this.machine.files.delete(path)
    this.later(() => cb(existed ? null : sftpError('No such file', path)))
  }

  rename(from: string, to: string, cb: (err?: Error | null) => void): void {
    const data = this.machine.files.get(from)
    if (!data) return this.later(() => cb(sftpError('No such file', from)))
    if (this.machine.files.has(to)) return this.later(() => cb(sftpError('Failure', to)))
    this.machine.files.delete(from)
    this.machine.files.set(to, data)
    this.later(() => {
      cb(null)
      this.machine.specLanded(to)
    })
  }

  fastPut(local: string, remote: string, ...rest: unknown[]): void {
    const cb = rest[rest.length - 1] as (err?: Error | null) => void
    readFile(local).then(
      (data) => {
        this.machine.files.set(remote, data)
        cb(null)
      },
      (e: Error) => cb(e)
    )
  }

  open(path: string, _flags: string, cb: (err: Error | null, handle?: Buffer) => void): void {
    if (!this.machine.files.has(path)) return this.later(() => cb(sftpError('No such file', path)))
    const id = String(this.nextHandle++)
    this.handles.set(id, path)
    this.later(() => cb(null, Buffer.from(id)))
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
    const data = path ? this.machine.files.get(path) : undefined
    if (!data) return this.later(() => cb(sftpError('No such file', path ?? '?'), 0))
    const n = Math.max(0, Math.min(len, data.length - position))
    data.copy(buf, off, position, position + n)
    this.later(() => cb(null, n))
  }

  close(handle: Buffer, cb: (err?: Error | null) => void): void {
    this.handles.delete(handle.toString())
    this.later(() => cb(null))
  }

  end(): void {
    this.emit('close')
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

  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const m = await this.acquire()
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
      m.track(channel)
      this.channels.add(channel)
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
    const m = await this.acquire()
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

  async sftp(): Promise<FakeSftp> {
    const m = await this.acquire()
    this.sftpCache ??= new FakeSftp(m)
    return this.sftpCache
  }

  resetSftp(): void {
    this.sftpCache = null
  }

  async forwardOut(): Promise<never> {
    throw new Error('harness: forwardOut (the VNC tunnel) is not faked')
  }

  /** Like ending the real client: every command still running on it ends (see the header). */
  close(): void {
    this.closed = true
    this.sftpCache = null
    this.machine = null
    for (const c of [...this.channels]) c.drop()
  }
}
