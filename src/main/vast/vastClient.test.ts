import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Plan 1.6: the Vast client itself, against a scripted fetch. The lifecycle
// harness replaces this module wholesale (fakeVast.ts is the server there),
// so what request() does around each call is pinned here: a deadline on
// every request, retries of what is safe to repeat on what says nothing
// about the request, never a second PUT /asks, and a typed failure.
//
// Field cases behind it: one 5xx or network blip during a boot's status poll
// destroyed a healthy node and blacklisted its machine (#39 #236); a create
// whose reply was lost was recorded as "not rented" while the instance billed
// (#223 #231); a request with no deadline held up scale-up and destroys for
// undici's ~300 s (#39).

const KEY = vi.hoisted(() => '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
vi.mock('../settings', () => ({ getSecret: () => KEY }))

import {
  createInstance,
  destroyInstance,
  listInstances,
  registerSshKey,
  searchOffers,
  showInstance,
  VastError,
  type CreateInstanceOptions,
  type VastErrorKind
} from './vastClient'

/** What the scripted server answers next: a reply, or what fetch throws. */
type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error

interface Call {
  url: string
  init: RequestInit
  at: number
}

let replies: Reply[] = []
let calls: Call[] = []

beforeEach(() => {
  replies = []
  calls = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  // Jitter at its middle: the backoff is exactly 2, 4, 8, 15, 15 s.
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init, at: Date.now() })
    const r = replies.shift()
    if (!r) throw new Error('test: no reply scripted')
    if (r instanceof Error) throw r
    return new Response(r.body ?? '', { status: r.status, headers: r.headers })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body) })

/** Node's system error, as undici puts it in fetch's cause. */
const sysErr = (message: string, code: string, syscall: string): Error =>
  Object.assign(new Error(message), { code, syscall })

/** What fetch throws when the connection drops: undici's "fetch failed", reason in the cause. */
const dropped = (): Error =>
  new TypeError('fetch failed', { cause: sysErr('read ECONNRESET', 'ECONNRESET', 'read') })

/** fetch when the name does not resolve: nothing was sent. */
const noDns = (): Error =>
  new TypeError('fetch failed', {
    cause: sysErr('getaddrinfo ENOTFOUND console.vast.ai', 'ENOTFOUND', 'getaddrinfo')
  })

/** fetch when AbortSignal.timeout fires. */
const timedOut = (): Error =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError')

/** Run a call to its end on the fake clock: every backoff it sleeps falls due. */
async function run<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const out: { value?: T; error?: unknown } = {}
  const done = p.then(
    (value) => void (out.value = value),
    (error) => void (out.error = error)
  )
  await vi.runAllTimersAsync()
  await done
  return out
}

function failure(r: { error?: unknown }): VastError {
  expect(r.error).toBeInstanceOf(VastError)
  return r.error as VastError
}

const createOpts: CreateInstanceOptions = {
  offerId: 31337,
  image: 'vastai/base-image:test',
  diskGb: 50,
  onstart: 'true',
  env: {},
  label: 'vastai-blender 1234abcd'
}

