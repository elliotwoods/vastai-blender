/**
 * The local HTTP API (docs/API.md): the app's jobs, queue and fleet for
 * scripts and the CLI (bin/vast-render-cli.mjs), on node:http, bound to
 * 127.0.0.1 only.
 *
 * Off unless Settings > General > Local API is on (settings apiEnabled), or
 * VR_API=1 forces it on for the session. The port is settings apiPort, 0 for
 * one the OS picks. Each start makes a new token and writes
 * <userData>/api.json:
 *
 *   { "version": 1, "url": "http://127.0.0.1:53817", "port": 53817,
 *     "token": "...", "pid": 4242, "startedAt": 1758850000000 }
 *
 * written whole (tmp + rename) and readable by the user alone (mode 0600),
 * and deleted when the server stops and when the app quits (lifecycle.ts).
 * Whoever can read that file can drive the app, as whoever can run the app
 * as the user can; nothing else can (auth.ts). The token is never logged.
 *
 * Requests: every body is JSON, at most 1 MB (413 past it, 415 for another
 * type), and every response is JSON with no CORS headers.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { join } from 'path'
import type { ApiServerStatus, SettingsPublic } from '../../shared/models'
import type { BusEvent } from '../events'
import { checkRequest, newToken } from './auth'
import { route, type RunCommand } from './routes'
import { openEventStream, parseChannels } from './sse'

/** Largest request body taken. */
export const MAX_BODY_BYTES = 1024 * 1024

export const API_FILE = 'api.json'

/** What api.json holds. */
export interface ApiFile {
  version: 1
  url: string
  port: number
  token: string
  pid: number
  startedAt: number
}

export interface ApiServerOptions {
  /** 0 = one the OS picks. */
  port: number
  run: RunCommand
  /** events.ts's onEvent. */
  subscribe(listener: (event: BusEvent) => void): () => void
  /** The app's version, for /v1/health. */
  version: string
  /** Made here when not given (tests pass their own). */
  token?: string
}

export interface ApiServer {
  url: string
  port: number
  token: string
  startedAt: number
  close(): Promise<void>
}

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(text)
}

/** The request's JSON body, or undefined when it has none. Throws HttpRefusal. */
function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Promise.reject(
      new HttpRefusal(413, 'too_large', `a request body may be at most ${MAX_BODY_BYTES} bytes`)
    )
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        reject(
          new HttpRefusal(413, 'too_large', `a request body may be at most ${MAX_BODY_BYTES} bytes`)
        )
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (e) => {
      if (!failed) reject(e)
      failed = true
    })
    req.on('end', () => {
      if (failed) return
      if (size === 0) return resolve(undefined)
      const type = String(req.headers['content-type'] ?? '')
      if (!/^application\/json\s*(;|$)/i.test(type)) {
        return reject(
          new HttpRefusal(415, 'bad_request', 'a request body must be application/json')
        )
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch {
        reject(new HttpRefusal(400, 'bad_request', 'the request body is not valid JSON'))
      }
    })
  })
}

function segmentsOf(pathname: string): string[] | null {
  if (!pathname.startsWith('/v1/') && pathname !== '/v1') return null
  try {
    return pathname
      .slice(4)
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s))
  } catch {
    return null
  }
}

