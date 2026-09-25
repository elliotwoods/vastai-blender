/**
 * A stand-in for the ssh2 module itself, for testing the real SshConnection
 * (the lifecycle harness replaces SshConnection wholesale with
 * FakeSshConnection, so nothing there exercises it).
 *
 *   vi.mock('ssh2', () => import('../test/fakeSsh2'))
 *   import { ssh2 } from '../test/fakeSsh2'   // the "server": script and inspect it
 *   beforeEach(() => ssh2.reset())
 *
 * It answers as ssh2 1.17 does where SshConnection depends on it:
 *
 * - A channel open (exec, sftp) is answered on a microtask — or never, while
 *   `ssh2.holdOpens` is set: a wedged connection leaves opens unanswered, and
 *   nothing but a deadline of the app's own ends the wait. `ssh2.releaseOpens()`
 *   answers the held ones late, as a connection that un-wedges would.
 * - `end()` on an SFTP channel only starts closing it (SFTP.js destroy():
 *   state 'closing', CHANNEL_CLOSE sent). A request made after that is
 *   registered and never sent, so never answered. The requests pending at
 *   that point fail with "No response from server", and 'end' and 'close'
 *   are emitted, only when the server acknowledges the close:
 *   `channel.serverClose()` (cleanupRequests on push(null)).
 * - A server that breaks the SFTP protocol gets 'error' emitted on the
 *   wrapper (doFatalSFTPError): `channel.fatal()`. With no listener, that
 *   throws, as EventEmitter does.
 * - An exec channel ends with 'close' (exit code) when its command exits
 *   (`channel.exit(code)`), or when the app closes it (`close()`, answered on
 *   a microtask with exit code undefined).
 */

import { EventEmitter } from 'events'

type OpenCb<T> = (err: Error | undefined, channel: T) => void

function noResponse(): Error {
  return new Error('No response from server')
}

/** An exec channel: one command running on the fake server. */
export class FakeExecChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  closed = false
  /** close() calls the app made on it. */
  closeCalls = 0
  /** What the app wrote to the command's stdin, and whether it closed it (end()). */
  stdin = ''
  stdinEnded = false

  constructor(readonly command: string) {
    super()
  }

  /** ssh2's Channel.end(data): write the command's stdin, then close it. */
  end(data?: string | Buffer): void {
    if (data != null) this.stdin += data.toString()
    this.stdinEnded = true
  }

  /** The command prints to stdout. */
  write(text: string): void {
    this.emit('data', Buffer.from(text, 'utf-8'))
  }

  /** The command exits. */
  exit(code: number | null | undefined): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', code)
  }

  /** ssh2's Channel.close(): the server acknowledges, and it closes with no exit code. */
  close(): void {
    this.closeCalls++
    queueMicrotask(() => this.exit(undefined))
  }
}

/** A request an SFTP channel sent and is waiting on. */
interface SftpRequest {
  path: string
  cb: (err: Error | null, value?: unknown) => void
}

/** An SFTP channel, as far as SshConnection and a request or two go. */
export class FakeSftpChannel extends EventEmitter {
  /** ssh2's outgoing.state. */
  state: 'open' | 'closing' | 'closed' = 'open'
  /** Sent, not yet answered. */
  readonly pending: SftpRequest[] = []
  /** Made once the channel was closing: registered, never sent (SFTP.js tryWritePayload). */
  readonly dropped: SftpRequest[] = []
  /** end() calls the app made on it. */
  endCalls = 0

  /** Any request will do for a test: stat is the simplest. */
  stat(path: string, cb: (err: Error | null, value?: unknown) => void): void {
    const req = { path, cb }
    if (this.state === 'open') this.pending.push(req)
    else this.dropped.push(req)
  }

  /** Answer every pending request (a healthy channel catching up). */
  answerAll(): void {
    for (const req of this.pending.splice(0)) req.cb(null, { size: 1 })
  }

  /** ssh2's end(): start closing. Nothing is failed or emitted until serverClose(). */
  end(): void {
    this.endCalls++
    if (this.state === 'open') this.state = 'closing'
  }

  /** The server's CLOSE arrives (or the connection goes): pending requests fail, 'end' and 'close'. */
  serverClose(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    const err = noResponse()
    for (const req of this.pending.splice(0)) req.cb(err)
    this.emit('end')
    this.emit('close')
  }

  /** A protocol violation from the server's sftp-server (doFatalSFTPError). */
  fatal(message = 'Invalid packet length'): void {
    this.emit('error', new Error(message))
  }
}

/** The fake server every FakeClient connects to. Reset it between tests. */
export class FakeSsh2 {
  readonly clients: Client[] = []
  readonly execs: FakeExecChannel[] = []
  readonly sftps: FakeSftpChannel[] = []
  /** Leave channel opens unanswered (a wedged connection) until releaseOpens(). */
  holdOpens = false
  private held: Array<() => void> = []

  reset(): void {
    this.clients.length = 0
    this.execs.length = 0
    this.sftps.length = 0
    this.holdOpens = false
    this.held = []
  }

  /** Answer every open held so far, late. */
  releaseOpens(): void {
    for (const answer of this.held.splice(0)) answer()
  }

  /** @internal a channel open: answered now (on a microtask) or held */
  open(answer: () => void): void {
    if (this.holdOpens) this.held.push(answer)
    else queueMicrotask(answer)
  }

  /** The exec channels opened for commands matching `pattern`. */
  execsOf(pattern: RegExp): FakeExecChannel[] {
    return this.execs.filter((e) => pattern.test(e.command))
  }
}

export const ssh2 = new FakeSsh2()

/** ssh2's Client, as SshConnection uses it. */
export class Client extends EventEmitter {
  ended = false

  constructor() {
    super()
    ssh2.clients.push(this)
  }

  connect(cfg: { hostVerifier?: (key: Buffer) => boolean }): void {
    queueMicrotask(() => {
      if (cfg.hostVerifier && !cfg.hostVerifier(Buffer.from('fake host key'))) {
        this.emit('error', new Error('Host denied (verification failed)'))
        return
      }
      this.emit('ready')
    })
  }

  exec(command: string, cb: OpenCb<FakeExecChannel>): void {
    const channel = new FakeExecChannel(command)
    ssh2.open(() => {
      ssh2.execs.push(channel)
      cb(undefined, channel)
    })
  }

  sftp(cb: OpenCb<FakeSftpChannel>): void {
    ssh2.open(() => {
      const channel = new FakeSftpChannel()
      ssh2.sftps.push(channel)
      cb(undefined, channel)
    })
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    queueMicrotask(() => this.emit('close'))
  }
}
