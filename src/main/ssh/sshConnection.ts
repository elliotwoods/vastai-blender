/**
 * Pooled ssh2 connection per node: one authenticated TCP connection carrying
 * multiplexed channels (exec for control/log-tail, SFTP for transfers, and
 * forwardOut for the VNC tunnel). Handles keepalive, reconnection with
 * backoff, and TOFU host-key pinning (vast machines churn — the pin is per
 * instance, stored by the caller).
 */

import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { posix } from 'path'

export interface SshTarget {
  host: string
  port: number
  username: string
  privateKey: Buffer
  /** Previously pinned host key hash (base64 sha256); null on first connect. */
  pinnedHostKey: string | null
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ExecOptions {
  /**
   * A deadline for the whole call: connecting, opening the channel (on a
   * wedged connection the open itself can go unanswered for good) and
   * running the command. When it passes, the channel is closed and the call
   * fails with ExecTimeoutError — for execStream, `done` rejects with it.
   */
  timeoutMs?: number
  /**
   * What errors call the command. They never quote the command line, which
   * can carry credentials: Octane's sign-in did, and a timed-out server start
   * put them in the dispatch-failed alert. Without a label, an error names
   * only the program the command runs (see describeCommand).
   */
  label?: string
  /**
   * Written to the command's stdin once its channel opens, and stdin then
   * closed (exec only). For a secret the command reads (`IFS= read -r`):
   * Octane's VNC password and a scripted OTOY sign-in (plan 1.18), which the
   * command line and the process list must never show. Without it stdin is
   * left as ssh2 opens it.
   */
  stdin?: string
}

export class HostKeyMismatchError extends Error {
  constructor(
    public readonly actual: string,
    public readonly pinned: string
  ) {
    super('SSH host key mismatch — possible machine change or MITM')
  }
}

/** An exec or execStream still running (or still opening) at its deadline. */
export class ExecTimeoutError extends Error {
  constructor(
    kind: 'exec' | 'execStream',
    readonly label: string,
    readonly timeoutMs: number
  ) {
    super(`${kind} timeout after ${timeoutMs}ms: ${label}`)
  }
}

/** An SFTP channel open that was not answered within the caller's timeout. */
export class SftpOpenTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`SFTP channel open timed out after ${timeoutMs}ms`)
  }
}

/** An SFTP channel open in flight, and how to fail everyone waiting on it. */
interface SftpOpening {
  promise: Promise<SFTPWrapper>
  abandon: (e: Error) => void
}

function hashKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64')
}

/** End a channel that may already be closing (ssh2's end() is a no-op then). */
function endQuietly(s: { end(): void } | null | undefined): void {
  try {
    s?.end()
  } catch {
    // already closed
  }
}

/**
 * How an error may name a command: its label, or else the program it runs
 * (`cat`, `bash`, `blender`) when it starts with a plain word or path.
 * Anything else — an environment assignment, a quoted word — is "command".
 */
export function describeCommand(command: string, label?: string): string {
  if (label) return label
  const first = command.trimStart().split(/\s+/, 1)[0] ?? ''
  return /^[\w./-]+$/.test(first) ? posix.basename(first) : 'command'
}

/**
 * Events: 'connected', 'disconnected', 'hostKey' (first-seen hash to pin).
 */
export class SshConnection extends EventEmitter {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null
  private closed = false
  private seenHostKey: string | null = null
  private sftpCache: SFTPWrapper | null = null
  /** The SFTP channel open in flight, if any (see sftp()). */
  private sftpOpening: SftpOpening | null = null
  /**
   * Bumped whenever the channel cached or being opened is given up on (a
   * reset, a timed-out open, close()). An open that completes under an older
   * generation is wanted by no one: it is ended, never cached.
   */
  private sftpGeneration = 0

  constructor(private target: SshTarget) {
    super()
  }

  /** Update endpoint (e.g. direct → proxy fallback) for the next connect. */
  setTarget(target: SshTarget): void {
    this.target = target
  }

  get hostKeyHash(): string | null {
    return this.seenHostKey
  }