/** Start the API on 127.0.0.1. Resolves once it is listening. */
export async function startApiServer(opts: ApiServerOptions): Promise<ApiServer> {
  const token = opts.token ?? newToken()
  const startedAt = Date.now()
  const streams = new Set<() => void>()
  let port = 0

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const refusal = checkRequest(req.headers, port, token)
    if (refusal) {
      // The body is not read; the connection goes with the answer.
      res.setHeader('Connection', 'close')
      return send(res, refusal.status, { ok: false, code: refusal.code, message: refusal.message })
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const segments = segmentsOf(url.pathname)
    if (!segments) {
      return send(res, 404, { ok: false, code: 'not_found', message: 'routes are under /v1' })
    }
    if (segments.length === 1 && segments[0] === 'events') {
      if (req.method !== 'GET') {
        return send(res, 405, { ok: false, code: 'bad_request', message: 'use GET' })
      }
      let channels
      try {
        channels = parseChannels(url.searchParams.get('channels'))
      } catch (e) {
        return send(res, 400, { ok: false, code: 'bad_request', message: (e as Error).message })
      }
      const end = openEventStream(req, res, { channels, subscribe: opts.subscribe })
      streams.add(end)
      req.on('close', () => streams.delete(end))
      return
    }
    let body: unknown
    try {
      body = await readBody(req)
    } catch (e) {
      if (e instanceof HttpRefusal) {
        res.setHeader('Connection', 'close')
        return send(res, e.status, { ok: false, code: e.code, message: e.message })
      }
      throw e
    }
    const answer = await route(
      { method: req.method ?? 'GET', segments, query: url.searchParams, body },
      { run: opts.run, version: opts.version, startedAt }
    )
    send(res, answer.status, answer.body)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('[api] request failed:', e)
      send(res, 500, { ok: false, code: 'internal', message: 'the request failed in the app' })
    })
  })
  // Slow or idle clients do not hold sockets for long; an event stream is
  // kept alive by its pings.
  server.requestTimeout = 60_000
  server.headersTimeout = 15_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: opts.port, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    startedAt,
    close: () =>
      new Promise<void>((resolve) => {
        for (const end of streams) end()
        streams.clear()
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
  }
}

/** Write api.json whole, readable by the user alone. */
export function writeApiFile(path: string, file: ApiFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 1) + '\n', { mode: 0o600 })
  // The mode above is filtered by the umask on some systems; this is not.
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** Delete api.json, when it is this server's (its token), so a newer one is left alone. */
export function removeApiFile(path: string, token: string): void {
  try {
    const on = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ApiFile>
    if (on.token !== token) return
    unlinkSync(path)
  } catch {
    // Gone already, or not ours to read.
  }
}

export interface ApiControllerDeps {
  userData: string
  getSettings(): SettingsPublic
  /** VR_API=1 forces the server on for the session. */
  forced: boolean
  run: RunCommand
  subscribe(listener: (event: BusEvent) => void): () => void
  version: string
}

/**
 * Starts and stops the API as the settings say (sync), and keeps api.json in
 * step. sync() calls are taken one at a time.
 */
export class ApiController {
  private server: ApiServer | null = null
  private error: string | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ApiControllerDeps) {}

  get file(): string {
    return join(this.deps.userData, API_FILE)
  }

  /** Bring the server in line with the settings (and VR_API). */
  sync(): Promise<void> {
    const next = this.queue.then(() => this.apply())
    this.queue = next.catch(() => {})
    return next
  }

  private async apply(): Promise<void> {
    const settings = this.deps.getSettings()
    const want = this.deps.forced || settings.apiEnabled === true
    const port = settings.apiPort ?? 0
    const running = this.server
    if (running && (!want || (port !== 0 && port !== running.port))) {
      await this.stop()
    }
    if (!want || this.server) return
    try {
      const server = await startApiServer({
        port,
        run: this.deps.run,
        subscribe: this.deps.subscribe,
        version: this.deps.version
      })
      this.server = server
      this.error = null
      writeApiFile(this.file, {
        version: 1,
        url: server.url,
        port: server.port,
        token: server.token,
        pid: process.pid,
        startedAt: server.startedAt
      })
      console.log(`[api] listening on ${server.url} (details in ${this.file})`)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      this.error =
        code === 'EADDRINUSE'
          ? `port ${port} is in use by another program`
          : `could not start: ${(e as Error)?.message ?? e}`
      console.error(`[api] ${this.error}`)
      if (this.server) await this.stop()
    }
  }

  private async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    removeApiFile(this.file, server.token)
    await server.close()
    console.log('[api] stopped')
  }

  /**
   * On the way out (lifecycle.ts finish, process exit): api.json goes at
   * once, synchronously; the server closes with the process.
   */
  stopNow(): void {
    const server = this.server
    if (!server) return
    this.server = null
    removeApiFile(this.file, server.token)
    void server.close()
  }

  status(): ApiServerStatus {
    const s = this.server
    return {
      running: s !== null,
      forced: this.deps.forced,
      file: this.file,
      ...(s ? { url: s.url, port: s.port } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }
}
