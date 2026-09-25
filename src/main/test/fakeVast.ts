/**
 * A scriptable stand-in for vast/vastClient's network calls: offers to rent,
 * instances that boot and can be destroyed, an account balance. Each created
 * instance gets a `FakeMachine` on the harness's network, reachable at the
 * SSH endpoints the instance reports, so nodeManager can drive it to ready
 * exactly as it would a real one.
 *
 * Every call is recorded (`calls`, `count`) before any scripted behaviour
 * runs, so a call that was made to fail still shows up. Script with:
 *   vast.fail('destroyInstance', { status: 500, message: 'boom' })  // next call throws
 *   vast.loseReply('createInstance', new Error('ECONNRESET'))        // next call happens, then throws
 *   vast.delay('createInstance', 30_000)                             // next call takes 30s (fake clock)
 *   const gate = vast.hold('createInstance')                          // next call waits for the test
 *   await w.until(() => gate.reached, 'create in flight'); ...; gate.release()
 *                                             // or gate.fail(e) / gate.loseReply(e)
 *
 * fail = the request never reached Vast: nothing was created or destroyed.
 * loseReply = Vast did it, the app never heard: the instance was created (or
 * destroyed) and THEN the call threw, as when the connection drops after the
 * request went out. Only a lost reply can leave an instance billing that the
 * app does not know it has, so a test of that leak (or of a destroy the app
 * wrongly believes failed) must use loseReply — with fail, there is nothing
 * to leak and the test passes whatever the app does.
 * gone = an instance that has been destroyed (or never existed) is a 404,
 * as on Vast: destroying it again rejects with VastError status 404, and so
 * does showInstance, which the harness's vastClient mock then maps to null
 * the way vastClient.ts does. A destroy is not idempotent here because it is
 * not on Vast; treating that 404 as success is the app's job (plan 1.2), and
 * a fake that did it for the app would pass the test of that fix without it.
 *
 * This is the server. The client-side handling vastClient.ts wraps around
 * each request is the harness's vastClient mock (harness.ts): no API key
 * rejects before anything reaches Vast, searchOffers sends `limit: 100`,
 * showInstance turns a 404 into null, registerSshKey takes "duplicate" as
 * done. What the mock does NOT redo is request()'s retry of a 429, so a
 * scripted failure is what request() finally throws, after its retries:
 * `fail(m, { status: 429, message })` is a 429 that outlasted them.
 *
 * searchOffers applies the query the way Vast's /bundles/ does: each
 * `{ field: { op: value } }` with op eq, neq, gt, gte, lt, lte, in or notin
 * filters the offers, `order` sorts them and `limit` cuts the list. A field
 * an offer does not carry passes every test on it. Vast's offers carry all
 * of them (`verified`, `cpu_cores_effective`...); these carry what RawOffer
 * has, plus what a test sets, so a test that filters on a field sets it on
 * the offers it adds.
 */

import type { CreateInstanceOptions } from '../vast/vastClient'
import type { RawInstance, RawOffer, VastUser } from '../vast/types'
import type { FakeMachine, FakeNetwork } from './fakeSsh'

export type VastMethod =
  | 'searchOffers'
  | 'createInstance'
  | 'listInstances'
  | 'showInstance'
  | 'destroyInstance'
  | 'listSshKeys'
  | 'registerSshKey'
  | 'currentUser'

export interface VastCall {
  method: VastMethod
  args: unknown[]
  /** fake-clock ms when the call was made */
  at: number
}

/** A way to fail: an Error as-is, or the status/message of a VastError. */
export type VastFailure = Error | { status?: number; message: string }

/** A call held open until the test lets it go. */
export interface Gate {
  /** true once a call has arrived and is waiting */
  readonly reached: boolean
  /** let the call proceed to its normal result */
  release(): void
  /** make the call throw instead, without taking effect (it never reached Vast) */
  fail(error: VastFailure): void
  /** let the call take effect on Vast, then throw (the reply was lost) */
  loseReply(error: VastFailure): void
}

/** How a call ends, if not normally. */
interface Outcome {
  /** thrown before the call takes effect: the request never reached Vast */
  error?: VastFailure
  /** thrown after the call took effect: Vast did it, the reply was lost */
  errorAfter?: VastFailure
}