  private connectOnce(): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const c = new Client()
      const cfg: ConnectConfig = {
        host: this.target.host,
        port: this.target.port,
        username: this.target.username,
        privateKey: this.target.privateKey,
        readyTimeout: 20_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const h = hashKey(key)
          this.seenHostKey = h
          if (this.target.pinnedHostKey && this.target.pinnedHostKey !== h) {
            // Signal verification failure — connection errors out.
            return false
          }
          this.emit('hostKey', h)
          return true
        }
      }
      c.once('ready', () => {
        this.emit('connected')
        resolve(c)
      })
      c.once('error', (err) => {
        if (
          this.target.pinnedHostKey &&
          this.seenHostKey &&
          this.seenHostKey !== this.target.pinnedHostKey
        ) {
          reject(new HostKeyMismatchError(this.seenHostKey, this.target.pinnedHostKey))
        } else {
          reject(err)
        }
      })
      c.on('close', () => {
        if (this.client === c) {
          this.client = null
          this.sftpCache = null
          this.emit('disconnected')
        }
      })
      c.connect(cfg)
    })
  }

  /** Get the live client, connecting (once) if needed. */
  async acquire(): Promise<Client> {
    if (this.closed) throw new Error('connection closed')
    if (this.client) return this.client
    if (!this.connecting) {
      this.connecting = this.connectOnce()
        .then((c) => {
          this.client = c
          return c
        })
        .finally(() => {
          this.connecting = null
        })
    }
    return this.connecting
  }

  /**
   * Reconnect with exponential backoff (5s → 60s) for up to `budgetMs`.
   * Resolves when connected; rejects when the budget is exhausted or the
   * connection is closed.
   */
  async reconnectWithBackoff(budgetMs = 10 * 60_000): Promise<void> {
    const start = Date.now()
    let delay = 5_000
    for (;;) {
      if (this.closed) throw new Error('connection closed')
      try {
        await this.acquire()
        return
      } catch (e) {
        if (e instanceof HostKeyMismatchError) throw e
        if (Date.now() - start + delay > budgetMs) {
          throw new Error(`reconnect budget exhausted: ${(e as Error).message}`)
        }
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  /**
   * Open an exec channel, retrying on "Channel open failure" — the server
   * caps concurrent channels (OpenSSH MaxSessions ≈ 10) and with many
   * concurrent chunk runs the cap is hit transiently; a short backoff and
   * retry rides out the burst instead of failing the operation.
   */
  private execChannel(
    c: Client,
    command: string,
    cb: (err: Error | undefined, stream: ClientChannel) => void,
    /** The caller has given up (its deadline passed): stop retrying. */
    abandoned: () => boolean,
    attempt = 0
  ): void {
    c.exec(command, (err, stream) => {
      if (err && /channel open failure/i.test(err.message) && attempt < 4 && !abandoned()) {
        setTimeout(
          () =>
            abandoned()
              ? cb(err, stream)
              : this.execChannel(c, command, cb, abandoned, attempt + 1),
          1500 * (attempt + 1)
        )
        return
      }
      cb(err ?? undefined, stream)
    })
  }

  /** Run a command to completion, capturing output. */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const label = describeCommand(command, opts.label)
    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      let stream: ClientChannel | null = null
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        finish()
      }
      if (opts.timeoutMs) {
        const ms = opts.timeoutMs
        // From the call, not from the channel opening: an open that is never
        // answered used to leave this waiting with no deadline at all.
        timer = setTimeout(
          () =>
            settle(() => {
              stream?.close()
              reject(new ExecTimeoutError('exec', label, ms))
            }),
          ms
        )
      }
      this.acquire().then(
        (c) => {
          if (settled) return
          this.execChannel(
            c,
            command,
            (err, s) => {
              if (err) return settle(() => reject(err))
              // Opened after the deadline: nobody is waiting for it.
              if (settled) return s.close()
              stream = s
              let stdout = ''
              let stderr = ''
              s.on('data', (d: Buffer) => {
                stdout += d.toString()
              })
              s.stderr.on('data', (d: Buffer) => {
                stderr += d.toString()
              })
              // ssh2 closes a channel whose connection went with no exit
              // status at all (undefined), and one a signal killed with null:
              // both are "no answer", passed on as null, which every caller
              // reads as such (provisioner's exitStatus; n4 review).
              s.on('close', (code: number | null | undefined) =>
                settle(() => resolve({ code: code ?? null, stdout, stderr }))
              )
              if (opts.stdin !== undefined) s.end(opts.stdin)
            },
            () => settled
          )
        },
        (e: Error) => settle(() => reject(e))
      )
    })
  }

  /**
   * Run a long-lived command, invoking `onLine` per stdout line. Returns a
   * stop() function; `done` resolves with the exit code when the stream ends
   * (or stop() is called).
   *
   * With `timeoutMs`, a command still running at the deadline is closed and
   * `done` rejects with ExecTimeoutError (the call itself rejects if the
   * channel never opened). Provisioning had no deadline at all: a stalled
   * download on the node left it 'provisioning', and billing, for good.
   */
  async execStream(
    command: string,
    onLine: (line: string) => void,
    opts: ExecOptions = {}
  ): Promise<{ stop: () => void; done: Promise<number | null> }> {
    const label = describeCommand(command, opts.label)
    return new Promise((resolve, reject) => {
      let expired = false
      let timer: NodeJS.Timeout | null = null
      /** Set once the channel is open: fails `done` at the deadline. */
      let expire: ((e: Error) => void) | null = null
      if (opts.timeoutMs) {
        const ms = opts.timeoutMs
        timer = setTimeout(() => {
          expired = true
          const err = new ExecTimeoutError('execStream', label, ms)
          if (expire) expire(err)
          else reject(err)
        }, ms)
      }
      const fail = (e: Error): void => {
        if (timer) clearTimeout(timer)
        reject(e)
      }
      this.acquire().then((c) => {
        if (expired) return
        this.execChannel(
          c,
          command,
          (err, stream) => {
            if (expired) {
              if (!err) stream.close()
              return
            }
            if (err) return fail(err)
            let buf = ''
            stream.on('data', (d: Buffer) => {
              buf += d.toString()
              for (;;) {
                const i = buf.indexOf('\n')
                if (i < 0) break
                onLine(buf.slice(0, i).replace(/\r$/, ''))
                buf = buf.slice(i + 1)
              }
            })
            const done = new Promise<number | null>((res, rej) => {
              expire = (e) => {
                rej(e)
                stream.close()
              }
              stream.on('close', (code: number | null | undefined) => {
                if (timer) clearTimeout(timer)
                if (buf) onLine(buf)
                // As exec: no exit status at all is null.
                res(code ?? null)
              })
            })
            // A caller that never awaits `done` (the log tail) must not turn
            // a deadline into an unhandled rejection; one that does still
            // sees it.
            done.catch(() => {})
            resolve({ stop: () => stream.close(), done })
          },
          () => expired
        )
      }, fail)
    })
  }

  /**
   * One cached SFTP channel per connection — SFTP multiplexes transfers over
   * a single channel, and SSH servers cap concurrent channels (opening one
   * per transfer exhausts the cap and gets "Channel open failure").
   *
   * Fetch it right before each request and never hold on to it across an
   * await: once it is reset, ssh2 silently drops every request made on it
   * (see withSftp in sftp.ts).
   *
   * With `timeoutMs`, an open that is not answered in time is given up on:
   * this call rejects with SftpOpenTimeoutError, and so does every other
   * caller waiting on the same open, and the next sftp() tries a fresh one.
   * Without that, every retry waited on the same hung open, and a caller
   * with no timeout of its own waited for good.
   */
  async sftp(opts: { timeoutMs?: number } = {}): Promise<SFTPWrapper> {
    if (this.sftpCache) return this.sftpCache
    const opening = this.sftpOpening ?? this.openSftp()
    const ms = opts.timeoutMs
    if (!ms) return opening.promise
    return new Promise<SFTPWrapper>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new SftpOpenTimeoutError(ms)
        this.abandonSftpOpen(opening, err)
        reject(err)
      }, ms)
      opening.promise.then(
        (s) => {
          clearTimeout(timer)
          resolve(s)
        },
        (e: unknown) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }

  private openSftp(): SftpOpening {
    const generation = this.sftpGeneration
    let abandon!: (e: Error) => void
    const promise = new Promise<SFTPWrapper>((resolve, reject) => {
      abandon = reject
      void (async () => {
        const c = await this.acquire()
        const sftp = await new Promise<SFTPWrapper>((res, rej) => {
          c.sftp((err, s) => (err ? rej(err) : res(s)))
        })
        if (generation !== this.sftpGeneration || this.closed) {
          // Given up on while it opened (a reset, a timed-out open, close()):
          // everyone who wanted it has moved on, and a channel nobody tracks
          // would only hold one of the server's few session slots.
          endQuietly(sftp)
          throw new Error('SFTP channel given up on while it opened')
        }
        const forget = (): void => {
          if (this.sftpCache === sftp) this.sftpCache = null
        }
        sftp.on('close', forget)
        // ssh2 emits 'error' on the wrapper when the node's sftp-server
        // breaks the protocol (doFatalSFTPError). With no listener that throws
        // out of a socket callback, which takes the main process down mid-render.
        sftp.on('error', () => {
          forget()
          endQuietly(sftp)
        })
        this.sftpCache = sftp
        return sftp
      })().then(resolve, reject)
    })
    const opening: SftpOpening = { promise, abandon }
    this.sftpOpening = opening
    const settled = (): void => {
      if (this.sftpOpening === opening) this.sftpOpening = null
    }
    promise.then(settled, settled)
    return opening
  }

  /** Fail everyone waiting on this open, and make sure it is never cached. */
  private abandonSftpOpen(opening: SftpOpening, err: Error): void {
    if (this.sftpOpening !== opening) return // already answered, or already given up on
    this.sftpGeneration++
    this.sftpOpening = null
    opening.abandon(err)
  }

  /**
   * Give up on an SFTP channel so the next sftp() opens a fresh one.
   *
   * For a transfer that stalled: a wedged SFTP channel never answers again,
   * and every later transfer queued on it would hang behind it. Ending it also
   * errors out whatever else was in flight on it, which is what we want — they
   * are retried on the new channel. If the whole TCP connection is dead, the
   * keepalive closes it and acquire() reconnects.
   *
   * Pass the channel that failed: only that one is ended. A wedge stalls every
   * transfer on the channel at once, and their watchdogs fire seconds apart;
   * by the second, the cache already held the fresh channel the first reset
   * made room for. Ending whatever was cached then ended that one too, failing
   * every transfer, upload and spec write on it, and the next watchdog the
   * one after (#245). With no argument, whatever is cached is ended and an
   * open in flight is given up on.
   */
  resetSftp(stale?: SFTPWrapper): void {
    if (stale) {
      if (this.sftpCache === stale) {
        this.sftpGeneration++
        this.sftpCache = null
      }
      endQuietly(stale)
      return
    }
    this.sftpGeneration++
    const s = this.sftpCache
    this.sftpCache = null
    if (this.sftpOpening) {
      this.abandonSftpOpen(this.sftpOpening, new Error('SFTP channel reset while it opened'))
    }
    endQuietly(s)
  }

  /** Open a forwarded TCP channel (for the VNC tunnel). */
  async forwardOut(dstHost: string, dstPort: number): Promise<NodeJS.ReadWriteStream> {
    const c = await this.acquire()
    return new Promise((resolve, reject) => {
      c.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) =>
        err ? reject(err) : resolve(stream)
      )
    })
  }

  close(): void {
    this.closed = true
    this.sftpGeneration++
    this.sftpCache = null
    if (this.sftpOpening) this.abandonSftpOpen(this.sftpOpening, new Error('connection closed'))
    this.client?.end()
    this.client = null
  }
}
