/**
 * Pooled ssh2 connection per node: one authenticated TCP connection carrying
 * multiplexed channels (exec for control/log-tail, SFTP for transfers, and
 * forwardOut for the VNC tunnel). Handles keepalive, reconnection with
 * backoff, and TOFU host-key pinning (vast machines churn — the pin is per
 * instance, stored by the caller).
 */

import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'

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

export class HostKeyMismatchError extends Error {
  constructor(
    public readonly actual: string,
    public readonly pinned: string
  ) {
    super('SSH host key mismatch — possible machine change or MITM')
  }
}

function hashKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64')
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
  private sftpOpening: Promise<SFTPWrapper> | null = null

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

  /** Run a command to completion, capturing output. */
  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const c = await this.acquire()
    return new Promise<ExecResult>((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              if (!settled) {
                settled = true
                stream.close()
                reject(new Error(`exec timeout after ${opts.timeoutMs}ms: ${command.slice(0, 80)}`))
              }
            }, opts.timeoutMs)
          : null
        stream.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        stream.on('close', (code: number | null) => {
          if (timer) clearTimeout(timer)
          if (!settled) {
            settled = true
            resolve({ code, stdout, stderr })
          }
        })
      })
    })
  }

  /**
   * Run a long-lived command, invoking `onLine` per stdout line. Returns a
   * stop() function; the promise resolves with the exit code when the stream
   * ends (or stop() is called).
   */
  async execStream(
    command: string,
    onLine: (line: string) => void
  ): Promise<{ stop: () => void; done: Promise<number | null> }> {
    const c = await this.acquire()
    return new Promise((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) return reject(err)
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
        const done = new Promise<number | null>((res) => {
          stream.on('close', (code: number | null) => {
            if (buf) onLine(buf)
            res(code)
          })
        })
        resolve({ stop: () => stream.close(), done })
      })
    })
  }

  /**
   * One cached SFTP channel per connection — SFTP multiplexes transfers over
   * a single channel, and SSH servers cap concurrent channels (opening one
   * per transfer exhausts the cap and gets "Channel open failure").
   */
  async sftp(): Promise<SFTPWrapper> {
    if (this.sftpCache) return this.sftpCache
    if (this.sftpOpening) return this.sftpOpening
    this.sftpOpening = (async () => {
      const c = await this.acquire()
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        c.sftp((err, s) => (err ? reject(err) : resolve(s)))
      })
      sftp.on('close', () => {
        if (this.sftpCache === sftp) this.sftpCache = null
      })
      this.sftpCache = sftp
      return sftp
    })().finally(() => {
      this.sftpOpening = null
    })
    return this.sftpOpening
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
    this.sftpCache = null
    this.client?.end()
    this.client = null
  }
}
