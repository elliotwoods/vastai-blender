/**
 * Vast.ai REST client. Payload shapes mirror the official `vast.py` CLI (the
 * docs lag the CLI — when in doubt, that's the reference).
 *
 * Auth goes both as a Bearer header and as the legacy `api_key` query param.
 * Vast's API reference says every endpoint takes `Authorization: Bearer`, and
 * vast-cli sends the header, so the query param is probably redundant (it
 * puts the key in proxy and server logs, #152). It stays until a Bearer-only
 * build has been run against the live API (plan 1.6): were any endpoint to
 * refuse Bearer alone, a DELETE refused with 401 would leave an instance
 * billing that the app believes it can destroy. Error text never carries the
 * URL, and anything quoted back from fetch or from Vast has the key scrubbed.
 *
 * Every request has a deadline (REQUEST_TIMEOUT_MS). One that is safe to send
 * again (`idempotent`) is retried with jittered backoff on anything that says
 * nothing about the request's own merits: a network error, a timeout, a 5xx,
 * a 429. Creating an instance (PUT /asks) never is: its reply may have been
 * lost after Vast rented the instance, and a second PUT would rent another
 * (plan 1.4). Every failure is a VastError whose `kind` says what it means
 * for the request (VastErrorKind), decided by errors.ts's classify so that
 * the rent, destroy and dispatch paths all read an error the same way.
 */

import { classify } from '../errors'
import { getSecret } from '../settings'
import type { RawInstance, RawOffer, VastUser } from './types'

const BASE = 'https://console.vast.ai/api/v0'

/**
 * The longest one request may take, reply body included. Without it a hung
 * request waited out undici's own ~300 s header timeout on every attempt,
 * and held up whatever was waiting on it: a boot's deadline check, the
 * scheduler's one scale-up batch at a time, a destroy (#39 #223).
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * No retry of a request starts once this much time has gone on it, its
 * backoff included. Enough to ride out a burst of 429s or a blip; a longer
 * outage is its callers' to wait out, each on its own terms (a boot's
 * 8-minute deadline, a destroy's budget, the create lookup's minute). The
 * backoff doubles from RETRY_FIRST_DELAY_MS to RETRY_MAX_DELAY_MS, each wait
 * ±25% jitter, or a longer Retry-After. Exported for tests that model the
 * client in front of a fake Vast.
 */
export const RETRY_BUDGET_MS = 30_000
export const RETRY_FIRST_DELAY_MS = 2_000
export const RETRY_MAX_DELAY_MS = 15_000

/**
 * What a failed request says about itself, for deciding what to do next:
 *
 *   refused    Vast said no to this request (a 4xx, or a create reply that
 *              gives Vast's reason and no contract). Nothing was done, and
 *              asking again gets the same answer; another offer may not.
 *   unknown    No answer that says what happened: a 5xx, a timeout, the
 *              connection failing mid-request, a reply that is not JSON, a
 *              create reply with neither a contract nor a reason. Vast may
 *              have done it. A read is safe to ask again; a create may have
 *              rented an instance nobody knows the id of (plan 1.4).
 *   transient  Nothing was done, and asking again later may work: a 429 (Vast
 *              rate-limits before acting), a name that did not resolve.
 *   auth       The API key: none configured, rejected (401), refused (403).
 *   credit     The balance: insufficient credit, or 402.
 *   notFound   404 or 410: the instance or offer is not there (a DELETE of an
 *              instance already gone, for one).
 */
export type VastErrorKind = 'refused' | 'unknown' | 'auth' | 'credit' | 'notFound' | 'transient'

/**
 * The VastErrorKind of any error from a Vast call, a VastError or not (a
 * test's stand-in, a wrapper that kept only the message), by errors.ts's
 * classify.
 */
export function vastErrorKind(e: unknown): VastErrorKind {
  const c = classify(e, { via: 'vast' })
  if (c.rule === 'vast-gone') return 'notFound'
  if (c.rule === 'vast-credit' || c.rule === 'vast-402') return 'credit'
  if (c.kind === 'account') return 'auth'
  if (c.outcomeUnknown) return 'unknown'
  if (c.kind === 'transient') return 'transient'
  return 'refused'
}

export class VastError extends Error {
  override readonly name = 'VastError'
  /** What the failure means for the request: see VastErrorKind. */
  readonly kind: VastErrorKind

  constructor(
    message: string,
    public readonly status?: number,
    /**
     * `cause`: what fetch threw, so classify can read its errno and tell a
     * name that never resolved (nothing sent) from a connection lost
     * mid-request. `kind` is classify's unless given.
     */
    opts: { cause?: unknown; kind?: VastErrorKind } = {}
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.kind = opts.kind ?? vastErrorKind(this)
  }
}

function apiKey(): string {
  const key = getSecret('vastApiKey')
  if (!key) throw new VastError('No Vast.ai API key configured')
  return key
}

