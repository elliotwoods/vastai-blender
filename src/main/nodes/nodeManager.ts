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
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { ensureKeyRegistered, readPrivateKey } from '../ssh/keys'
import { SshConnection } from '../ssh/sshConnection'
import { findOffers } from '../vast/offers'
import {
  createInstance,
  currentUser,
  destroyInstance,
  listInstances,
  sshEndpoints,
  showInstance
} from '../vast/vastClient'
import type { NodeMetrics, NodeSnapshot, NodeState, NodeWorkRef } from '../../shared/models'
import type { RawInstance } from '../vast/types'

export const DOCKER_IMAGE = 'vastai/base-image:cuda-12.1.1-cudnn8-devel-ubuntu22.04'

/** Minimal onstart — real provisioning is pushed over SSH by the app. */
const ONSTART = 'mkdir -p ~/vastai && touch ~/vastai/.booted'

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
    metrics: metricsByNode.get(r.id) ?? null
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
  private balance: number | null = null
  /** Phase 3 hook: called when a node reaches SSH-reachable. */
  onReady: ((node: { id: string; ssh: SshConnection }) => Promise<void>) | null = null

  init(): void {
    const rows = getDb().prepare('SELECT * FROM nodes').all() as NodeRow[]
    for (const r of rows) {
      if (r.state === 'destroyed') continue
      const n = new ManagedNode(r.id)
      this.nodes.set(r.id, n)
      // Anything mid-lifecycle at boot needs re-verification against vast.
      if (r.instance_id && r.state !== 'failed') {
        void this.resumeNode(n)
      }
    }
    this.costTimer = setInterval(() => void this.accrueCosts(), 60_000)
    this.metricsTimer = setInterval(() => void this.pollMetrics(), 15_000)
    void this.reconcileOrphans()
  }

  /**
   * Billing-leak protection: destroy any instance labelled by this app that
   * no live node row tracks (e.g. a node marked failed before its destroy
   * completed, or created moments before a crash). Never touches instances
   * without our label — the account may host unrelated workloads.
   */
  private async reconcileOrphans(): Promise<void> {
    try {
      const instances = await listInstances()
      const tracked = new Set(
        [...this.nodes.values()]
          .filter((n) => !['destroyed', 'failed'].includes(n.state))
          .map((n) => n.snapshot.instanceId)
      )
      for (const inst of instances) {
        if (!inst.label?.startsWith('vastai-blender')) continue
        if (tracked.has(inst.id)) continue
        emit('alert', {
          level: 'warn',
          message: `destroying orphaned instance ${inst.id} (${inst.label})`
        })
        try {
          await destroyInstance(inst.id)
          getDb().prepare("UPDATE nodes SET state = 'destroyed' WHERE instance_id = ?").run(inst.id)
        } catch (e) {
          emit('alert', {
            level: 'error',
            message: `orphan destroy failed for ${inst.id}: ${(e as Error).message} — check the Vast.ai console!`
          })
        }
      }
    } catch {
      // no key / offline — retried implicitly on next app start
    }
  }

  shutdown(): void {
    if (this.costTimer) clearInterval(this.costTimer)
    if (this.metricsTimer) clearInterval(this.metricsTimer)
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
          `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits; echo ----; cat /proc/loadavg; nproc; echo ----; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; head -1 /proc/stat`,
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
          updatedAt: now
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

  activeCount(): number {
    return [...this.nodes.values()].filter(
      (n) => !['destroyed', 'destroying', 'failed'].includes(n.state)
    ).length
  }

  /** Rent the best matching offer and drive it to ready. */
  async requestNode(): Promise<string> {
    const settings = getSettings()
    if (this.activeCount() >= settings.maxActiveNodes) {
      throw new Error(`max active nodes (${settings.maxActiveNodes}) reached`)
    }
    await ensureKeyRegistered()

    const offers = await findOffers(settings.offerFilters, this.blacklist)
    if (offers.length === 0) {
      emit('alert', { level: 'warn', message: 'No matching Vast.ai offers found' })
      throw new Error('no matching offers')
    }
    const offer = offers[0]

    const id = randomUUID()
    getDb()
      .prepare(
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost, blender_versions, geolocation)
         VALUES (?, 'requested', ?, ?, ?, 0, '[]', ?)`
      )
      // The offer is the only place vast.ai ever tells us where the machine is
      // — /instances/ doesn't report it — so capture it at rent time or lose it.
      .run(id, offer.gpuName, offer.numGpus, offer.dphTotal, offer.geolocation)
    const node = new ManagedNode(id)
    this.nodes.set(id, node)
    emit('node:changed', node.snapshot)

    try {
      const instanceId = await createInstance({
        offerId: offer.id,
        image: DOCKER_IMAGE,
        diskGb: settings.offerFilters.minDiskGb,
        onstart: ONSTART,
        env: { NVIDIA_DRIVER_CAPABILITIES: 'all' },
        label: `vastai-blender ${id.slice(0, 8)}`
      })
      node.update({ instance_id: instanceId })
      void this.driveToReady(node, offer.machineId)
    } catch (e) {
      node.setState('failed', (e as Error).message)
      this.blacklist.add(offer.machineId)
      throw e
    }
    return id
  }

  /** Poll vast until running + SSH reachable, then hand to provisioning. */
  private async driveToReady(node: ManagedNode, machineId: number | null): Promise<void> {
    const instanceId = node.snapshot.instanceId
    if (!instanceId) return
    const deadline = Date.now() + 8 * 60_000
    try {
      let inst: RawInstance | null = null
      for (;;) {
        if (node.state === 'destroying' || node.state === 'destroyed') return
        inst = await showInstance(instanceId)
        if (inst?.actual_status === 'running') {
          const eps = sshEndpoints(inst)
          if (eps.length > 0) break
        }
        if (Date.now() > deadline) {
          throw new Error(
            `instance not running after 8 min (status: ${inst?.actual_status ?? 'unknown'})`
          )
        }
        await new Promise((r) => setTimeout(r, 10_000))
      }

      const startedAt = inst!.start_date ? Math.round(inst!.start_date * 1000) : Date.now()
      // Try endpoints in order (direct preferred, proxy fallback).
      let connected = false
      let lastErr: Error | null = null
      for (const ep of sshEndpoints(inst!)) {
        node.update({ ssh_host: ep.host, ssh_port: ep.port, started_at: startedAt })
        try {
          node.closeSsh()
          const ssh = await node.connectSsh()
          const r = await ssh.exec(
            'echo ok && cat /proc/driver/nvidia/version 2>/dev/null | head -1',
            {
              timeoutMs: 30_000
            }
          )
          if (r.stdout.includes('ok')) {
            connected = true
            break
          }
          lastErr = new Error(`unexpected echo result: ${r.stderr || r.stdout}`)
        } catch (e) {
          lastErr = e as Error
        }
      }
      if (!connected) throw lastErr ?? new Error('all SSH endpoints failed')

      node.setState('provisioning')
      if (this.onReady && node.ssh) {
        await this.onReady({ id: node.id, ssh: node.ssh })
      }
      node.setState('ready')
      emit('alert', { level: 'info', message: `Node ${node.snapshot.gpuName} ready` })
    } catch (e) {
      node.setState('failed', (e as Error).message)
      if (machineId != null) this.blacklist.add(machineId)
      emit('alert', { level: 'error', message: `Node failed: ${(e as Error).message}` })
      // Clean up the rented instance — never leave a failed node billing.
      try {
        await destroyInstance(instanceId)
        node.setState('destroyed')
      } catch {
        emit('alert', {
          level: 'error',
          message: `Could not destroy instance ${instanceId} — check the Vast.ai console!`
        })
      }
    }
  }

  /** Re-attach to an instance after app restart. */
  private async resumeNode(node: ManagedNode): Promise<void> {
    const instanceId = node.snapshot.instanceId
    if (!instanceId) {
      node.setState('failed', 'no instance id at resume')
      return
    }
    try {
      const inst = await showInstance(instanceId)
      if (!inst) {
        node.setState('destroyed', 'instance missing at resume')
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
      await node.connectSsh()
      const r = await node.ssh!.exec('echo ok', { timeoutMs: 30_000 })
      if (!r.stdout.includes('ok')) throw new Error('echo failed')
      if (this.onReady && node.ssh) {
        await this.onReady({ id: node.id, ssh: node.ssh })
      }
      node.setState('ready')
    } catch (e) {
      node.setState('unreachable', (e as Error).message)
      void this.recoverUnreachable(node)
    }
  }

  private async recoverUnreachable(node: ManagedNode): Promise<void> {
    try {
      if (!node.ssh) await node.connectSsh()
      await node.ssh!.reconnectWithBackoff()
      node.setState('ready')
    } catch (e) {
      node.setState('failed', (e as Error).message)
      // A node that dies mid-render never reaches destroyNode, so the
      // scheduler would otherwise keep polling a dead connection for chunks
      // this node can no longer finish. Release them here too so they requeue
      // onto a surviving node.
      forgetNodeProvider?.(node.id)
      // ...and then stop paying for it. Same guarantee as driveToReady's catch:
      // nothing else ever destroys a node that fails this way — scale-down
      // filters 'failed' out, accrueCosts stops metering it (so the leak is
      // invisible in History), and activeCount() ignores it, so a replacement is
      // rented immediately while this instance keeps billing until the next
      // app start's orphan reconcile. Destroy it directly rather than via
      // destroyNode(), whose Octane drain would await a dead SSH connection.
      const instanceId = node.snapshot.instanceId
      node.closeSsh()
      if (instanceId) {
        try {
          await destroyInstance(instanceId)
          node.setState('destroyed')
        } catch {
          emit('alert', {
            level: 'error',
            message: `Could not destroy unreachable instance ${instanceId} — check the Vast.ai console!`
          })
        }
      }
    }
  }

  async destroyNode(id: string): Promise<void> {
    const node = this.nodes.get(id)
    if (!node) return
    forgetNodeProvider?.(id)
    const instanceId = node.snapshot.instanceId
    node.setState('destroying')
    // Octane drain ordering: a clean OctaneServer exit releases the floating
    // license — do it BEFORE destroying the instance.
    if (node.snapshot.octaneReady && node.ssh) {
      const { stopOctaneServer, closeVncTunnel } = await import('../octane/octaneLicense')
      closeVncTunnel(id)
      await stopOctaneServer(node.ssh)
    }
    node.closeSsh()
    if (instanceId) {
      try {
        await destroyInstance(instanceId)
      } catch (e) {
        node.setState('failed', `destroy failed: ${(e as Error).message}`)
        emit('alert', {
          level: 'error',
          message: `Destroy failed for instance ${instanceId} — check the Vast.ai console!`
        })
        return
      }
    }
    node.setState('destroyed')
  }

  /** Accumulate $ cost from dph × elapsed and push the fleet totals. */
  private async accrueCosts(): Promise<void> {
    const db = getDb()
    const ts = Date.now() // one timestamp for the tick, so buckets line up
    let perHour = 0
    const usage: UsageRow[] = []
    for (const node of this.nodes.values()) {
      const s = node.snapshot
      if (['destroyed', 'failed'].includes(s.state) || s.dphTotal == null || !s.startedAt) continue
      perHour += s.dphTotal
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
      perHour,
      sessionTotal,
      sessionWh: sessionEnergyWh(),
      sessionCo2g: sessionCo2Grams(),
      balance: this.balance
    })
  }
}

export const nodeManager = new NodeManager()
