/**
 * Vast.ai REST client. Payload shapes mirror the official `vast.py` CLI (the
 * docs lag the CLI — when in doubt, that's the reference). Auth is sent both
 * as a Bearer header and the legacy `api_key` query param for compatibility.
 */

import { getSecret } from '../settings'
import type { RawInstance, RawOffer, VastUser } from './types'

const BASE = 'https://console.vast.ai/api/v0'

export class VastError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
  }
}

function apiKey(): string {
  const key = getSecret('vastApiKey')
  if (!key) throw new VastError('No Vast.ai API key configured')
  return key
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  attempt = 0
): Promise<T> {
  const key = apiKey()
  const sep = path.includes('?') ? '&' : '?'
  const url = `${BASE}${path}${sep}api_key=${encodeURIComponent(key)}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new VastError(`network error: ${(e as Error).message}`)
  }
  const text = await res.text()
  if (!res.ok) {
    // 429 is routine once several node lifecycles poll concurrently; vast
    // rejects the request before acting, so retrying (with backoff) is safe
    // for mutations too. Without this, a transient 429 inside driveToReady
    // destroys a perfectly healthy node mid-boot.
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)))
      return request<T>(method, path, body, attempt + 1)
    }
    throw new VastError(
      `vast.ai ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      res.status
    )
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new VastError(`vast.ai ${method} ${path}: non-JSON response: ${text.slice(0, 300)}`)
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
  const r = await request<{ offers?: RawOffer[] }>('POST', '/bundles/', { limit: 100, ...q })
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

export async function createInstance(opts: CreateInstanceOptions): Promise<number> {
  const r = await request<{
    success?: boolean
    new_contract?: number
    error?: string
    msg?: string
  }>('PUT', `/asks/${opts.offerId}/`, {
    client_id: 'me',
    image: opts.image,
    disk: opts.diskGb,
    runtype: 'ssh',
    onstart: opts.onstart,
    env: opts.env,
    label: opts.label
  })
  if (!r.new_contract) {
    throw new VastError(`create instance failed: ${r.error ?? r.msg ?? JSON.stringify(r)}`)
  }
  return r.new_contract
}

export async function listInstances(): Promise<RawInstance[]> {
  const r = await request<{ instances?: RawInstance[] }>('GET', '/instances/?owner=me')
  return r.instances ?? []
}

export async function showInstance(id: number): Promise<RawInstance | null> {
  try {
    const r = await request<{ instances?: RawInstance } | RawInstance>('GET', `/instances/${id}/`)
    // Endpoint returns either the instance or {instances: {...}} depending on version.
    const inst = (r as { instances?: RawInstance }).instances ?? (r as RawInstance)
    return inst && typeof inst === 'object' && 'id' in inst ? (inst as RawInstance) : null
  } catch (e) {
    if (e instanceof VastError && e.status === 404) return null
    throw e
  }
}

export async function destroyInstance(id: number): Promise<void> {
  await request('DELETE', `/instances/${id}/`)
}

// ---------------------------------------------------------------------------
// SSH keys / account
// ---------------------------------------------------------------------------

export async function listSshKeys(): Promise<Array<{ id: number; public_key: string }>> {
  const r = await request<{ ssh_keys?: Array<{ id: number; public_key: string }> }>('GET', '/ssh/')
  return r.ssh_keys ?? []
}

export async function registerSshKey(publicKey: string): Promise<void> {
  try {
    await request('POST', '/ssh/', { ssh_key: publicKey })
  } catch (e) {
    // "duplicate" means the key is already registered — exactly what we want.
    if (e instanceof VastError && e.message.includes('duplicate')) return
    throw e
  }
}

export async function currentUser(): Promise<VastUser> {
  return request<VastUser>('GET', '/users/current/')
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