/** `text` without the API key in it, wherever Vast or fetch quoted it. */
function scrub(text: string, key: string): string {
  return text.split(key).join('[redacted]')
}

/**
 * What fetch threw, as a VastError's cause may keep it: each error of the
 * chain copied with its name, errno fields and a scrubbed message. classify
 * reads the errno; the original kept the URL, api_key and all, for any
 * util.inspect or unhandled-rejection log of the cause chain to print (n2
 * review). Four deep, as fetchFailure reads it.
 */
function scrubbedCause(e: unknown, key: string, depth = 0): unknown {
  if (typeof e !== 'object' || e === null || depth >= 4) {
    return typeof e === 'string' ? scrub(e, key) : e
  }
  const src = e as Record<string, unknown>
  const message = typeof src.message === 'string' ? scrub(src.message, key) : ''
  const cause = src.cause === undefined ? undefined : scrubbedCause(src.cause, key, depth + 1)
  const copy = new Error(message, cause === undefined ? undefined : { cause })
  if (typeof src.name === 'string') copy.name = src.name
  for (const field of ['code', 'errno', 'syscall']) {
    const v = src[field]
    if (typeof v === 'string' || typeof v === 'number') {
      ;(copy as unknown as Record<string, unknown>)[field] = v
    }
  }
  copy.stack = `${copy.name}: ${message}`
  return copy
}

/**
 * The least a 429 is waited out when Vast sends no Retry-After, which its
 * docs say it never does: the minimum interval its rate limit sets for a
 * DELETE (a 429 reads "threshold=3.0"). The first backoff, 1.5 to 2.5 s,
 * came inside it, so a rate-limited DELETE's first retry was refused again.
 */
export const RATE_LIMIT_FLOOR_MS = 3_000

function isTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TimeoutError'
}

/**
 * What fetch threw, in words. undici says only "fetch failed" and keeps the
 * reason (read ECONNRESET, getaddrinfo ENOTFOUND ...) in its cause, which an
 * alert would otherwise never show.
 */