describe('every request (plan 1.6)', () => {
  it('carries the key as a Bearer header and has a deadline (#39)', async () => {
    replies.push(json(200, { instances: [] }))
    await expect(run(listInstances())).resolves.toEqual({ value: [] })
    const [call] = calls
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(call.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a read that meets a 5xx or a dropped connection is asked again (#39 #236)', async () => {
    replies.push({ status: 502, body: 'bad gateway' }, dropped(), json(200, { id: 7 }))
    const r = await run(showInstance(7))
    expect(r.error).toBeUndefined()
    expect(r.value).toMatchObject({ id: 7 })
    expect(calls).toHaveLength(3)
    // Backed off between tries, not hammered.
    expect(calls[1].at - calls[0].at).toBe(2_000)
    expect(calls[2].at - calls[1].at).toBe(4_000)
  })

  it('a 429 waits at least its Retry-After before asking again', async () => {
    replies.push({ status: 429, headers: { 'Retry-After': '9' } }, json(200, { instances: [] }))
    await run(listInstances())
    expect(calls).toHaveLength(2)
    expect(calls[1].at - calls[0].at).toBe(9_000)
  })

  it('a name that does not resolve is asked again: the network may be coming up', async () => {
    replies.push(noDns(), json(200, { instances: [] }))
    await expect(run(listInstances())).resolves.toEqual({ value: [] })
    expect(calls).toHaveLength(2)
  })

  it('stops retrying within its budget, and the last failure comes back typed', async () => {
    for (let i = 0; i < 20; i++) replies.push({ status: 503, body: 'service unavailable' })
    const e = failure(await run(listInstances()))
    expect(e.status).toBe(503)
    expect(e.kind).toBe('unknown')
    expect(e.message).toContain('503')
    expect(calls).toHaveLength(5)
    expect(calls.at(-1)!.at - calls[0].at).toBeLessThanOrEqual(30_000)
  })

  it('a refusal is not asked again: a 401 is the key, a 404 is gone', async () => {
    replies.push({ status: 401, body: 'bad key' })
    expect(failure(await run(listInstances())).kind).toBe('auth')
    expect(calls).toHaveLength(1)

    replies.push({ status: 404, body: '{"error":"no_such_instance"}' })
    expect(failure(await run(destroyInstance(9001))).kind).toBe('notFound')
    expect(calls).toHaveLength(2)

    replies.push({ status: 404, body: '{"error":"no_such_instance"}' })
    await expect(run(showInstance(9001))).resolves.toEqual({ value: null })
    expect(calls).toHaveLength(3)
  })

  it('a DELETE, an offer search and a key registration are retried like reads', async () => {
    replies.push({ status: 503 }, json(200, { success: true }))
    expect((await run(destroyInstance(9001))).error).toBeUndefined()
    replies.push(dropped(), json(200, { offers: [] }))
    await expect(run(searchOffers({}))).resolves.toEqual({ value: [] })
    // A second registration after a lost reply is "duplicate", which is done.
    replies.push({ status: 502 }, { status: 400, body: '{"error":"duplicate key"}' })
    expect((await run(registerSshKey('ssh-ed25519 AAAA'))).error).toBeUndefined()
    expect(calls.map((c) => c.init.method)).toEqual([
      'DELETE',
      'DELETE',
      'POST',
      'POST',
      'POST',
      'POST'
    ])
  })

  it('a timed-out request is a network failure of unknown outcome, and says so', async () => {
    replies.push(timedOut())
    const e = failure(await run(createInstance(createOpts)))
    expect(e.kind).toBe('unknown')
    expect(e.message).toMatch(/network error: no answer within 30 s \(timed out\)/)
  })

  it('an error never quotes the API key, from fetch or from Vast', async () => {
    replies.push(
      new TypeError(
        `Failed to parse URL from https://console.vast.ai/api/v0/asks/1/?api_key=${KEY}`
      )
    )
    const fromFetch = failure(await run(createInstance(createOpts)))
    replies.push({ status: 400, body: `{"error":"bad request","echo":"${KEY}"}` })
    const fromVast = failure(await run(createInstance(createOpts)))
    for (const e of [fromFetch, fromVast]) {
      expect(e.message).not.toContain(KEY.slice(0, 16))
      expect(String(e)).not.toContain(KEY.slice(0, 16))
    }
    expect(fromFetch.message).toContain('api_key=[redacted]')
  })
})

describe('createInstance: one PUT /asks, whatever comes back (plans 1.4, 1.6; #223 #231)', () => {
  const cases: Array<[what: string, reply: () => Reply, kind: VastErrorKind]> = [
    ['a 502 from the gateway', () => ({ status: 502, body: 'bad gateway' }), 'unknown'],
    ['a 504 after Vast took it', () => ({ status: 504, body: 'gateway timeout' }), 'unknown'],
    ['the connection dropped mid-request', dropped, 'unknown'],
    ['no answer within the deadline', timedOut, 'unknown'],
    ['a 200 that is not JSON', () => ({ status: 200, body: '<html>oops</html>' }), 'unknown'],
    ['a 200 with neither a contract nor a reason', () => json(200, {}), 'unknown'],
    ['a 429: refused before anything was done', () => ({ status: 429 }), 'transient'],
    ['a name that never resolved: nothing was sent', noDns, 'transient'],
    [
      'a 400: the offer is gone',
      () => json(400, { success: false, error: 'no_such_ask' }),
      'refused'
    ],
    [
      'a 200 that says no',
      () => json(200, { success: false, error: 'no_such_ask', msg: 'taken' }),
      'refused'
    ],
    [
      'a 400 for no credit',
      () => json(400, { success: false, error: 'insufficient_credit' }),
      'credit'
    ],
    ['a 401', () => ({ status: 401, body: 'bad key' }), 'auth']
  ]
  for (const [what, reply, kind] of cases) {
    it(`${what}: ${kind}, and never sent twice`, async () => {
      replies.push(reply(), json(200, { success: true, new_contract: 4242 }))
      const e = failure(await run(createInstance(createOpts)))
      expect(e.kind).toBe(kind)
      expect(calls).toHaveLength(1)
      expect(calls[0].init.method).toBe('PUT')
    })
  }

  it('a contract is the instance id', async () => {
    replies.push(json(200, { success: true, new_contract: 4242 }))
    await expect(run(createInstance(createOpts))).resolves.toEqual({ value: 4242 })
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ label: createOpts.label })
  })
})

describe('VastError', () => {
  it('is named, and takes its kind from classify unless told', () => {
    const gone = new VastError('vast.ai GET /instances/1/ → 404: {}', 404)
    expect(gone.name).toBe('VastError')
    expect(gone.kind).toBe('notFound')
    expect(new VastError('No Vast.ai API key configured').kind).toBe('auth')
    expect(new VastError('vast.ai PUT /asks/1/ → 402: pay', 402).kind).toBe('credit')
    expect(new VastError('network error: fetch failed', undefined, { kind: 'refused' }).kind).toBe(
      'refused'
    )
    const cause = sysErr('read ECONNRESET', 'ECONNRESET', 'read')
    const lost = new VastError('network error: fetch failed', undefined, { cause })
    expect(lost.cause).toBe(cause)
    expect(lost.kind).toBe('unknown')
  })
})