interface Behaviour extends Outcome {
  delayMs?: number
  gate?: GateImpl
}

class GateImpl implements Gate {
  reached = false
  private settle: ((outcome: Outcome) => void) | null = null
  private early: Outcome | null = null

  /** @internal resolves with how the held call is to end ({} = normally) */
  wait(): Promise<Outcome> {
    this.reached = true
    if (this.early) return Promise.resolve(this.early)
    return new Promise((r) => (this.settle = r))
  }

  private end(outcome: Outcome): void {
    if (this.settle) this.settle(outcome)
    else this.early = outcome
  }

  release(): void {
    this.end({})
  }

  fail(error: VastFailure): void {
    this.end({ error })
  }

  loseReply(error: VastFailure): void {
    this.end({ errorAfter: error })
  }
}

/** A live instance, and when it was created and how long it boots for. */
interface InstanceRecord {
  raw: RawInstance
  createdAt: number
  bootMs: number
  machine: FakeMachine
}

export class FakeVast {
  /** The market: searchOffers filters it by its query. Renting an offer removes it, as on vast. */
  offers: RawOffer[] = []
  /** Every call, in order. */
  readonly calls: VastCall[] = []
  /** Ids of every instance ever created (by createInstance or addInstance). */
  readonly created: number[] = []
  /** Ids destroyInstance was called on, successfully. */
  readonly destroyed: number[] = []
  user: VastUser = { id: 1, credit: 100 }
  /** How long a new instance reports 'loading' before 'running' (fake-clock ms). */
  bootMs = 0

  private instances = new Map<number, InstanceRecord>()
  /** Every instance ever created, as created: kept after it is destroyed. */
  private history = new Map<number, RawInstance>()
  private scripts = new Map<VastMethod, Behaviour[]>()
  private nextOfferId = 5001
  private nextMachineId = 301
  private nextInstanceId = 9001

  constructor(
    private readonly network: FakeNetwork,
    /** Builds the real VastError, so `instanceof` in the app holds. */
    private readonly vastError: (message: string, status?: number) => Error
  ) {}

  // -- fixtures --------------------------------------------------------------

  /** Add a rentable offer (sane defaults: one RTX 4090 at $0.40/h). */
  addOffer(partial: Partial<RawOffer> = {}): RawOffer {
    const offer: RawOffer = {
      id: this.nextOfferId++,
      machine_id: this.nextMachineId++,
      gpu_name: 'RTX 4090',
      num_gpus: 1,
      gpu_ram: 24_576,
      dph_total: 0.4,
      dlperf_per_dphtotal: 200,
      inet_down: 1000,
      inet_up: 500,
      reliability2: 0.99,
      cuda_max_good: 12.4,
      geolocation: 'Sweden, SE',
      disk_space: 100,
      rentable: true,
      ...partial
    }
    this.offers.push(offer)
    return offer
  }

  /**
   * An instance that exists on the account without this app having created it
   * in this test — a leftover from a crash, or another installation's.
   */
  addInstance(partial: Partial<RawInstance> = {}): RawInstance {
    const id = partial.id ?? this.nextInstanceId++
    const raw: RawInstance = {
      id,
      machine_id: this.nextMachineId++,
      gpu_name: 'RTX 4090',
      num_gpus: 1,
      dph_total: 0.4,
      actual_status: 'running',
      start_date: Date.now() / 1000,
      ...partial
    }
    this.register(raw, 0)
    return raw
  }

  /** The machine behind an instance (live or destroyed). */
  machine(instanceId: number): FakeMachine {
    const m = this.network.machines.find((x) => x.name === `instance-${instanceId}`)
    if (!m) throw new Error(`fake vast: no instance ${instanceId}`)
    return m
  }

  /**
   * An instance as it was created — its label, machine, price — whether or
   * not it is still live (see live()). Undefined if it never existed.
   */
  instance(id: number): RawInstance | undefined {
    const raw = this.history.get(id)
    return raw && { ...raw }
  }

  /** Ids of instances that exist right now, i.e. are still billing. */
  live(): number[] {
    return [...this.instances.keys()]
  }