function fetchFailure(e: unknown): string {
  if (isTimeout(e)) return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s (timed out)`
  const parts: string[] = []
  let cur: unknown = e
  for (let depth = 0; typeof cur === 'object' && cur !== null && depth < 4; depth++) {
    const m = (cur as { message?: unknown }).message
    if (typeof m === 'string' && m.trim() && !parts.includes(m.trim())) parts.push(m.trim())
    cur = (cur as { cause?: unknown }).cause
  }
  return parts.join(': ') || String(e)
}

/** Retry-After as ms (seconds or an HTTP date), or null. Vast does not send it today. */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after')
  if (!h) return null
  const s = Number(h)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const at = Date.parse(h)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

type Attempt<T> =
  { ok: true; value: T } | { ok: false; error: VastError; retryAfterMs: number | null }

/** One HTTP exchange, under its deadline. Never throws: a failure is returned typed. */
async function send<T>(
  key: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown
): Promise<Attempt<T>> {
  const sep = path.includes('?') ? '&' : '?'
  const url = `${BASE}${path}${sep}api_key=${encodeURIComponent(key)}`
  let res: Response
  let text: string
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Covers reading the body as well as the headers.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    // Inside the try: a connection that drops, or a deadline that passes,
    // while the reply is read is as much a network failure as one before it.
    text = await res.text()
  } catch (e) {
    const error = new VastError(`network error: ${scrub(fetchFailure(e), key)}`, undefined, {
      cause: scrubbedCause(e, key)
    })
    return { ok: false, error, retryAfterMs: null }
  }
  if (!res.ok) {
    const error = new VastError(
      // Scrubbed before it is cut: a key across the cut kept its first part.
      `vast.ai ${method} ${path} → ${res.status}: ${scrub(text, key).slice(0, 300)}`,
      res.status
    )
    return { ok: false, error, retryAfterMs: retryAfterMs(res) }
  }
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch {
    const error = new VastError(
      `vast.ai ${method} ${path}: non-JSON response: ${scrub(text, key).slice(0, 300)}`
    )
    return { ok: false, error, retryAfterMs: null }
  }
}

interface RequestOptions {
  /**
   * Safe to send again when an attempt's outcome is unknown: a read, a
   * DELETE (a second one of an instance already gone is a 404, which is
   * done), an offer search, a key registration (a second one is
   * "duplicate", which is done). Never a create (see the header).
   */
  idempotent: boolean
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  opts: RequestOptions
): Promise<T> {
  const key = apiKey()
  const start = Date.now()
  let delay = RETRY_FIRST_DELAY_MS
  for (;;) {
    const r = await send<T>(key, method, path, body)
    if (r.ok) return r.value
    const kind = r.error.kind
    // 429s are routine once several node lifecycles poll at once, and one
    // 5xx or blip used to destroy a healthy node mid-boot (#39 #236). Only
    // what says nothing about the request itself is asked again.
    if (!opts.idempotent || (kind !== 'unknown' && kind !== 'transient')) throw r.error
    const jittered = delay * (0.75 + Math.random() * 0.5)
    const floor = r.error.status === 429 ? RATE_LIMIT_FLOOR_MS : 0
    const wait = Math.max(jittered, r.retryAfterMs ?? floor)
    if (Date.now() - start + wait > RETRY_BUDGET_MS) throw r.error
    await new Promise((resolve) => setTimeout(resolve, wait))
    delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS)
  }
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/**
 * `q` is a vast search query object sent as the top-level body of
 * `POST /bundles/` (per current API docs), e.g.
 * `{ rentable: {eq: true}, gpu_ram: {gte: 10000}, order: [["dph_total","asc"]], type: "ondemand" }`.
 */
export async function searchOffers(q: Record<string, unknown>): Promise<RawOffer[]> {
  // A POST, but a read: it changes nothing on Vast.
  const r = await request<{ offers?: RawOffer[] }>(
    'POST',
    '/bundles/',
    { limit: 100, ...q },
    { idempotent: true }
  )
  return r.offers ?? []
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export interface CreateInstanceOptions {
  offerId: number
  image: string
  diskGb: number
  onstart: string
  env: Record<string, string>
  label: string
}

/**
 * Rent an offer: exactly one PUT /asks, whatever comes back. A failure of
 * kind 'unknown' may have rented an instance, under `label`, that the reply
 * never named; the caller looks for it by that label (plan 1.4) rather than
 * asking again.
 */
export async function createInstance(opts: CreateInstanceOptions): Promise<number> {
  const r = await request<{
    success?: boolean
    new_contract?: number
    error?: string
    msg?: string
  }>(
    'PUT',
    `/asks/${opts.offerId}/`,
    {
      client_id: 'me',
      image: opts.image,
      disk: opts.diskGb,
      runtype: 'ssh',
      onstart: opts.onstart,
      env: opts.env,
      label: opts.label
    },
    { idempotent: false }
  )
  if (!r.new_contract) {
    throw new VastError(`create instance failed: ${r.error ?? r.msg ?? JSON.stringify(r)}`)
  }
  return r.new_contract
}

export async function listInstances(): Promise<RawInstance[]> {
  const r = await request<{ instances?: RawInstance[] }>('GET', '/instances/?owner=me', undefined, {
    idempotent: true
  })
  return r.instances ?? []
}

export async function showInstance(id: number): Promise<RawInstance | null> {
  try {
    const r = await request<{ instances?: RawInstance } | RawInstance>(
      'GET',
      `/instances/${id}/`,
      undefined,
      { idempotent: true }
    )
    // Endpoint returns either the instance or {instances: {...}} depending on version.
    const inst = (r as { instances?: RawInstance }).instances ?? (r as RawInstance)
    return inst && typeof inst === 'object' && 'id' in inst ? (inst as RawInstance) : null
  } catch (e) {
    if (e instanceof VastError && e.kind === 'notFound') return null
    throw e
  }
}

export async function destroyInstance(id: number): Promise<void> {
  await request('DELETE', `/instances/${id}/`, undefined, { idempotent: true })
}

// ---------------------------------------------------------------------------
// SSH keys / account
// ---------------------------------------------------------------------------

export async function listSshKeys(): Promise<Array<{ id: number; public_key: string }>> {
  const r = await request<{ ssh_keys?: Array<{ id: number; public_key: string }> }>(
    'GET',
    '/ssh/',
    undefined,
    { idempotent: true }
  )
  return r.ssh_keys ?? []
}

export async function registerSshKey(publicKey: string): Promise<void> {
  try {
    await request('POST', '/ssh/', { ssh_key: publicKey }, { idempotent: true })
  } catch (e) {
    // "duplicate" means the key is already registered — exactly what we want.
    if (e instanceof VastError && e.message.includes('duplicate')) return
    throw e
  }
}

export async function currentUser(): Promise<VastUser> {
  return request<VastUser>('GET', '/users/current/', undefined, { idempotent: true })
}

/** Extract SSH endpoints from an instance: direct (preferred) then proxy. */
export function sshEndpoints(inst: RawInstance): Array<{ host: string; port: number }> {
  const endpoints: Array<{ host: string; port: number }> = []
  const mapped = inst.ports?.['22/tcp']
  if (inst.public_ipaddr && mapped && mapped.length > 0) {
    const port = Number(mapped[0].HostPort)
    if (Number.isFinite(port)) endpoints.push({ host: inst.public_ipaddr, port })
  }
  if (inst.ssh_host && inst.ssh_port) {
    endpoints.push({ host: inst.ssh_host, port: inst.ssh_port })
  }
  return endpoints
}
