/**
 * Per-GPU render lanes.
 *
 * A node with N GPUs used to run ONE Blender with every GPU enabled. Cycles
 * does split sampling across GPUs, but each frame also carries serial CPU work
 * (depsgraph/geometry-nodes evaluation, scene sync, BVH build) during which
 * every GPU idles. Measured on the target scene: ~4.5 s of sync against ~62 s
 * of sampling per frame on a 4090 — on 4 GPUs that is ~15.5 s of sampling plus
 * the same 4.5 s of sync, so a quarter of the node's time is spent idle.
 *
 * One Blender per GPU (CUDA_VISIBLE_DEVICES=i) makes each process pay its own
 * sync while the other GPUs keep sampling. A "lane" is one such pinned slot.
 * With `slotsPerGpu = 2`, two lanes share each GPU, so one lane's sync
 * overlaps the other's sampling.
 *
 * Lanes are also what "exclusive" means on a multi-GPU node: a job that does
 * not share nodes holds a GPU lane, not the whole machine.
 *
 * Pure (no I/O), so the policy is testable on its own. The scheduler supplies
 * the node's GPU count, the setting and the hardware ceiling.
 */

import type { EngineId, NodeMetrics } from '../../shared/models'
import { memoryFraction, SETTLE_MS } from './slotController'

/** Hard ceiling on lanes per GPU; beyond two the extra scene copies only cost VRAM. */
export const MAX_SLOTS_PER_GPU = 2

export interface LanePlan {
  /** concurrent exclusive renders the node may run (>= 1) */
  lanes: number
  /** pin each render to one GPU with CUDA_VISIBLE_DEVICES */
  pin: boolean
}

/** Normalise the stored setting: absent = 1, clamped to 0..MAX_SLOTS_PER_GPU. */
export function normaliseSlotsPerGpu(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v)) return 1
  return Math.max(0, Math.min(MAX_SLOTS_PER_GPU, Math.floor(v)))
}

/**
 * How many lanes a node runs, and whether they are pinned.
 *
 * @param numGpus GPUs on the node (from the offer)
 * @param slotsPerGpu the setting (0 = off, 1, 2)
 * @param cap the node's hardware/user slot ceiling (see slotController.hardCap)
 *
 * When the ceiling cannot fit `numGpus × slotsPerGpu`, one lane per GPU is
 * tried next. When it cannot fit even that — a user cap of 1, or a box with
 * very little RAM for its GPU count — the node falls back to the old single
 * process across every GPU: pinning fewer lanes than GPUs would leave whole
 * cards idle, which is strictly worse.
 *
 * Lanes are a Cycles idea. EEVEE renders on the one GPU its OpenGL/Vulkan
 * context lands on, which CUDA_VISIBLE_DEVICES does not move, so pinned EEVEE
 * lanes all piled onto card 0 (#229). Octane runs one OctaneServer and one
 * licence per node (#235). Either gets one unpinned lane: the whole node, as
 * before lanes existed. `engine` absent keeps the Cycles plan for callers
 * that do not pass it yet.
 */
export function planLanes(
  numGpus: number,
  slotsPerGpu: number,
  cap: number,
  engine?: EngineId | null
): LanePlan {
  const gpus = Math.max(1, Math.floor(numGpus || 1))
  const k = normaliseSlotsPerGpu(slotsPerGpu)
  const ceiling = Math.max(1, Math.floor(cap || 1))
  if (engine === 'eevee' || engine === 'octane') return { lanes: 1, pin: false }
  if (k === 0) return { lanes: 1, pin: false }
  if (gpus === 1) {
    // Nothing to pin to; `k` lanes simply share the one GPU.
    return { lanes: Math.max(1, Math.min(k, ceiling)), pin: false }
  }
  if (gpus * k <= ceiling) return { lanes: gpus * k, pin: true }
  if (gpus <= ceiling) return { lanes: gpus, pin: true }
  return { lanes: 1, pin: false }
}

/**
 * Memory guard for exclusive lanes.
 *
 * The slot controller's hill-climb only governs SHARED work; exclusive lanes
 * are a fixed count, so they need their own backstop against the one failure
 * that loses a whole chunk — an OOM kill when N copies of a heavy scene do not
 * fit. Same law as the slot controller's memory branch: one step down per
 * settle period while memory is above 90%, never back up for this node.
 */
export interface LaneGuard {
  /** upper bound on lanes for this node (Infinity = unconstrained) */
  limit: number
  /** epoch ms of the last backoff */
  backoffAt: number | null
}

export const BACKOFF_MEM_FRAC = 0.9

export function initialGuard(): LaneGuard {
  return { limit: Number.POSITIVE_INFINITY, backoffAt: null }
}

export function guardLanes(
  prev: LaneGuard,
  metrics: NodeMetrics | null | undefined,
  /** exclusive lanes currently running */
  inFlight: number,
  now: number
): { guard: LaneGuard; reason: string | null } {
  const mem = memoryFraction(metrics)
  if (mem == null || mem <= BACKOFF_MEM_FRAC) return { guard: prev, reason: null }
  if (prev.backoffAt != null && now - prev.backoffAt < SETTLE_MS)
    return { guard: prev, reason: null }
  const next = Math.max(1, Math.min(prev.limit, inFlight) - 1)
  if (next >= prev.limit) return { guard: prev, reason: null }
  return {
    guard: { limit: next, backoffAt: now },
    reason: `lanes capped at ${next} — memory at ${Math.round(mem * 100)}%`
  }
}

/** The lane count after the memory guard. */
export function effectiveLanes(plan: LanePlan, guard: LaneGuard | null | undefined): number {
  return Math.max(1, Math.min(plan.lanes, guard?.limit ?? Number.POSITIVE_INFINITY))
}
