/**
 * Fleet node registry + per-node lifecycle. State is persisted in SQLite so
 * app restarts recover; transitions are pushed to the renderer via
 * `node:changed`.
 *
 * Phase 2 scope: request (offer → create → poll → SSH reachable → ready),
 * destroy, cost accrual. Provisioning (Blender/ffmpeg install, agent start)
 * hooks in at `onReady` in Phase 3.
 */

import { randomUUID } from 'crypto'
import { co2Grams } from '../carbon/intensity'
import { getDb } from '../db/db'
import { classify } from '../errors'
import { emit } from '../events'
import { getSettings } from '../settings'
import { ensureKeyRegistered, readPrivateKey } from '../ssh/keys'
import { FIRST_CONNECT_BUDGET_MS, retryWithBackoff } from '../ssh/connectRetry'
import { SshConnection } from '../ssh/sshConnection'
import { findOffers } from '../vast/offers'
import {
  createInstance,
  currentUser,
  destroyInstance,
  listInstances,
  sshEndpoints,
  showInstance,
  VastError,
  vastErrorKind
} from '../vast/vastClient'
import type {
  GpuSample,
  NodeMetrics,
  NodeSnapshot,
  NodeState,
  NodeWorkRef,
  Offer
} from '../../shared/models'
import {
  capUsage,
  createOutcomeUnknown,
  holdsInstance,
  type NodeCostFacts
} from '../../shared/nodeState'
import type { RawInstance } from '../vast/types'

export const DOCKER_IMAGE = 'vastai/base-image:cuda-12.1.1-cudnn8-devel-ubuntu22.04'

/** Minimal onstart — real provisioning is pushed over SSH by the app. */
const ONSTART = 'mkdir -p ~/vastai && touch ~/vastai/.booted'

/**
 * How long one ensureInstanceGone keeps at a destroy before it calls it
 * unconfirmed. Long enough to ride out a Vast blip or a burst of 429s without
 * an alarm; short enough that the destroy button, which waits for it, and a
 * quit's destroy-all are not held for minutes. The retry timer carries on
 * after it (DESTROY_RETRY_MS).
 */
const DESTROY_BUDGET_MS = 60_000
const DESTROY_FIRST_DELAY_MS = 2_000
const DESTROY_MAX_DELAY_MS = 15_000

/**
 * How often a destroy Vast has not confirmed is tried again, one attempt per
 * node per round. One Vast blip during an unattended idle scale-down used to
 * leave the instance billing until the user came back and pressed "clear
 * failed" or restarted the app (#194).
 */
const DESTROY_RETRY_MS = 60_000

/**
 * The longest a destroy waits for OctaneServer to stop and release its
 * floating license. A clean exit takes seconds; the script's own wait is 30 s,
 * and past this the instance going away ends the server anyway.
 */
const OCTANE_STOP_BUDGET_MS = 20_000

/**
 * Plan 1.4: how long the instance of a create that got no answer is looked
 * for by its label before the create counts as having rented nothing. Vast
 * lists an instance as soon as it exists, so a create it carried out shows up
 * at the first look; the minute covers one it carried out after the app gave
 * up waiting for the reply. The lookup backs off from 2 s to 15 s meanwhile.
 */
const CREATE_LOOKUP_MS = 60_000
const LOOKUP_FIRST_DELAY_MS = 2_000
const LOOKUP_MAX_DELAY_MS = 15_000

/**
 * How often the lookup asks once Vast has gone that whole minute without
 * answering it. It never gives up: until Vast answers, the row counts as
 * billing, and nothing else in this session would settle it.
 */
const LOOKUP_SLOW_MS = 60_000

/**
 * How often a restart asks Vast again about an instance it has not answered
 * about: from 5 s, doubling to a minute, for as long as it takes.
 */
const RESUME_FIRST_DELAY_MS = 5_000
const RESUME_MAX_DELAY_MS = 60_000

/**
 * The states in which the app wants a node's instance gone: it is being
 * destroyed, it failed, or it was destroyed and Vast has not confirmed that.
 */
const DESTROY_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'failed',
  'destroying',
  'destroyed'
])

/**
 * Vast answered a destroy, and showInstance still finds the instance. A
 * DELETE can answer 200 and leave the instance running (#140), so this is
 * not a destroy until Vast stops knowing the instance.
 */
class InstanceStillListed extends Error {
  override readonly name = 'InstanceStillListed'

  constructor(instanceId: number, status: string | undefined) {
    super(`Vast still lists instance ${instanceId} after its destroy (${status ?? 'no status'})`)
  }
}

/**
 * Vast did not answer: a network error, a timeout, a 5xx or a 429. That says
 * nothing about the instance asked about, or about the machine it is on.
 */
