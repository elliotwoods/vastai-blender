import { existsSync, readFileSync, statSync } from 'fs'
import { request, type IncomingMessage } from 'http'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type World } from '../test/harness'
import type { ApiServer } from './server'

// The local API (docs/API.md) on a real socket, port 0, in front of the real
// command layer: who may talk to it (auth.ts), what it takes, and a job's
// whole life over it.

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv'

let w: World
let server: ApiServer
beforeEach(async () => {
  w = await setup()
  await w.boot({ start: false })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { startApiServer } = await import('./server')
  const { runCommand } = await import('../commands/registry')
  const { onEvent } = await import('../events')
  server = await startApiServer({
    port: 0,
    run: runCommand,
    subscribe: onEvent,
    version: '9.9.9',
    token: TOKEN
  })
})
afterEach(async () => {
  await server.close()
  vi.restoreAllMocks()
  await w.dispose()
})

interface Reply {
  status: number
  headers: IncomingMessage['headers']
  body: { ok: boolean; value?: unknown; code?: string; message?: string }
}

interface CallOptions {
  body?: unknown
  raw?: string | Buffer
  headers?: Record<string, string>
  token?: string | null
}

function call(method: string, path: string, opts: CallOptions = {}): Promise<Reply> {
  const payload =
    opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)))
  const headers: Record<string, string> = {
    ...(opts.token === null ? {} : { Authorization: `Bearer ${opts.token ?? TOKEN}` }),
    ...(payload ? { 'Content-Type': 'application/json' } : {}),
    ...opts.headers
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text) })
      })
    })
    // A refused upload may be cut off mid-send; the answer is what counts.
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('who may talk to it', () => {
  it('401 with no token, or the wrong one', async () => {
    for (const token of [null, 'nope', `${TOKEN}x`, '']) {
      const r = await call('GET', '/v1/health', { token })
      expect(r.status).toBe(401)
      expect(r.body).toMatchObject({ ok: false, code: 'unauthorized' })
    }
    const scheme = await call('GET', '/v1/health', {
      token: null,
      headers: { Authorization: `Basic ${TOKEN}` }
    })
    expect(scheme.status).toBe(401)
  })

  it('answers with the token', async () => {
    const r = await call('GET', '/v1/health')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true,
      value: {
        app: 'vast-render',
        version: '9.9.9',
        pid: process.pid,
        startedAt: expect.any(Number)
      }
    })
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('403 for a Host that is not its own loopback address (DNS rebinding)', async () => {
    for (const host of ['evil.example:80', `evil.example:${server.port}`, `127.0.0.1:1`]) {
      const r = await call('GET', '/v1/health', { headers: { Host: host } })
      expect(r.status).toBe(403)
    }
    const local = await call('GET', '/v1/health', { headers: { Host: `localhost:${server.port}` } })
    expect(local.status).toBe(200)
  })

  it('403 for any request with an Origin, token or not, and no CORS headers', async () => {
    for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${server.port}`]) {
      const r = await call('POST', '/v1/jobs', { headers: { Origin: origin }, body: {} })
      expect(r.status).toBe(403)
      expect(r.body).toMatchObject({ code: 'forbidden' })
      expect(r.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect(w.all('SELECT id FROM jobs')).toEqual([])
  })
})

describe('what it takes', () => {
  it('413 for a body over 1 MB', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 0x20)
    const r = await call('POST', '/v1/jobs', { raw: big })
    expect(r.status).toBe(413)
    expect(r.body).toMatchObject({ ok: false, code: 'too_large' })
  })

  it('415 for a body that is not JSON; 400 for broken JSON', async () => {
    expect(
      (await call('POST', '/v1/jobs', { raw: 'a=1', headers: { 'Content-Type': 'text/plain' } }))
        .status
    ).toBe(415)
    expect((await call('POST', '/v1/jobs', { raw: '{"blends": [' })).status).toBe(400)
  })

  it('refuses a relative or network blend path, and submits nothing', async () => {
    for (const blends of [['scene.blend'], ['\\\\server\\share\\a.blend'], ['//server/a.blend']]) {
      const r = await call('POST', '/v1/jobs', { body: { blends } })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('bad_request')
    }
    expect(w.all('SELECT id FROM jobs')).toEqual([])
  })

  it('404 for an unknown route or job; 405 for the wrong method', async () => {
    expect((await call('GET', '/v1/nope')).status).toBe(404)
    expect((await call('GET', '/other')).status).toBe(404)
    expect((await call('GET', '/v1/jobs/missing')).body).toMatchObject({ code: 'not_found' })
    expect((await call('POST', '/v1/jobs/missing/cancel')).status).toBe(404)
    expect((await call('PUT', '/v1/jobs')).status).toBe(405)
    expect((await call('PATCH', '/v1/jobs/x', { body: { shareNode: 'yes' } })).status).toBe(400)
  })
})

describe("a job's life over the API", () => {
  it('submit → list → cancel → remove → restore', async () => {
    const blend = w.blend()
    const submitted = await call('POST', '/v1/jobs', {
      body: { blends: [blend], engine: 'cycles', frameStart: 1, frameEnd: 4, name: 'api job' }
    })
    expect(submitted.status).toBe(201)
    const { jobs } = submitted.body.value as { jobs: string[] }
    expect(jobs).toHaveLength(1)
    const [jobId] = jobs

    const listed = await call('GET', '/v1/jobs')
    expect(
      (listed.body.value as Array<{ id: string; name: string }>).map((j) => [j.id, j.name])
    ).toEqual([[jobId, 'api job']])
    expect((await call('GET', '/v1/queue')).body.value).toEqual([
      { position: 1, groupId: null, jobIds: [jobId] }
    ])
    expect((await call('GET', `/v1/jobs/${jobId}`)).body.value).toMatchObject({ id: jobId })

    // Still queued: the remove is refused until it is cancelled.
    const early = await call('DELETE', `/v1/jobs/${jobId}`)
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('active')

    expect((await call('POST', `/v1/jobs/${jobId}/cancel`)).status).toBe(200)
    expect(w.get('SELECT state FROM jobs WHERE id = ?', jobId)).toEqual({ state: 'cancelled' })
    expect((await call('DELETE', `/v1/jobs/${jobId}`)).status).toBe(200)
    expect((await call('GET', '/v1/jobs')).body.value).toEqual([])
    expect((await call('GET', '/v1/jobs?hidden=1')).body.value).toHaveLength(1)
    expect((await call('POST', `/v1/jobs/${jobId}/restore`)).status).toBe(200)
    expect((await call('GET', '/v1/jobs')).body.value).toHaveLength(1)
  })

  it('DELETE ?cancel=1 cancels a queued job first', async () => {
    const submitted = await call('POST', '/v1/jobs', {
      body: { blends: [w.blend()], engine: 'cycles', frameStart: 1, frameEnd: 4 }
    })
    const [jobId] = (submitted.body.value as { jobs: string[] }).jobs
    const r = await call('DELETE', `/v1/jobs/${jobId}?cancel=1`)
    expect(r.status).toBe(200)
    expect(
      w.get('SELECT state, hidden_at IS NOT NULL AS hidden FROM jobs WHERE id = ?', jobId)
    ).toEqual({
      state: 'cancelled',
      hidden: 1
    })
  })

  it('moves, groups and shares', async () => {
    const ids: string[] = []
    for (const name of ['a.blend', 'b.blend']) {
      const r = await call('POST', '/v1/jobs', {
        body: { blends: [w.blend(name)], engine: 'cycles', frameStart: 1, frameEnd: 4 }
      })
      ids.push(...(r.body.value as { jobs: string[] }).jobs)
    }
    const moved = await call('POST', `/v1/jobs/${ids[1]}/move`, { body: { before: ids[0] } })
    expect((moved.body.value as Array<{ jobIds: string[] }>).map((e) => e.jobIds)).toEqual([
      [ids[1]],
      [ids[0]]
    ])
    const grouped = await call('POST', `/v1/jobs/${ids[0]}/group`, { body: { withJobId: ids[1] } })
    expect(grouped.body.value).toEqual({ groupId: expect.any(String) })
    expect((await call('POST', `/v1/jobs/${ids[0]}/ungroup`)).status).toBe(200)
    expect((await call('PATCH', `/v1/jobs/${ids[0]}`, { body: { shareNode: true } })).status).toBe(
      200
    )
    expect(w.get('SELECT share_node FROM jobs WHERE id = ?', ids[0])).toEqual({ share_node: 1 })
  })

  it('fleet and cost', async () => {
    const fleet = await call('GET', '/v1/fleet')
    expect(fleet.body).toMatchObject({ ok: true, value: { nodes: [], holds: expect.any(Object) } })
    const cost = await call('GET', '/v1/fleet/cost')
    expect(cost.body).toMatchObject({ ok: true, value: { perHour: expect.any(Number) } })
  })
})

describe('/v1/events', () => {
  it('streams the bus events asked for', async () => {
    let submitting: Promise<Reply> | null = null
    const received = new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/v1/events?channels=job:changed',
          headers: { Authorization: `Bearer ${TOKEN}` }
        },
        (res) => {
          expect(res.statusCode).toBe(200)
          expect(res.headers['content-type']).toMatch(/^text\/event-stream/)
          let text = ''
          // Ended from this side, below.
          res.on('error', () => {})
          res.on('data', (c: Buffer) => {
            text += c.toString('utf-8')
            if (text.includes('event: job:changed\ndata: ')) {
              req.destroy()
              resolve(text)
            }
            // Once connected, something to hear (once).
            if (!submitting && text.includes(': connected')) {
              submitting = call('POST', '/v1/jobs', {
                body: { blends: [w.blend()], engine: 'cycles', frameStart: 1, frameEnd: 4 }
              })
            }
          })
        }
      )
      req.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e)
      })
      req.end()
    })
    const text = await received
    expect((await submitting!)?.status).toBe(201)
    const line = text.split('\n').find((l) => l.startsWith('data: '))
    expect(JSON.parse(line!.slice(6))).toMatchObject({ state: 'queued' })
  })

  it('refuses an unknown channel', async () => {
    const r = await call('GET', '/v1/events?channels=nope')
    expect(r.status).toBe(400)
  })
})

describe('ApiController: api.json', () => {
  it('written 0600 while running, gone when stopped', async () => {
    const { ApiController } = await import('./server')
    const { runCommand } = await import('../commands/registry')
    const { onEvent } = await import('../events')
    w.settings.apiEnabled = true
    const { getSettings } = await import('../settings')
    const api = new ApiController({
      userData: w.dir,
      getSettings,
      forced: false,
      run: runCommand,
      subscribe: onEvent,
      version: '1.0.0'
    })
    await api.sync()
    const file = join(w.dir, 'api.json')
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'))
    expect(onDisk).toEqual({
      version: 1,
      url: `http://127.0.0.1:${onDisk.port}`,
      port: expect.any(Number),
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      pid: process.pid,
      startedAt: expect.any(Number)
    })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(api.status()).toMatchObject({ running: true, port: onDisk.port })
    // Never in a log line.
    const logged = [
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls
    ].flat()
    expect(logged.join(' ')).not.toContain(onDisk.token)

    w.settings.apiEnabled = false
    await api.sync()
    expect(existsSync(file)).toBe(false)
    expect(api.status()).toMatchObject({ running: false })
  })
})