  /** Change what a live instance reports, e.g. `{ actual_status: 'offline' }`. */
  patchInstance(id: number, patch: Partial<RawInstance>): void {
    const rec = this.instances.get(id)
    if (!rec) throw new Error(`fake vast: no live instance ${id}`)
    Object.assign(rec.raw, patch)
  }

  // -- scripting ----------------------------------------------------------------

  /** Queue a behaviour for the next `times` calls of `method`. */
  script(method: VastMethod, behaviour: Behaviour, times = 1): this {
    const queue = this.scripts.get(method) ?? []
    for (let i = 0; i < times; i++) queue.push({ ...behaviour })
    this.scripts.set(method, queue)
    return this
  }

  /** The next `times` calls of `method` throw without taking effect. */
  fail(method: VastMethod, error: VastFailure, times = 1): this {
    return this.script(method, { error }, times)
  }

  /**
   * The next `times` calls of `method` take effect on Vast and then throw.
   * Only a create or destroy has an effect to lose; for a read it is the
   * same as fail().
   */
  loseReply(method: VastMethod, error: VastFailure, times = 1): this {
    return this.script(method, { errorAfter: error }, times)
  }

  /** The next `times` calls of `method` take `ms` of fake time. */
  delay(method: VastMethod, ms: number, times = 1): this {
    return this.script(method, { delayMs: ms }, times)
  }

  /** The next call of `method` waits until the test releases (or fails) it. */
  hold(method: VastMethod): Gate {
    const gate = new GateImpl()
    this.script(method, { gate })
    return gate
  }

  /** How many times `method` has been called. */
  count(method: VastMethod): number {
    return this.calls.filter((c) => c.method === method).length
  }

  /** The arguments of each call to `method`. */
  argsOf(method: VastMethod): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }

  // -- the vastClient surface ---------------------------------------------------

  searchOffers(q: Record<string, unknown>): Promise<RawOffer[]> {
    return this.call('searchOffers', [q], () => searchResults(this.offers, q))
  }

  createInstance(opts: CreateInstanceOptions): Promise<number> {
    return this.call('createInstance', [opts], () => {
      const i = this.offers.findIndex((o) => o.id === opts.offerId)
      if (i < 0) {
        throw this.vastError(
          `create instance failed: no_such_ask (offer ${opts.offerId} is not rentable)`,
          400
        )
      }
      const [offer] = this.offers.splice(i, 1)
      const raw: RawInstance = {
        id: this.nextInstanceId++,
        machine_id: offer.machine_id,
        gpu_name: offer.gpu_name,
        num_gpus: offer.num_gpus,
        dph_total: offer.dph_total,
        label: opts.label,
        start_date: Date.now() / 1000
      }
      this.register(raw, this.bootMs)
      return raw.id
    })
  }

  listInstances(): Promise<RawInstance[]> {
    return this.call('listInstances', [], () => this.live().map((id) => this.view(id)!))
  }

  showInstance(id: number): Promise<RawInstance> {
    // A destroyed or unknown instance is a 404, which vastClient (the
    // harness's mock of it) maps to null.
    return this.call('showInstance', [id], () => this.view(id) ?? this.gone('GET', id))
  }

  destroyInstance(id: number): Promise<void> {
    return this.call('destroyInstance', [id], () => {
      const rec = this.instances.get(id)
      if (!rec) this.gone('DELETE', id)
      this.instances.delete(id)
      this.destroyed.push(id)
      rec.machine.kill()
    })
  }

  listSshKeys(): Promise<Array<{ id: number; public_key: string }>> {
    return this.call('listSshKeys', [], () => [])
  }

  registerSshKey(publicKey: string): Promise<void> {
    return this.call('registerSshKey', [publicKey], () => undefined)
  }

  currentUser(): Promise<VastUser> {
    return this.call('currentUser', [], () => ({ ...this.user }))
  }

  // -- internals ------------------------------------------------------------------

  private register(raw: RawInstance, bootMs: number): void {
    const id = raw.id
    // Direct endpoint first and the proxy second, the order sshEndpoints
    // prefers; the machine answers on both.
    const direct = { host: `10.0.${(id >> 8) & 255}.${id & 255}`, port: 40_000 + (id % 20_000) }
    const proxy = { host: `ssh${id % 9}.vast.test`, port: 20_000 + (id % 20_000) }
    const machine = this.network.addMachine(`instance-${id}`, [direct, proxy])
    machine.numGpus = raw.num_gpus ?? 1
    this.instances.set(id, { raw, createdAt: Date.now(), bootMs, machine })
    this.history.set(id, { ...raw })
    this.created.push(id)
  }

  /** Vast's answer about an instance that is gone or never was, as vastClient's request() throws it. */
  private gone(method: 'GET' | 'DELETE', id: number): never {
    throw this.vastError(
      `vast.ai ${method} /instances/${id}/ → 404: {"success":false,"error":"no_such_instance"}`,
      404
    )
  }

  /** The instance as /instances/:id reports it now, or null once it is gone. */
  private view(id: number): RawInstance | null {
    const rec = this.instances.get(id)
    if (!rec) return null
    const [direct, proxy] = rec.machine.endpoints
    // An explicit status (addInstance, patchInstance) wins over the boot clock.
    const status =
      rec.raw.actual_status ?? (Date.now() - rec.createdAt >= rec.bootMs ? 'running' : 'loading')
    return {
      ...rec.raw,
      actual_status: status,
      intended_status: 'running',
      ...(status === 'running'
        ? {
            public_ipaddr: direct.host,
            ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: String(direct.port) }] },
            ssh_host: proxy.host,
            ssh_port: proxy.port
          }
        : {})
    }
  }

  private async call<T>(method: VastMethod, args: unknown[], impl: () => T): Promise<T> {
    this.calls.push({ method, args, at: Date.now() })
    const b = this.scripts.get(method)?.shift()
    if (b?.delayMs) await new Promise((r) => setTimeout(r, b.delayMs))
    const gated = b?.gate ? await b.gate.wait() : {}
    const before = b?.error ?? gated.error
    if (before) throw this.toError(before)
    const result = impl()
    const after = b?.errorAfter ?? gated.errorAfter
    if (after) throw this.toError(after)
    return result
  }

  private toError(failure: VastFailure): Error {
    return failure instanceof Error ? failure : this.vastError(failure.message, failure.status)
  }
}

