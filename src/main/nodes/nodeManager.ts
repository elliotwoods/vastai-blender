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
import type { NodeMetrics, NodeSnapshot, NodeState } from '../../shared/models'
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
}

/** Injected by index.ts (avoids a scheduler ↔ nodeManager import cycle). */
let currentChunkProvider: ((nodeId: string) => string | null) | null = null
export function setCurrentChunkProvider(fn: (nodeId: string) => string | null): void {
  currentChunkProvider = fn
}

/** Latest usage sample per node (in-memory — no need to persist). */
const metricsByNode = new Map<string, NodeMetrics>()

function rowToSnapshot(r: NodeRow): NodeSnapshot {
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
    currentChunkId: currentChunkProvider?.(r.id) ?? null,
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

  /** Sample GPU/CPU usage on every SSH-connected node. */
  private async pollMetrics(): Promise<void> {
    for (const node of this.nodes.values()) {
      if (
        !node.ssh ||
        !['ready', 'idle', 'rendering', 'encoding', 'provisioning'].includes(node.state)
      )
        continue
      try {
        const r = await node.ssh.exec(
          `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits; echo ----; cat /proc/loadavg; nproc`,
          { timeoutMs: 10_000 }
        )
        const [gpuPart, cpuPart] = r.stdout.split('----')
        if (!gpuPart || !cpuPart) continue
        const gpuRows = gpuPart
          .trim()
          .split('\n')
          .map((line) => line.split(',').map((x) => parseFloat(x)))
          .filter((xs) => xs.length >= 4 && xs.every((x) => Number.isFinite(x)))
        if (gpuRows.length === 0) continue
        const cpuLines = cpuPart.trim().split('\n')
        const load1 = parseFloat(cpuLines[0]?.split(' ')[0] ?? '0')
        const cores = parseInt(cpuLines[1] ?? '0', 10)
        metricsByNode.set(node.id, {
          gpuUtil: gpuRows.reduce((a, xs) => a + xs[0], 0) / gpuRows.length,
          vramUsedGb: gpuRows.reduce((a, xs) => a + xs[1], 0) / 1024,
          vramTotalGb: gpuRows.reduce((a, xs) => a + xs[2], 0) / 1024,
          gpuTemp: Math.max(...gpuRows.map((xs) => xs[3])),
          cpuLoad1: Number.isFinite(load1) ? load1 : 0,
          cpuCores: Number.isFinite(cores) ? cores : 0,
          updatedAt: Date.now()
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
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost, blender_versions)
         VALUES (?, 'requested', ?, ?, ?, 0, '[]')`
      )
      .run(id, offer.gpuName, offer.numGpus, offer.dphTotal)
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
      await node.connectSsh()
      const r = await node.ssh!.exec('echo ok', { timeoutMs: 30_000 })
      if (!r.stdout.includes('ok')) throw new Error('echo failed')
      node.setState(node.snapshot.blenderVersions.length > 0 ? 'ready' : 'provisioning')
      if (this.onReady && node.ssh) {
        await this.onReady({ id: node.id, ssh: node.ssh })
        node.setState('ready')
      }
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
    }
  }

  async destroyNode(id: string): Promise<void> {
    const node = this.nodes.get(id)
    if (!node) return
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
    let perHour = 0
    for (const node of this.nodes.values()) {
      const s = node.snapshot
      if (['destroyed', 'failed'].includes(s.state) || s.dphTotal == null || !s.startedAt) continue
      perHour += s.dphTotal
      const delta = s.dphTotal / 60 // one minute tick
      node.update({ accumulated_cost: s.accumulatedCost + delta })
      db.prepare(
        'INSERT INTO cost_log (node_id, ts, dph_total, delta_cost) VALUES (?, ?, ?, ?)'
      ).run(s.id, Date.now(), s.dphTotal, delta)
    }
    const sessionTotal = (
      db.prepare('SELECT COALESCE(SUM(delta_cost), 0) AS t FROM cost_log').get() as { t: number }
    ).t
    try {
      const u = await currentUser()
      const credit = u.credit ?? u.balance
      if (credit != null) this.balance = Number(credit)
    } catch {
      // keep last known balance (no key / offline)
    }
    emit('fleet:cost', { perHour, sessionTotal, balance: this.balance })
  }
}

export const nodeManager = new NodeManager()