function vastDown(e: unknown): boolean {
  const kind = vastErrorKind(e)
  return kind === 'unknown' || kind === 'transient'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * How one rental ended, for requestNodes: the node it rented (or, cancelled,
 * the row that stands for it), or why it rented nothing. `stop` ends the
 * batch: its create got no answer, so an instance may exist that nothing has
 * found yet (plan 1.4), or Vast refused it in a way the next offer would meet
 * too.
 */
type Rental = ({ id: string } | { error: Error }) & { stop?: boolean }

interface NodeRow {
  id: string
  instance_id: number | null
  state: NodeState
  gpu_name: string | null
  num_gpus: number
  dph_total: number | null
  ssh_host: string | null
  ssh_port: number | null
  host_key: string | null
  started_at: number | null
  accumulated_cost: number
  eevee_capable: number | null
  octane_ready: number
  blender_versions: string
  last_error: string | null
  geolocation: string | null
  destroyed_at: number | null
  label: string | null
  octane_state: string
  create_unknown_since: number | null
}

/** What the billing predicates (shared/nodeState.ts) read, from a row. */
function rowFacts(r: NodeRow): NodeCostFacts {
  return {
    state: r.state,
    instanceId: r.instance_id,
    destroyedAt: r.destroyed_at,
    createUnknownSince: r.create_unknown_since,
    dphTotal: r.dph_total
  }
}

/** What the scheduler currently has in flight on a node. */
export type ActiveWork = NodeWorkRef

/** Injected by index.ts (avoids a scheduler ↔ nodeManager import cycle). */
let activeWorkProvider: ((nodeId: string) => ActiveWork[]) | null = null
export function setActiveWorkProvider(fn: (nodeId: string) => ActiveWork[]): void {
  activeWorkProvider = fn
}

/** The scheduler's auto-judged concurrency for a node. */
export interface SlotInfo {
  inUse: number
  target: number
}

/** Injected by index.ts, same reason as activeWorkProvider. */
let slotInfoProvider: ((nodeId: string) => SlotInfo) | null = null
export function setSlotInfoProvider(fn: (nodeId: string) => SlotInfo): void {
  slotInfoProvider = fn
}

/** Lets the scheduler drop a destroyed node's learned concurrency. */
let forgetNodeProvider: ((nodeId: string) => void) | null = null
export function setForgetNodeProvider(fn: (nodeId: string) => void): void {
  forgetNodeProvider = fn
}

/** Latest usage sample per node (in-memory — no need to persist). */
const metricsByNode = new Map<string, NodeMetrics>()

/** Previous `/proc/stat` jiffie totals per node, for the CPU% delta. */
const cpuStatByNode = new Map<string, { total: number; idle: number }>()

/**
 * GPU energy per node (Wh), integrated from power samples. Kept for destroyed
 * nodes too so the session total doesn't drop when a node goes away — and, as
 * a session figure, deliberately not persisted.
 */
const energyByNode = new Map<string, number>()

/**
 * How much of `energyByNode` has already been written to usage_log. The
 * difference is the Wh burned since the last accrual tick. Both maps are
 * in-memory, so a restart zeroes them together and no energy is double-counted.
 */
const energyFlushedByNode = new Map<string, number>()

/** Wh burned on this node since the previous accrual tick; advances the mark. */
function flushEnergy(nodeId: string): number {
  const total = energyByNode.get(nodeId) ?? 0
  const delta = total - (energyFlushedByNode.get(nodeId) ?? 0)
  energyFlushedByNode.set(nodeId, total)
  return delta > 0 ? delta : 0
}

export function sessionEnergyWh(): number {
  let total = 0
  for (const wh of energyByNode.values()) total += wh
  return total
}

/**
 * Session CO2e (grams), each node's energy costed against its own country's
 * grid rather than one blended figure — the whole point of recording where a
 * machine is. Destroyed nodes still count: their row survives and the carbon
 * was still emitted.
 */
function sessionCo2Grams(): number {
  if (energyByNode.size === 0) return 0
  const overhead = getSettings().co2OverheadFactor
  const geoById = new Map(
    (
      getDb().prepare('SELECT id, geolocation FROM nodes').all() as Array<{
        id: string
        geolocation: string | null
      }>
    ).map((r) => [r.id, r.geolocation])
  )
  let total = 0
  for (const [nodeId, wh] of energyByNode) {
    total += co2Grams(wh, geoById.get(nodeId) ?? null, overhead)
  }
  return total
}

interface UsageRow {
  ts: number
  nodeId: string
  jobId: string | null
  chunkId: string | null
  cost: number
  wh: number
  powerW: number | null
  gpuUtil: number | null
}

/**
 * Divide one node's minute between the jobs it was actually rendering. A node
 * running two chunks of different jobs splits 50/50; two chunks of the *same*
 * job collapse into one row carrying the whole share, so a per-job SUM is right
 * either way. A node rendering nothing yields a single job_id = NULL row — that
 * is real money spent on idle or provisioning time and the History screen shows
 * it as overhead rather than hiding it.
 */
function splitUsage(nodeId: string, ts: number, cost: number, wh: number): UsageRow[] {
  const m = metricsByNode.get(nodeId)
  // 0 W means "this card doesn't report power", not "it drew nothing" — keep it
  // null so it doesn't drag the averages down.
  const powerW = m && m.powerW > 0 ? m.powerW : null
  const gpuUtil = m ? m.gpuUtil : null
  const base = { ts, nodeId }

  const work = activeWorkProvider?.(nodeId) ?? []
  if (work.length === 0) {
    return [{ ...base, jobId: null, chunkId: null, cost, wh, powerW, gpuUtil }]
  }

  const chunksByJob = new Map<string, string[]>()
  for (const w of work) {
    const ids = chunksByJob.get(w.jobId)
    if (ids) ids.push(w.chunkId)
    else chunksByJob.set(w.jobId, [w.chunkId])
  }
  return [...chunksByJob].map(([jobId, chunkIds], i) => {
    const share = chunkIds.length / work.length
    return {
      ...base,
      jobId,
      chunkId: chunkIds.join(', '),
      cost: cost * share,
      wh: wh * share,
      // Cost and energy divide between jobs, but draw does not — the node pulls
      // those watts once. Record the sample on the first row only, so summing
      // power_w across a tick gives true fleet draw rather than counting a
      // two-job node twice.
      powerW: i === 0 ? powerW : null,
      gpuUtil: i === 0 ? gpuUtil : null
    }
  })
}

/**
 * Persist a tick's usage rows and roll the attributed spend into
 * `jobs.cost_so_far` — the column the Jobs list and job header have always
 * displayed but which nothing used to write.
 */
function writeUsage(rows: UsageRow[]): void {
  if (rows.length === 0) return
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO usage_log (ts, node_id, job_id, chunk_id, delta_cost, delta_wh, power_w, gpu_util)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const charge = db.prepare('UPDATE jobs SET cost_so_far = cost_so_far + ? WHERE id = ?')
  db.transaction(() => {
    for (const r of rows) {
      insert.run(r.ts, r.nodeId, r.jobId, r.chunkId, r.cost, r.wh, r.powerW, r.gpuUtil)
      if (r.jobId) charge.run(r.cost, r.jobId)
    }
  })()
}

/** Append a balance reading, but only when it has actually moved. */
function recordBalance(ts: number, balance: number): void {
  const db = getDb()
  const last = db.prepare('SELECT balance FROM balance_log ORDER BY ts DESC LIMIT 1').get() as
    { balance: number } | undefined
  if (last && last.balance === balance) return
  db.prepare('INSERT OR REPLACE INTO balance_log (ts, balance) VALUES (?, ?)').run(ts, balance)
}

/**
 * True CPU utilisation from consecutive `/proc/stat` samples. Load average is
 * NOT a percentage — on Linux it counts uninterruptible-I/O tasks too, so a
 * node stuck on disk reads as "busy" while its cores idle. Until a second
 * sample exists (first poll after connect), fall back to load/cores.
 */
function cpuUtilFromStat(nodeId: string, memPart: string, load1: number, cores: number): number {
  const fallback = cores > 0 ? Math.min(100, (load1 / cores) * 100) : 0
  const line = /^cpu\s+(.+)$/m.exec(memPart)
  if (!line) return fallback
  const f = line[1].trim().split(/\s+/).map(Number)
  if (f.length < 5 || f.some((x) => !Number.isFinite(x))) return fallback
  // user nice system idle iowait irq softirq steal … — idle time is idle+iowait.
  const total = f.reduce((a, x) => a + x, 0)
  const idle = f[3] + f[4]
  const prev = cpuStatByNode.get(nodeId)
  cpuStatByNode.set(nodeId, { total, idle })
  if (!prev || total <= prev.total) return fallback
  const dTotal = total - prev.total
  const dIdle = Math.max(0, idle - prev.idle)
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
}

function rowToSnapshot(r: NodeRow): NodeSnapshot {
  const slots = slotInfoProvider?.(r.id) ?? { inUse: 0, target: 1 }
  return {
    id: r.id,
    instanceId: r.instance_id,
    state: r.state,
    gpuName: r.gpu_name,
    numGpus: r.num_gpus,
    dphTotal: r.dph_total,
    sshHost: r.ssh_host,
    sshPort: r.ssh_port,
    startedAt: r.started_at,
    accumulatedCost: r.accumulated_cost,
    energyWh: energyByNode.get(r.id) ?? 0,
    co2g: co2Grams(energyByNode.get(r.id) ?? 0, r.geolocation, getSettings().co2OverheadFactor),
    geolocation: r.geolocation,
    currentWork: activeWorkProvider?.(r.id) ?? [],
    slotsInUse: slots.inUse,
    slotTarget: slots.target,
    eeveeCapable: r.eevee_capable === null ? null : r.eevee_capable === 1,
    octaneReady: r.octane_ready === 1,
    octaneNeedsManualLogin: false,
    blenderVersions: JSON.parse(r.blender_versions) as string[],
    lastError: r.last_error,
    metrics: metricsByNode.get(r.id) ?? null,
    // Without these two every destroyed node would read as billing, and a
    // create of unknown outcome as not billing (shared/nodeState.ts).
    destroyedAt: r.destroyed_at,
    createUnknownSince: r.create_unknown_since,
    label: r.label
  }
}

class ManagedNode {
  ssh: SshConnection | null = null

  constructor(public readonly id: string) {}

  private get row(): NodeRow {
    return getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(this.id) as NodeRow
  }

  get snapshot(): NodeSnapshot {
    return rowToSnapshot(this.row)
  }

  get state(): NodeState {
    return this.row.state
  }

  /** What the billing predicates read (shared/nodeState.ts), without a whole snapshot. */
  get facts(): NodeCostFacts {
    return rowFacts(this.row)
  }

  /**
   * SSH has answered on this node at least once (its host key is pinned).
   * Nothing, OctaneServer included, can have been started on one where it
   * never has.
   */
  get sshEverAnswered(): boolean {
    return this.row.host_key != null
  }

  /**
   * Destroying or destroyed: the node is on its way out, and no lifecycle
   * step still running for it may move it back into the fleet.
   */
  get gone(): boolean {
    const s = this.state
    return s === 'destroying' || s === 'destroyed'
  }

  /**
   * For a lifecycle step (driveToReady, resumeNode, recoverUnreachable) back
   * from an await: whether the node has left `held`, the state the step last
   * found it in or put it in. While a step holds a node nothing but a destroy
   * moves it: destroyNode ('destroying', then 'destroyed', or 'failed' when
   * Vast never confirmed the instance gone and it may still be billing). The
   * step must then stop without writing a state over the destroy's, or a
   * node the user destroyed comes back into the fleet, and a destroyed one
   * gets a second DELETE. Not `gone`: a 'failed' destroy is not gone. A row
   * the last exit left 'destroying' is never held by a step: init destroys
   * it instead. Plan 2.2 makes every transition a compare-and-set instead.
   */
  movedOn(held: NodeState): boolean {
    return this.state !== held
  }

  /**
   * GPU count and latest metrics WITHOUT building a snapshot. The scheduler
   * sizes GPU lanes from these, and the snapshot itself asks the scheduler for
   * slot info — going through `snapshot` here would recurse.
   */
  get laneInputs(): { numGpus: number; metrics: NodeMetrics | null } {
    const row = getDb().prepare('SELECT num_gpus FROM nodes WHERE id = ?').get(this.id) as
      { num_gpus: number } | undefined
    return { numGpus: row?.num_gpus ?? 1, metrics: metricsByNode.get(this.id) ?? null }
  }

  /** Push a fresh snapshot without changing any persisted field. */
  emitChanged(): void {
    emit('node:changed', this.snapshot)
  }

  update(patch: Partial<Record<keyof NodeRow, unknown>>): void {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    getDb()
      .prepare(`UPDATE nodes SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => patch[k as keyof NodeRow]), this.id)
    emit('node:changed', this.snapshot)
  }

  setState(state: NodeState, lastError: string | null = null): void {
    this.update({ state, last_error: lastError })
  }

  /** Establish the pooled SSH connection (TOFU-pinning the host key). */
  async connectSsh(): Promise<SshConnection> {
    const row = this.row
    if (!row.ssh_host || !row.ssh_port) throw new Error('no SSH endpoint yet')
    if (!this.ssh) {
      this.ssh = new SshConnection({
        host: row.ssh_host,
        port: row.ssh_port,
        username: 'root',
        privateKey: readPrivateKey(),
        pinnedHostKey: row.host_key
      })
      this.ssh.on('hostKey', (hash: string) => {
        if (!this.row.host_key) this.update({ host_key: hash })
      })
    }
    await this.ssh.acquire()
    return this.ssh
  }

  closeSsh(): void {
    this.ssh?.close()
    this.ssh = null
  }
}

export class NodeManager {
  private nodes = new Map<string, ManagedNode>()
  /** machine ids that failed this session — skipped when picking offers. */
  private blacklist = new Set<number>()
  private costTimer: NodeJS.Timeout | null = null
  private metricsTimer: NodeJS.Timeout | null = null
  private destroyTimer: NodeJS.Timeout | null = null
  private balance: number | null = null
  /**
   * ensureInstanceGone calls in flight, by instance id. A second caller for
   * the same instance (the retry timer, clearFailed, the destroy button
   * pressed again) waits on the first instead of sending its own DELETE.
   */
  private goneChecks = new Map<number, Promise<boolean>>()
  /** Instances whose unconfirmed destroy has been alerted this session. */
  private unconfirmedAlerted = new Set<number>()
  private retryingDestroys = false
  /** Nodes whose createInstance is in flight right now (rentOffer). */
  private creating = new Set<string>()
  /**
   * Nodes whose create got no answer, whose instance is being looked for by
   * its label right now (findLostCreate). The lookup settles the row, and
   * adopts or destroys what it finds.
   */
  private lookingUp = new Set<string>()
  /**
   * Rows the last run left with a create of unknown outcome. init's sweep
   * settles them against the account's instances (reconcileOrphans).
   */
  private unknownAtBoot = new Set<string>()
  /** Phase 3 hook: called when a node reaches SSH-reachable. */
  onReady: ((node: { id: string; ssh: SshConnection }) => Promise<void>) | null = null

  init(): void {
    const rows = getDb().prepare('SELECT * FROM nodes').all() as NodeRow[]
    for (const r of rows) {
      const facts = rowFacts(r)
      // A destroyed row is done with, unless Vast never confirmed its
      // instance gone: an older build's destroy, whose 200 was taken on
      // trust, or a create cut short by a quit after its destroy.
      if (r.state === 'destroyed' && !holdsInstance(facts)) continue
      const n = new ManagedNode(r.id)
      this.nodes.set(r.id, n)
      if (createOutcomeUnknown(facts)) this.unknownAtBoot.add(r.id)
      // Anything mid-lifecycle at boot needs re-verification against vast.
      // Not a node the last run was destroying, or had failed: resuming one
      // re-provisioned it back into the fleet (#168). retryDestroys below
      // finishes its destroy instead.
      if (r.instance_id != null && holdsInstance(facts) && !DESTROY_STATES.has(r.state)) {
        void this.resumeNode(n)
      }
    }
    this.costTimer = setInterval(() => void this.accrueCosts(), 60_000)
    this.metricsTimer = setInterval(() => void this.pollMetrics(), 15_000)
    this.destroyTimer = setInterval(() => void this.retryDestroys(0), DESTROY_RETRY_MS)
    void this.retryDestroys(DESTROY_BUDGET_MS)
    void this.reconcileOrphans()
  }

  /**
   * Billing-leak protection: destroy any instance this profile rented that
   * no node row holds (e.g. one whose create reply was lost, or created
   * moments before a crash). An instance a row holds, in any state, is not
   * the sweep's: a live node's, or one retryDestroys is destroying. Never
   * touches instances without our label — the account may host unrelated
   * workloads — nor labelled ones another installation or profile rented
   * (below).
   */
  private async reconcileOrphans(): Promise<void> {
    try {
      // Before the list is asked for. An instance held when Vast answers is
      // left alone even if its row is confirmed gone meanwhile: the list
      // predates that destroy, and a second one here would be announced as
      // an orphan.
      const held = new Set<number>()
      for (const n of this.nodes.values()) {
        const f = n.facts
        if (f.instanceId != null && holdsInstance(f)) held.add(f.instanceId)
      }
      const instances = await listInstances()
      const rows = getDb().prepare('SELECT id, instance_id FROM nodes').all() as Array<{
        id: string
        instance_id: number | null
      }>
      // Labels carry the first 8 chars of OUR node id, and the node row is
      // written before the instance is created, so every instance this profile
      // ever rented has a row here. One without is another installation's —
      // a packaged app and a dev build, or a second profile, on the same
      // account — and destroying it would kill that app's live render.
      const ours = new Map(rows.map((r) => [r.id.slice(0, 8), r]))
      const labelled = instances.filter((i) => i.label?.startsWith('vastai-blender'))
      // One stdout line so a scripted run can confirm what the sweep saw.
      console.log(
        `[orphans] ${labelled.length} vastai-blender instance(s) on the account, ` +
          `${labelled.filter((i) => held.has(i.id)).length} tracked here: ` +
          labelled.map((i) => `${i.id}(${i.label})`).join(', ')
      )
      // Rows a listed instance's label names: their create went through.
      const found = new Set<string>()
      for (const inst of labelled) {
        if (!inst.label?.startsWith('vastai-blender')) continue
        if (held.has(inst.id) || this.goneChecks.has(inst.id)) continue
        const prefix = inst.label.slice('vastai-blender '.length).trim()
        const row = ours.get(prefix)
        if (!row) {
          emit('alert', {
            level: 'warn',
            message: `instance ${inst.id} (${inst.label}) was not rented by this profile — left running; destroy it from its own app or the Vast.ai console if it is stray`
          })
          continue
        }
        found.add(row.id)
        // This session's rental, whose create has not answered yet, or whose
        // instance is being looked for after a create that got no answer:
        // the instance is the rental's, and rentOffer's lookup takes it
        // from here.
        if (this.creating.has(row.id) || this.lookingUp.has(row.id)) continue
        emit('alert', {
          level: 'warn',
          message: `destroying orphaned instance ${inst.id} (${inst.label})`
        })
        await this.ensureInstanceGone(inst.id, { node: this.claim(row, inst.id) })
      }
      this.settleUnknownCreates(found)
    } catch {
      // no key / offline — retried implicitly on next app start
    }
  }

  /**
   * An orphan the sweep found under the label of one of our rows: record it
   * on that row, so that until Vast confirms it gone it counts against the
   * caps, is metered and is retried like any other failed destroy. The row
   * either never learned the instance id (a create whose reply was lost, or
   * one a crash cut short) or took a destroy as confirmed that Vast now
   * contradicts by listing the instance. A row that holds a different
   * instance keeps it: this one is destroyed with no row to show for it.
   */
  private claim(
    row: { id: string; instance_id: number | null },
    instanceId: number
  ): ManagedNode | undefined {
    if (row.instance_id != null && row.instance_id !== instanceId) return undefined
    getDb()
      .prepare(
        'UPDATE nodes SET instance_id = ?, destroyed_at = NULL, create_unknown_since = NULL WHERE id = ?'
      )
      .run(instanceId, row.id)
    let node = this.nodes.get(row.id)
    if (!node) {
      node = new ManagedNode(row.id)
      this.nodes.set(row.id, node)
    }
    node.emitChanged()
    return node
  }

  /**
   * Rows the last run left with a create of unknown outcome whose label the
   * account's instances do not carry: that create rented nothing, so they
   * stop counting as billing. Without this, each such row (a crash mid-create,
   * a create whose reply was a 5xx) would hold a place under maxActiveNodes
   * and the spend cap for good. Only rows from before this session: the last
   * run is gone, so any create it sent has been answered by now. A create of
   * this session with no known outcome keeps counting until its own label
   * lookup (findLostCreate) settles it.
   */
  private settleUnknownCreates(found: ReadonlySet<string>): void {
    for (const id of this.unknownAtBoot) {
      this.unknownAtBoot.delete(id)
      if (found.has(id)) continue
      const node = this.nodes.get(id)
      if (!node || !createOutcomeUnknown(node.facts)) continue
      const state = node.state
      if (state === 'requested') {
        node.update({
          state: 'failed',
          create_unknown_since: null,
          last_error: 'the app stopped while renting; Vast has no instance under its label'
        })
      } else if (state === 'destroying') {
        node.update({ state: 'destroyed', create_unknown_since: null })
      } else {
        node.update({ create_unknown_since: null })
      }
    }
  }

  shutdown(): void {
    if (this.costTimer) clearInterval(this.costTimer)
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    if (this.destroyTimer) clearInterval(this.destroyTimer)
    for (const n of this.nodes.values()) n.closeSsh()
  }

  /** Sample GPU/CPU/RAM usage on every SSH-connected node. */
  private async pollMetrics(): Promise<void> {
    for (const node of this.nodes.values()) {
      if (
        !node.ssh ||
        !['ready', 'idle', 'rendering', 'encoding', 'provisioning'].includes(node.state)
      )
        continue
      try {
        const r = await node.ssh.exec(
          // `index` goes LAST so the columns everything below reads by position
          // keep their positions.
          `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,index --format=csv,noheader,nounits; echo ----; cat /proc/loadavg; nproc; echo ----; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; head -1 /proc/stat`,
          { timeoutMs: 10_000 }
        )
        const [gpuPart, cpuPart, memPart] = r.stdout.split('----')
        if (!gpuPart || !cpuPart) continue
        // Only the first four columns must parse: cards that don't report
        // power give "[N/A]" and would otherwise drop the whole sample.
        const gpuRows = gpuPart
          .trim()
          .split('\n')
          .map((line) => line.split(',').map((x) => parseFloat(x)))
          .filter((xs) => xs.length >= 4 && xs.slice(0, 4).every((x) => Number.isFinite(x)))
        if (gpuRows.length === 0) continue
        const sumCol = (i: number): number =>
          gpuRows.reduce((a, xs) => a + (Number.isFinite(xs[i]) ? xs[i] : 0), 0)
        const powerW = sumCol(4)
        const cpuLines = cpuPart.trim().split('\n')
        const load1 = parseFloat(cpuLines[0]?.split(' ')[0] ?? '0')
        const cores = parseInt(cpuLines[1] ?? '0', 10)
        // /proc/meminfo is in kB; "used" = total - available (the number that
        // actually predicts an OOM, unlike total - free).
        const meminfo = (key: string): number => {
          const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(memPart ?? '')
          return m ? parseInt(m[1], 10) / (1024 * 1024) : 0
        }
        const ramTotalGb = meminfo('MemTotal')
        const ramAvailGb = meminfo('MemAvailable')
        // Energy: rectangle-integrate this power reading over the gap since
        // the previous sample (skipping absurd gaps after a sleep/disconnect).
        const now = Date.now()
        const prevAt = metricsByNode.get(node.id)?.updatedAt
        const gapMs = prevAt ? now - prevAt : 0
        if (powerW > 0 && gapMs > 0 && gapMs < 10 * 60_000) {
          energyByNode.set(node.id, (energyByNode.get(node.id) ?? 0) + (powerW * gapMs) / 3_600_000)
        }
        metricsByNode.set(node.id, {
          cpuUtil: cpuUtilFromStat(node.id, memPart ?? '', load1, cores),
          gpuUtil: gpuRows.reduce((a, xs) => a + xs[0], 0) / gpuRows.length,
          vramUsedGb: gpuRows.reduce((a, xs) => a + xs[1], 0) / 1024,
          vramTotalGb: gpuRows.reduce((a, xs) => a + xs[2], 0) / 1024,
          gpuTemp: Math.max(...gpuRows.map((xs) => xs[3])),
          powerW,
          powerLimitW: sumCol(5),
          cpuLoad1: Number.isFinite(load1) ? load1 : 0,
          cpuCores: Number.isFinite(cores) ? cores : 0,
          ramUsedGb: Math.max(0, ramTotalGb - ramAvailGb),
          ramTotalGb,
          updatedAt: now,
          gpus: gpuRows.map((xs, i): GpuSample => ({
            index: Number.isFinite(xs[6]) ? xs[6] : i,
            util: xs[0],
            vramUsedGb: xs[1] / 1024,
            vramTotalGb: xs[2] / 1024,
            temp: xs[3],
            powerW: Number.isFinite(xs[4]) ? xs[4] : 0
          }))
        })
        emit('node:changed', node.snapshot)
      } catch {
        // connection hiccup — skip this sample
      }
    }
  }

  list(): NodeSnapshot[] {
    return [...this.nodes.values()].map((n) => n.snapshot)
  }

  get(id: string): ManagedNode | undefined {
    return this.nodes.get(id)
  }

  /**
   * The nodes that count against maxActiveNodes and the spend cap, and their
   * $/hr: every node that may be billing (shared/nodeState.ts
   * countsTowardCaps). That is booting, working and being destroyed, and
   * also 'failed' with its destroy unconfirmed, or with a create whose
   * outcome is unknown. Leaving those out, as each inline list of states
   * here once did, let the scheduler rent a replacement next to an instance
   * that was still billing (#64 #194). scalePolicy can read the same from
   * list() through capacityBudget: snapshots carry destroyedAt and
   * createUnknownSince.
   */
  capUsage(): { nodes: number; perHour: number } {
    return capUsage([...this.nodes.values()].map((n) => n.facts))
  }

  /** Nodes that count against maxActiveNodes: see capUsage. */
  activeCount(): number {
    return this.capUsage().nodes
  }

  /** $/hr of every node that may be billing: see capUsage. */
  billingPerHour(): number {
    return this.capUsage().perHour
  }

  /** Rent the best matching offer and drive it to ready. */
  async requestNode(): Promise<string> {
    const settings = getSettings()
    if (this.activeCount() >= settings.maxActiveNodes) {
      throw new Error(`max active nodes (${settings.maxActiveNodes}) reached`)
    }
    const ids = await this.requestNodes(1, { respectSpendCap: false })
    if (ids.length === 0) throw new Error('no node could be rented')
    return ids[0]
  }

  /**
   * Rent up to `count` nodes from ONE offer search, best-ranked first.
   *
   * One search per batch rather than per node: it is the slow call, and
   * renting down the ranked list is exactly what repeated searches would do
   * anyway. Machines are never rented twice in a batch, and an offer that
   * fails to rent (taken by someone else meanwhile) blacklists its machine and
   * moves on to the next. The caps are re-checked before every rental —
   * maxActiveNodes against the live count, and (unless told otherwise, for
   * the manual button) the spend cap against the running $/hr, allowing a
   * rental while the fleet is still under the cap, as scale-up always has.
   *
   * A create that gets no answer ends the batch (plan 1.4): the instance may
   * exist, billing, under the row's label, and renting the next offer at once
   * is how one lost reply became two instances (#223 #231). The batch waits
   * for the label lookup to find it or confirm there is none, a minute at
   * most. So does a refusal that is no fault of the offer's (a 429): the next
   * offer would meet it too.
   */
  async requestNodes(count: number, opts: { respectSpendCap?: boolean } = {}): Promise<string[]> {
    if (count <= 0) return []
    const settings = getSettings()
    await ensureKeyRegistered()

    const offers = await findOffers(settings.offerFilters, this.blacklist)
    if (offers.length === 0) {
      emit('alert', { level: 'warn', message: 'No matching Vast.ai offers found' })
      throw new Error('no matching offers')
    }
    const ids: string[] = []
    const usedMachines = new Set<number>()
    let lastErr: Error | null = null
    let failures = 0
    for (const offer of offers) {
      if (ids.length >= count) break
      // A systemic refusal (no credit, a bad key) fails every offer the same
      // way; stop before it turns into a failed node row per offer.
      if (failures >= 3) break
      if (this.activeCount() >= settings.maxActiveNodes) break
      if (opts.respectSpendCap !== false && settings.spendCapPerHour != null) {
        if (this.billingPerHour() >= settings.spendCapPerHour) break
      }
      if (usedMachines.has(offer.machineId) || this.blacklist.has(offer.machineId)) continue
      usedMachines.add(offer.machineId)
      let r: Rental
      try {
        r = await this.rentOffer(offer, settings.offerFilters.minDiskGb)
      } catch (e) {
        // Not a failure rentOffer knows (those it returns): whatever it left
        // behind, rent nothing more on top of it.
        r = { error: e as Error, stop: true }
      }
      if ('error' in r) {
        lastErr = r.error
        failures++
      } else {
        ids.push(r.id)
      }
      if (r.stop) break
    }
    if (ids.length === 0 && lastErr) throw lastErr
    return ids
  }

  /** Create an instance from one offer and start driving it to ready. */
  private async rentOffer(offer: Offer, diskGb: number): Promise<Rental> {
    const id = randomUUID()
    const label = `vastai-blender ${id.slice(0, 8)}`
    getDb()
      .prepare(
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost, blender_versions, geolocation, label, create_unknown_since)
         VALUES (?, 'requested', ?, ?, ?, 0, '[]', ?, ?, ?)`
      )
      // The offer is the only place vast.ai ever tells us where the machine is
      // — /instances/ doesn't report it — so capture it at rent time or lose it.
      // create_unknown_since: from here until Vast answers, an instance may
      // exist under `label` that no row knows the id of.
      .run(id, offer.gpuName, offer.numGpus, offer.dphTotal, offer.geolocation, label, Date.now())
    const node = new ManagedNode(id)
    this.nodes.set(id, node)
    this.creating.add(id)
    emit('node:changed', node.snapshot)

    let instanceId: number
    try {
      instanceId = await createInstance({
        offerId: offer.id,
        image: DOCKER_IMAGE,
        diskGb,
        onstart: ONSTART,
        env: { NVIDIA_DRIVER_CAPABILITIES: 'all' },
        label
      })
    } catch (e) {
      this.creating.delete(id)
      return this.createFailed(node, offer.machineId, e as Error)
    }
    this.creating.delete(id)
    node.update({ instance_id: instanceId, create_unknown_since: null })
    // The row is in the Fleet, destroy button and all, from before the
    // create; a destroy that landed while it was in flight found no
    // instance id and so destroyed nothing (and nothing else would ever
    // touch the instance: the orphan sweep leaves an instance its row
    // holds alone). The instance is ours to kill.
    if (node.gone) {
      await this.ensureInstanceGone(instanceId, { node })
      return { id }
    }
    void this.driveToReady(node, offer.machineId)
    return { id }
  }

  /**
   * The create threw. What that means turns on whether Vast answered it
   * (classify's outcomeUnknown):
   *
   * - No answer that says what happened (a lost reply, a 5xx, a timeout, a
   *   reply that is not JSON): the instance may exist. findLostCreate looks
   *   for it by its label, and the batch stops (plan 1.4).
   * - Vast answered, or the create was never sent (no API key, a name that
   *   did not resolve): nothing was rented, and the row stops counting as
   *   billing.
   *
   * Destroyed while the create was in flight: the user cancelled this
   * rental. That is no fault of the machine's (no blacklist), and it must not
   * be replaced by the next offer (its row is returned, as the success path
   * returns it).
   */
  private async createFailed(node: ManagedNode, machineId: number, e: Error): Promise<Rental> {
    const c = classify(e, { via: 'vast' })
    if (c.outcomeUnknown) return this.createUnanswered(node, machineId, c.reason, e)
    if (node.gone) {
      node.update({ create_unknown_since: null })
      return { id: node.id }
    }
    node.update({ state: 'failed', last_error: e.message, create_unknown_since: null })
    // Refused before anything was done (a 429), or never sent (a name that
    // did not resolve). Not this machine's doing, and the next offer would
    // meet the same. Asking again once PUT /asks is refused is the next
    // batch's call, never the client's (vastClient never repeats a create).
    if (c.kind === 'transient') return { error: e, stop: true }
    this.blacklist.add(machineId)
    return { error: e }
  }

  /**
   * Plan 1.4: the create got no answer (#223 #231). It used to be recorded
   * as "not rented", and the batch rented the next offer at once, while an
   * instance Vast had rented billed under the row's label, known to nobody
   * until the next start's orphan sweep.
   *
   * Now the row keeps create_unknown_since, so it counts against the caps
   * and in the fleet $/hr all along, and findLostCreate looks for the
   * instance by its label. The batch waits for the answer, a minute at most
   * (CREATE_LOOKUP_MS). If Vast has not answered by then the lookup goes on
   * in the background, the row still counted, and the batch ends without it.
   * Never a second PUT /asks: that would rent a second instance.
   */
  private async createUnanswered(
    node: ManagedNode,
    machineId: number,
    reason: string,
    e: Error
  ): Promise<Rental> {
    const id = node.id
    const label = node.snapshot.label ?? `vastai-blender ${id.slice(0, 8)}`
    this.lookingUp.add(id)
    // Cancelled while the create was in flight: 'destroying', not the
    // 'destroyed' destroyNode left it in, since there may be an instance to
    // destroy, and the row shows so until the lookup knows.
    if (node.gone) {
      node.setState(
        'destroying',
        `cancelled while renting, and Vast did not answer the create (${reason})`
      )
    } else {
      node.update({
        last_error: `Vast did not answer the create (${reason}); looking for its instance by label`
      })
    }
    let windowOver: () => void = () => {}
    const unanswered = new Promise<'unanswered'>((r) => (windowOver = () => r('unanswered')))
    const lookup = this.findLostCreate(node, label, machineId, reason, () => windowOver())
    const outcome = await Promise.race([lookup, unanswered])
    // Found and used, found and destroyed (cancelled), or cancelled and still
    // looked for: its row stands for the rental, as in createFailed.
    if (outcome === 'adopted' || outcome === 'destroyed' || node.gone) return { id, stop: true }
    const error =
      outcome === 'unanswered'
        ? new Error(
            `Vast.ai did not answer the create (${reason}), nor for a minute the search for its instance: "${label}" counts as billing while the app keeps looking`,
            { cause: e }
          )
        : new Error(
            `Vast.ai did not answer the create (${reason}), and no instance appeared under its label: nothing was rented`,
            { cause: e }
          )
    return { error, stop: true }
  }

  /**
   * Look for the instance of a create that got no answer, by its label, and
   * settle its row by what is found. listInstances is asked from at once,
   * backing off from 2 s to 15 s:
   *
   * - Listed: the create went through. The row takes the instance id
   *   (claim), and the rental carries on to ready as if the reply had come
   *   ('adopted'), unless it was cancelled meanwhile: then the instance is
   *   destroyed ('destroyed').
   * - Not listed by any answer asked for CREATE_LOOKUP_MS or more after the
   *   lookup began: the create rented nothing ('absent'). The row stops
   *   counting: 'failed' with the reason, or 'destroyed' if cancelled.
   * - Vast not answering says nothing either way. After the window the user
   *   is told once (`onUnanswered` too), and the lookup asks every
   *   LOOKUP_SLOW_MS until Vast answers, the row counted as billing all the
   *   while.
   *
   * Never rejects.
   */
  private async findLostCreate(
    node: ManagedNode,
    label: string,
    machineId: number,
    reason: string,
    onUnanswered: () => void
  ): Promise<'adopted' | 'destroyed' | 'absent'> {
    const start = Date.now()
    let delay = LOOKUP_FIRST_DELAY_MS
    let unanswered = false
    try {
      for (;;) {
        const asked = Date.now()
        let listed: RawInstance[] | null = null
        try {
          listed = await listInstances()
        } catch {
          // No answer: nothing learned either way.
        }
        if (listed) {
          const inst = listed.find((i) => i.label === label)
          if (inst) return await this.adoptLostCreate(node, inst.id, machineId, unanswered)
          if (asked - start >= CREATE_LOOKUP_MS) {
            this.noLostCreate(node, label, reason, unanswered)
            return 'absent'
          }
        } else if (!unanswered && Date.now() - start >= CREATE_LOOKUP_MS) {
          unanswered = true
          this.lostCreateUnanswered(node, label, reason)
          onUnanswered()
        }
        // One look lands at the window's end, so absence is known then.
        const toWindowEnd = start + CREATE_LOOKUP_MS - Date.now()
        await sleep(
          unanswered ? LOOKUP_SLOW_MS : toWindowEnd > 0 ? Math.min(delay, toWindowEnd) : delay
        )
        delay = Math.min(delay * 2, LOOKUP_MAX_DELAY_MS)
      }
    } finally {
      this.lookingUp.delete(node.id)
    }
  }

  /** The lost create's instance was found: the row takes it, and uses or destroys it. */
  private async adoptLostCreate(
    node: ManagedNode,
    instanceId: number,
    machineId: number,
    toldUser: boolean
  ): Promise<'adopted' | 'destroyed'> {
    this.claim({ id: node.id, instance_id: null }, instanceId)
    const label = node.snapshot.label
    if (node.state === 'requested') {
      node.update({ last_error: null })
      emit('alert', {
        level: 'info',
        message: `Found instance ${instanceId} (${label}): Vast rented it although its create got no answer. Using it.`
      })
      void this.driveToReady(node, machineId)
      return 'adopted'
    }
    if (toldUser) {
      emit('alert', {
        level: 'info',
        message: `Found instance ${instanceId} (${label}), whose create got no answer: destroying it`
      })
    }
    await this.ensureInstanceGone(instanceId, { node })
    return 'destroyed'
  }

  /** Vast answered, a minute on, without the lost create's label: nothing was rented. */
  private noLostCreate(node: ManagedNode, label: string, reason: string, toldUser: boolean): void {
    if (node.state === 'requested') {
      node.update({
        state: 'failed',
        create_unknown_since: null,
        last_error: `Vast did not answer the create (${reason}), and no instance appeared under its label: nothing was rented`
      })
    } else {
      node.update({ state: 'destroyed', create_unknown_since: null, last_error: null })
    }
    if (toldUser) {
      emit('alert', {
        level: 'info',
        message: `No instance "${label}" on Vast: the create that got no answer rented nothing`
      })
    }
  }

  /**
   * A minute gone and Vast has not answered the lookup: say so, once. A
   * rental the user cancelled is a billing risk nothing may be managing if
   * the app is closed now; one still wanted is counted, and the lookup keeps
   * at it.
   */
  private lostCreateUnanswered(node: ManagedNode, label: string, reason: string): void {
    const wanted = node.state === 'requested'
    emit('alert', {
      level: wanted ? 'warn' : 'error',
      message: wanted
        ? `Vast.ai has not said whether the rental "${label}" went through (${reason}). It counts as billing until the app finds its instance or finds there is none, and the app keeps looking — check the Vast.ai console if this lasts.`
        : `A rental cancelled mid-create may be billing: Vast.ai has not said whether its create went through (${reason}). The app keeps looking for "${label}" to destroy it — check the Vast.ai console!`
    })
  }

  /**
   * Make sure a Vast instance is gone, and record that only once it is: the
   * one destroy path (plan 1.2), for destroyNode, clearFailed, the failure
   * paths of driveToReady and recoverUnreachable, a rental destroyed while
   * its create was in flight, the retry timer and the orphan sweep. Each of
   * those used to send one DELETE of its own and trust the answer, so one
   * Vast blip left an instance billing that the app had written off, and a
   * 404 on an instance already gone raised a false "check the console" (#34
   * #64 #140 #194).
   *
   * - With `node`, and SSH having answered on it, OctaneServer is stopped
   *   first, bounded, so it can release its floating license. The node's
   *   connection is then closed: nothing may use it on a dying box.
   * - DELETE is retried with backoff on anything classify() calls transient
   *   (a network error, a 5xx, a 429, a timeout) for `budgetMs`. A 404 means
   *   gone. A DELETE Vast accepted is confirmed with showInstance, since a
   *   200 can leave the instance running.
   * - Confirmed: every row holding the instance is stamped destroyed_at and
   *   set 'destroyed'. That stamp is what stops a node counting as billing
   *   (shared/nodeState.ts holdsInstance), and nothing else stamps it.
   * - Not confirmed: every row holding it is 'failed', still counted against
   *   the caps and metered, and retryDestroys tries again every minute until
   *   it is confirmed. The user is told; the retries (`quiet`) do not tell
   *   them again, and they hear when it is confirmed.
   *
   * Resolves true once the instance is confirmed gone; never rejects. A call
   * for an instance already being destroyed waits on that one.
   */
  ensureInstanceGone(
    instanceId: number,
    opts: { node?: ManagedNode; budgetMs?: number; quiet?: boolean } = {}
  ): Promise<boolean> {
    const running = this.goneChecks.get(instanceId)
    if (running) return running
    const check = this.destroyUntilGone(instanceId, opts).finally(() =>
      this.goneChecks.delete(instanceId)
    )
    this.goneChecks.set(instanceId, check)
    return check
  }

  private async destroyUntilGone(
    instanceId: number,
    opts: { node?: ManagedNode; budgetMs?: number; quiet?: boolean }
  ): Promise<boolean> {
    const { node } = opts
    if (node) {
      // Best effort: nothing about the license may stand between the
      // instance and its DELETE.
      await this.stopOctane(node).catch(() => {})
      node.closeSsh()
    }
    let last: unknown = null
    try {
      await retryWithBackoff(
        async () => {
          try {
            await destroyInstance(instanceId)
          } catch (e) {
            if (e instanceof VastError && e.status === 404) return
            last = e
            throw e
          }
          let still: RawInstance | null
          try {
            still = await showInstance(instanceId)
          } catch (e) {
            last = e
            throw e
          }
          if (still) {
            last = new InstanceStillListed(instanceId, still.actual_status)
            throw last
          }
        },
        {
          budgetMs: opts.budgetMs ?? DESTROY_BUDGET_MS,
          initialDelayMs: DESTROY_FIRST_DELAY_MS,
          maxDelayMs: DESTROY_MAX_DELAY_MS,
          isRetryable: (e) =>
            e instanceof InstanceStillListed || classify(e, { via: 'vast' }).kind === 'transient'
        }
      )
    } catch (e) {
      this.destroyUnconfirmed(instanceId, last ?? e, opts.quiet === true)
      return false
    }
    this.instanceGone(instanceId)
    return true
  }

  /**
   * Stop OctaneServer before its instance goes, so its floating license is
   * released rather than held until OTOY times it out. Only where SSH has
   * answered (nothing can run on a node where it never has) and over the
   * node's own connection, which exec reconnects if it dropped. The script
   * runs only when the node has an OctaneServer pidfile, and a wedged or dead
   * node holds the destroy up for OCTANE_STOP_BUDGET_MS at most.
   */
  private async stopOctane(node: ManagedNode): Promise<void> {
    const ssh = node.ssh
    if (!ssh || !node.sshEverAnswered) return
    const { closeVncTunnel, stopOctaneServer } = await import('../octane/octaneLicense')
    closeVncTunnel(node.id)
    await stopOctaneServer(ssh, { timeoutMs: OCTANE_STOP_BUDGET_MS, onlyIfStarted: true })
  }

  /** The managed nodes whose row holds `instanceId` unconfirmed. */
  private holders(instanceId: number): ManagedNode[] {
    const ids = getDb()
      .prepare('SELECT id FROM nodes WHERE instance_id = ? AND destroyed_at IS NULL')
      .all(instanceId) as Array<{ id: string }>
    return ids.map((r) => {
      // Every row that holds an instance is managed (init, claim); a row
      // that somehow is not joins the map, so the retry timer finds it.
      let n = this.nodes.get(r.id)
      if (!n) {
        n = new ManagedNode(r.id)
        this.nodes.set(r.id, n)
      }
      return n
    })
  }

  /**
   * Vast confirmed the instance gone: a 404, or showInstance no longer finds
   * it. Stamp destroyed_at on every row holding it; only this settles them.
   */
  private instanceGone(instanceId: number, lastError: string | null = null): void {
    const now = Date.now()
    for (const n of this.holders(instanceId)) {
      n.update({ state: 'destroyed', destroyed_at: now, last_error: lastError })
    }
    if (this.unconfirmedAlerted.delete(instanceId)) {
      emit('alert', {
        level: 'info',
        message: `Instance ${instanceId} is destroyed now: Vast has confirmed it gone`
      })
    }
  }

  /**
   * The destroy went unconfirmed: Vast refused it, kept failing, or still
   * lists the instance. Its rows go (or stay) 'failed' holding the instance,
   * which counts it and meters it, and retryDestroys goes on trying.
   */
  private destroyUnconfirmed(instanceId: number, e: unknown, quiet: boolean): void {
    const reason =
      e instanceof InstanceStillListed ? e.message : classify(e, { via: 'vast' }).reason
    const holders = this.holders(instanceId)
    for (const n of holders) n.update({ state: 'failed', last_error: `destroy failed: ${reason}` })
    if (holders.length === 0) {
      // Only the orphan sweep destroys an instance no row holds.
      emit('alert', {
        level: 'error',
        message: `orphan destroy failed for ${instanceId}: ${reason} — check the Vast.ai console!`
      })
      return
    }
    if (quiet && this.unconfirmedAlerted.has(instanceId)) return
    this.unconfirmedAlerted.add(instanceId)
    emit('alert', {
      level: 'error',
      message: `Destroy failed for instance ${instanceId} (${reason}). It may still be billing; the app retries every minute — check the Vast.ai console!`
    })
  }

  /**
   * Try again to destroy every node whose destroy Vast has not confirmed:
   * one the app was destroying, one that failed holding its instance, and
   * one 'destroyed' by a build that took the DELETE's word for it. From
   * init with a full budget, then from the timer with one attempt per node
   * per round. One node at a time: Vast rate-limits DELETE, and a round
   * still running when the timer fires again is left to finish.
   */
  private async retryDestroys(budgetMs: number): Promise<void> {
    if (this.retryingDestroys) return
    this.retryingDestroys = true
    try {
      for (const node of [...this.nodes.values()]) {
        const f = node.facts
        if (f.instanceId == null || !holdsInstance(f) || !DESTROY_STATES.has(f.state)) continue
        await this.ensureInstanceGone(f.instanceId, { node, budgetMs, quiet: true })
      }
    } finally {
      this.retryingDestroys = false
    }
  }

  /** Poll vast until running + SSH reachable, then hand to provisioning. */
  private async driveToReady(node: ManagedNode, machineId: number | null): Promise<void> {
    const instanceId = node.snapshot.instanceId
    if (!instanceId) return
    // A backstop no caller reaches today. Callers hand over a node they have
    // just put in 'requested', never one destroyNode is destroying (which
    // reads the id from the row and destroys the instance itself). So a node
    // already gone here was destroyed before its instance id was recorded,
    // the race rentOffer checks for too, and nothing has destroyed the
    // instance. A caller that broke that rule would only join destroyNode's
    // ensureInstanceGone, or find the instance gone (a 404, which is done).
    if (node.gone) {
      await this.ensureInstanceGone(instanceId, { node })
      return
    }
    // The state this run holds the node in: 'requested' until SSH answers,
    // then 'provisioning'. A destroy from here on moves the node off it and
    // is destroyNode's to finish, so the returns below leave the node and
    // its instance alone (see movedOn).
    let held: NodeState = node.state
    const deadline = Date.now() + 8 * 60_000
    // The status poll's failure while Vast is not answering it, if the boot
    // ends on one: not the machine's doing, so no blacklist below.
    let vastSilent: unknown = null
    try {
      let inst: RawInstance | null = null
      for (;;) {
        if (node.movedOn(held)) return
        try {
          inst = await showInstance(instanceId)
          vastSilent = null
        } catch (e) {
          // A Vast blip (a 5xx, a 429, a timeout, this computer's network)
          // says nothing about the instance. It used to fail the node here,
          // blacklist a good machine and destroy an instance whose image pull
          // was already paid for (#39 #236). Poll on until the deadline; any
          // other answer (a key Vast refuses) ends the boot as before.
          if (!vastDown(e)) throw e
          vastSilent = e
          emit('render:logLine', {
            nodeId: node.id,
            chunkId: null,
            line: `Vast.ai did not answer the status poll (${classify(e, { via: 'vast' }).reason}) — polling on`,
            ts: Date.now()
          })
        }
        if (!vastSilent && inst?.actual_status === 'running') {
          const eps = sshEndpoints(inst)
          if (eps.length > 0) break
        }
        if (Date.now() > deadline) {
          if (vastSilent) throw vastSilent
          throw new Error(
            `instance not running after 8 min (status: ${inst?.actual_status ?? 'unknown'})`
          )
        }
        await sleep(10_000)
      }

      const startedAt = inst!.start_date ? Math.round(inst!.start_date * 1000) : Date.now()
      // "running" means the container started, not that sshd is listening: the
      // first attempt is routinely refused. Retry every endpoint (direct
      // preferred, proxy fallback) with backoff for a few minutes, re-reading
      // the instance each round in case its endpoints moved.
      let endpoints = sshEndpoints(inst!)
      await retryWithBackoff(
        async (attempt) => {
          if (attempt > 1) {
            const fresh = await showInstance(instanceId).catch(() => null)
            const eps = fresh ? sshEndpoints(fresh) : []
            if (eps.length > 0) endpoints = eps
          }
          let lastErr: Error | null = null
          for (const ep of endpoints) {
            node.update({ ssh_host: ep.host, ssh_port: ep.port, started_at: startedAt })
            try {
              node.closeSsh()
              const ssh = await node.connectSsh()
              const r = await ssh.exec(
                'echo ok && cat /proc/driver/nvidia/version 2>/dev/null | head -1',
                { timeoutMs: 30_000 }
              )
              if (r.stdout.includes('ok')) return
              lastErr = new Error(`unexpected echo result: ${r.stderr || r.stdout}`)
            } catch (e) {
              lastErr = e as Error
            }
          }
          throw lastErr ?? new Error('no SSH endpoints')
        },
        {
          budgetMs: FIRST_CONNECT_BUDGET_MS,
          initialDelayMs: 5_000,
          maxDelayMs: 30_000,
          shouldAbort: () => node.movedOn(held),
          onRetry: (e, n, delayMs) =>
            emit('render:logLine', {
              nodeId: node.id,
              chunkId: null,
              line: `ssh attempt ${n} failed (${e.message}) — retrying in ${Math.round(delayMs / 1000)}s`,
              ts: Date.now()
            })
        }
      )

      // shouldAbort is only asked between attempts. A destroy that lands
      // during one closes the node's connection, but the attempt then opens a
      // fresh one on its next endpoint, and that can succeed while the
      // instance is still being torn down (or is still up: its DELETE
      // failed). Going on would bring the node back as 'provisioning' over
      // the destroy's state; drop the connection.
      if (node.movedOn(held)) {
        node.closeSsh()
        return
      }
      node.setState('provisioning')
      held = 'provisioning'
      if (this.onReady && node.ssh) {
        await this.onReady({ id: node.id, ssh: node.ssh })
      }
      // Provisioning takes minutes, plenty of time to be destroyed in; a
      // node that was must not end 'ready', where the scheduler would use it.
      if (node.movedOn(held)) return
      node.setState('ready')
      emit('alert', { level: 'info', message: `Node ${node.snapshot.gpuName} ready` })
    } catch (e) {
      // Destroyed meanwhile: the retry gave up because of it (RetryAbortedError),
      // or the connection destroyNode closed failed a command. Neither is the
      // node failing. No 'failed' over the destroy's state, no blacklisted
      // machine, no error alert, and no second destroy racing destroyNode's.
      // A destroy Vast never confirmed has left the node 'failed' with its
      // instance id, which the retry timer and clearFailed retry.
      if (node.movedOn(held)) return
      node.setState('failed', (e as Error).message)
      // Vast silent for the whole boot says nothing against the machine.
      if (machineId != null && e !== vastSilent) this.blacklist.add(machineId)
      emit('alert', { level: 'error', message: `Node failed: ${(e as Error).message}` })
      // Clean up the rented instance — never leave a failed node billing.
      await this.ensureInstanceGone(instanceId, { node })
    }
  }

  /**
   * resumeNode's question to Vast about a node's instance, asked until Vast
   * answers it: the instance, or null when Vast no longer knows it (gone).
   * Undefined if the node was destroyed meanwhile.
   *
   * No answer (Vast or this computer's network down, a 5xx, a key Vast
   * refuses) says nothing about the instance: the control plane being down
   * is not the instance being gone. It used to send the node to
   * recoverUnreachable, which marked it 'ready' without re-provisioning when
   * SSH worked, and 'failed', uncounted and still billing, when it did not
   * (#33, audit A8). Now the node waits 'unreachable', counted as billing and
   * given no work, and Vast is asked again, from 5 s backing off to a
   * minute, for as long as it takes.
   */
  private async askUntilAnswered(
    node: ManagedNode,
    instanceId: number,
    held: NodeState
  ): Promise<RawInstance | null | undefined> {
    let delay = RESUME_FIRST_DELAY_MS
    let waiting = false
    for (;;) {
      try {
        const inst = await showInstance(instanceId)
        return node.movedOn(held) ? undefined : inst
      } catch (e) {
        if (node.movedOn(held)) return undefined
        if (!waiting) {
          waiting = true
          const reason = classify(e, { via: 'vast' }).reason
          node.setState(
            'unreachable',
            `Vast.ai did not answer about instance ${instanceId} at start-up (${reason}); asking again`
          )
          held = 'unreachable'
        }
      }
      await sleep(delay)
      delay = Math.min(delay * 2, RESUME_MAX_DELAY_MS)
      if (node.movedOn(held)) return undefined
    }
  }

  /** Re-attach to an instance after app restart. */
  private async resumeNode(node: ManagedNode): Promise<void> {
    const instanceId = node.snapshot.instanceId
    if (!instanceId) {
      node.setState('failed', 'no instance id at resume')
      return
    }
    // The Fleet shows the row, destroy button and all, from start-up, and a
    // resume takes minutes when it re-provisions. So, as in driveToReady,
    // every await below is followed by a check that the node is still in the
    // state this step holds it in: first the one the last exit left it in.
    let held: NodeState = node.state
    try {
      const inst = await this.askUntilAnswered(node, instanceId, held)
      if (inst === undefined) return
      held = node.state
      if (!inst) {
        // Vast no longer knows the instance: that confirms it gone.
        this.instanceGone(instanceId, 'instance missing at resume')
        return
      }
      if (inst.actual_status !== 'running') {
        // Still booting (or wedged) — never leave it billing: drive it like a
        // fresh request (poll → ready) with the same timeout + destroy path.
        node.setState('requested', `resumed while ${inst.actual_status ?? 'unknown'}`)
        void this.driveToReady(node, inst.machine_id ?? null)
        return
      }
      // 'provisioning' BEFORE the SSH handle exists — never 'ready' early.
      // The node row still carries its pre-restart state ('ready' or
      // 'rendering'), and the scheduler dispatches to any such node the
      // moment `.ssh` is set; a dispatch racing provisionBase corrupts
      // state: the base setup clears the job inbox (deleting freshly
      // written specs → "No such file" renames or silently stranded chunks)
      // and restarts the agent underneath the dispatch.
      node.setState('provisioning')
      held = 'provisioning'
      const ssh = await node.connectSsh()
      if (node.movedOn(held)) {
        // destroyNode closed this connection while it was connecting, and a
        // connect in flight still lands on a closed SshConnection: end the
        // session it opened to the dying box.
        ssh.close()
        return
      }
      const r = await ssh.exec('echo ok', { timeoutMs: 30_000 })
      if (node.movedOn(held)) return
      if (!r.stdout.includes('ok')) throw new Error('echo failed')
      if (this.onReady && node.ssh) {
        await this.onReady({ id: node.id, ssh: node.ssh })
      }
      // Destroyed while provisioning: not 'ready', where the scheduler would
      // dispatch to it and scale-down would destroy it a second time.
      if (node.movedOn(held)) return
      node.setState('ready')
    } catch (e) {
      // The destroy closed the connection under the connect, the echo or
      // provisioning. That is not the node becoming unreachable: no
      // 'unreachable' over the destroy's state, and no recovery that would
      // end 'failed' and destroy the instance again.
      if (node.movedOn(held)) return
      node.setState('unreachable', (e as Error).message)
      void this.recoverUnreachable(node)
    }
  }

  private async recoverUnreachable(node: ManagedNode): Promise<void> {
    // 'unreachable', set by resumeNode just now. See movedOn.
    const held = node.state
    try {
      const ssh = node.ssh ?? (await node.connectSsh())
      // Closed by destroyNode mid-connect, as in resumeNode: end the session
      // the connect opened anyway.
      if (node.movedOn(held)) {
        ssh.close()
        return
      }
      await ssh.reconnectWithBackoff()
      if (node.movedOn(held)) {
        ssh.close()
        return
      }
      node.setState('ready')
    } catch (e) {
      // Destroyed meanwhile: destroyNode closed the connection the reconnect
      // was retrying on, which is what ended it. The destroy is not this
      // node failing, and destroying the instance again here would only
      // join destroyNode's.
      if (node.movedOn(held)) return
      node.setState('failed', (e as Error).message)
      // A node that dies mid-render never reaches destroyNode, so the
      // scheduler would otherwise keep polling a dead connection for chunks
      // this node can no longer finish. Release them here too so they requeue
      // onto a surviving node.
      forgetNodeProvider?.(node.id)
      // ...and then stop paying for it. Same guarantee as driveToReady's catch:
      // nothing else destroys a node that fails this way, since scale-down
      // takes only idle nodes. Its connection is the one that just died, so
      // it is closed first: an Octane stop over it would only wait out its
      // budget before the destroy.
      const instanceId = node.snapshot.instanceId
      node.closeSsh()
      if (instanceId) await this.ensureInstanceGone(instanceId, { node })
    }
  }

  /**
   * Destroy a node's instance (ensureInstanceGone). Resolves once Vast has
   * confirmed it gone, or once `budgetMs` (default DESTROY_BUDGET_MS) of
   * retrying transient failures has passed without that: the node is then
   * 'failed', still counted as billing, and the retry timer carries on. A
   * caller with a deadline of its own (quit's destroy-all) passes it; 0 is
   * one attempt. A refused DELETE (a 4xx) is never retried within the call.
   */
  async destroyNode(id: string, opts: { budgetMs?: number } = {}): Promise<void> {
    const node = this.nodes.get(id)
    if (!node) return
    const facts = node.facts
    // Already confirmed gone (the button pressed twice, #113): nothing to do,
    // and a second DELETE would only be a 404.
    if (facts.state === 'destroyed' && !holdsInstance(facts)) return
    const instanceId = facts.instanceId
    // A create that got no answer, whose instance is being looked for by its
    // label (plan 1.4): there is no id to destroy yet. 'destroying' until the
    // lookup knows: it destroys the instance if it finds one, and settles the
    // row 'destroyed' if there is none.
    if (instanceId == null && this.lookingUp.has(id)) {
      forgetNodeProvider?.(id)
      node.setState('destroying')
      return
    }
    // A create the last run never heard back from, not yet looked for (the
    // start-up sweep settles it): there is no id to destroy. The row stays
    // as it is, visible and counted as billing, until the instance is found
    // by its label. 'destroyed' would hide from the Fleet a row that still
    // counts against the caps.
    if (instanceId == null && createOutcomeUnknown(facts) && !this.creating.has(id)) {
      emit('alert', {
        level: 'warn',
        message: `Node ${id.slice(0, 8)} has no instance id to destroy: Vast never answered its create. Check the Vast.ai console for "${node.snapshot.label ?? `vastai-blender ${id.slice(0, 8)}`}".`
      })
      return
    }
    forgetNodeProvider?.(id)
    node.setState('destroying')
    if (instanceId == null) {
      // Not rented yet: its create is still in flight, and rentOffer destroys
      // whatever that returns once it sees the node gone.
      node.closeSsh()
      node.setState('destroyed')
      return
    }
    // Octane drain ordering (a clean OctaneServer exit releases the floating
    // license before the instance goes) is ensureInstanceGone's.
    await this.ensureInstanceGone(instanceId, { node, budgetMs: opts.budgetMs })
  }

  /**
   * Retire every 'failed' node. A failed node can still own a billing
   * instance (a destroy Vast never confirmed), so re-attempt the destroy
   * rather than just hiding the row; one that still won't die stays 'failed'
   * and alerts. One whose create has an unknown outcome has no id to destroy
   * and stays too (see destroyNode). Returns how many were retired.
   */
  async clearFailed(): Promise<number> {
    const failed = [...this.nodes.values()].filter((n) => n.state === 'failed')
    const results = await Promise.allSettled(
      failed.map(async (node) => {
        forgetNodeProvider?.(node.id)
        const f = node.facts
        if (f.instanceId != null && holdsInstance(f)) {
          return this.ensureInstanceGone(f.instanceId, { node })
        }
        if (createOutcomeUnknown(f)) return false
        node.closeSsh()
        node.setState('destroyed')
        return true
      })
    )
    return results.filter((r) => r.status === 'fulfilled' && r.value).length
  }

  /** Accumulate $ cost from dph × elapsed and push the fleet totals. */
  private async accrueCosts(): Promise<void> {
    const db = getDb()
    const ts = Date.now() // one timestamp for the tick, so buckets line up
    const usage: UsageRow[] = []
    const facts: NodeCostFacts[] = []
    for (const node of this.nodes.values()) {
      const s = node.snapshot
      facts.push(s)
      // Metered while it may be billing, whatever its state: a 'failed' node
      // whose destroy Vast never confirmed is billed all the same, and
      // skipping it hid the leak from History and the session total (#64).
      // From when Vast started it: a node still booting is in the fleet
      // $/hr below but not yet charged here.
      if (!holdsInstance(s) || s.dphTotal == null || !s.startedAt) continue
      const delta = s.dphTotal / 60 // one minute tick
      node.update({ accumulated_cost: s.accumulatedCost + delta })
      db.prepare(
        'INSERT INTO cost_log (node_id, ts, dph_total, delta_cost) VALUES (?, ?, ?, ?)'
      ).run(s.id, ts, s.dphTotal, delta)
      usage.push(...splitUsage(s.id, ts, delta, flushEnergy(s.id)))
    }
    writeUsage(usage)
    const sessionTotal = (
      db.prepare('SELECT COALESCE(SUM(delta_cost), 0) AS t FROM cost_log').get() as { t: number }
    ).t
    try {
      const u = await currentUser()
      const credit = u.credit ?? u.balance
      if (credit != null) {
        this.balance = Number(credit)
        recordBalance(ts, this.balance)
      }
    } catch {
      // keep last known balance (no key / offline)
    }
    emit('fleet:cost', {
      // The fleet rate the caps use: every node that may be billing.
      perHour: capUsage(facts).perHour,
      sessionTotal,
      sessionWh: sessionEnergyWh(),
      sessionCo2g: sessionCo2Grams(),
      balance: this.balance
    })
  }
}

export const nodeManager = new NodeManager()