/** The search operators the fake applies. */
const SEARCH_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notin'])

/** One `{ op: value }` test of a search query against an offer's value. */
function passes(value: unknown, op: string, want: unknown): boolean {
  // Numbers in practice; strings compare the same way at runtime.
  const v = value as number
  const w = want as number
  switch (op) {
    case 'eq':
      return value === want
    case 'neq':
      return value !== want
    case 'gt':
      return v > w
    case 'gte':
      return v >= w
    case 'lt':
      return v < w
    case 'lte':
      return v <= w
    case 'in':
      return Array.isArray(want) && want.includes(value)
    case 'notin':
      return Array.isArray(want) && !want.includes(value)
    default:
      return false
  }
}

/** What POST /bundles/ returns for query `q`: filtered, ordered, limited copies. */
function searchResults(offers: RawOffer[], q: Record<string, unknown>): RawOffer[] {
  const tests: Array<[field: string, op: string, want: unknown]> = []
  for (const [field, spec] of Object.entries(q)) {
    // Filters are `field: { op: value }`; `type`, `order` and `limit` are not.
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) continue
    for (const [op, want] of Object.entries(spec)) {
      // Loudly, rather than quietly ignore the filter a test meant to exercise.
      if (!SEARCH_OPS.has(op)) throw new Error(`fake vast: unsupported search operator ${op}`)
      tests.push([field, op, want])
    }
  }
  const out = offers.filter((o) =>
    tests.every(([field, op, want]) => {
      const value = (o as unknown as Record<string, unknown>)[field]
      return value === undefined || passes(value, op, want)
    })
  )
  const order = Array.isArray(q.order) ? (q.order as Array<[string, string?]>) : []
  out.sort((a, b) => {
    for (const [field, dir] of order) {
      const x = (a as unknown as Record<string, number | undefined>)[field]
      const y = (b as unknown as Record<string, number | undefined>)[field]
      if (x === y || x === undefined || y === undefined) continue
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    }
    return 0
  })
  const limit = typeof q.limit === 'number' ? q.limit : out.length
  return out.slice(0, limit).map((o) => ({ ...o }))
}
