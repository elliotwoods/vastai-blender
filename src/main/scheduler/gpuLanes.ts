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
 * fit.
 *
 * The first version stepped the limit down by one every settle period while
 * node memory stayed above 90%, and never back up (#222). Lowering a limit
 * only stops new admissions, so the renders that caused the pressure kept
 * running and kept it above 90%: a 4-GPU node under a heavy scene reached one
 * lane in about three minutes, pinned to card 0 with three paid cards idle,
 * for the rest of its rental. With one lane per GPU each card already holds
 * one scene, so fewer lanes could not lower any card's VRAM at all.
 *
 * With a LaneGuardContext (the node's GPUs, the setting and its ceiling) the
 * guard now:
 *   - moves between the plans planLanes can make (N×k pinned, N pinned, one
 *     unpinned process across every GPU), never to a pinned count below the
 *     GPU count (guardedLanePlan);
 *   - steps again only once the previous step has taken effect (in-flight at
 *     or below the limit) and a settle period has passed;
 *   - reads VRAM per card from metrics.gpus, and steps for VRAM only when the
 *     lower plan puts fewer scenes on a card; RAM falls with every process
 *     removed;
 *   - recovers one plan at a time once memory has stayed low for a settle
 *     period and the plan above is projected to fit under 75%.
 * Without a context it keeps the old count-down, gated on the previous step
 * having taken effect, for callers not yet passing one.
 */
export interface LaneGuard {
  /** upper bound on lanes for this node (Infinity = unconstrained) */
  limit: number
  /** epoch ms of the last step down */
  backoffAt: number | null
  /**
   * epoch ms since which the plan above has been projected to fit; null while
   * it would not. Recovery waits a settle period on it.
   */
  calmSince?: number | null
}

/** What the guard needs to know about the node to move between lane plans. */
export interface LaneGuardContext {
  numGpus: number
  slotsPerGpu: number
  /** the node's hardware/user slot ceiling (slotController.hardCap) */
  cap: number
  engine?: EngineId | null
}

export const BACKOFF_MEM_FRAC = 0.9
/** The plan above must be projected to use at most this much memory to recover to it. */
export const RECOVER_MEM_FRAC = 0.75

export function initialGuard(): LaneGuard {
  return { limit: Number.POSITIVE_INFINITY, backoffAt: null, calmSince: null }
}

/**
 * The lane counts this node can run, highest first: N×k pinned, N pinned,
 * then one unpinned process (those its ceiling allows). The guard only ever
 * moves between these.
 */
export function laneLevels(
  numGpus: number,
  slotsPerGpu: number,
  cap: number,
  engine?: EngineId | null
): number[] {
  const gpus = Math.max(1, Math.floor(numGpus || 1))
  const caps = [cap, gpus, 1].map((c) => Math.min(cap, c))
  const lanes = caps.map((c) => planLanes(gpus, slotsPerGpu, c, engine).lanes)
  return [...new Set(lanes)].sort((a, b) => b - a)
}

/**
 * The node's lane plan under its memory guard: planLanes with the guard's
 * limit as one more ceiling. A limit below the GPU count therefore becomes
 * one unpinned process across every card, never a few pinned lanes with the
 * other cards idle (#222). Use this rather than effectiveLanes().
 */
export function guardedLanePlan(
  numGpus: number,
  slotsPerGpu: number,
  cap: number,
  guard: LaneGuard | null | undefined,
  engine?: EngineId | null
): LanePlan {
  const limit = guard?.limit ?? Number.POSITIVE_INFINITY
  return planLanes(numGpus, slotsPerGpu, Math.min(cap, limit), engine)
}

/** Scene copies each card holds when the node runs `lanes`. */
function scenesPerCard(lanes: number, gpus: number): number {
  if (gpus === 1) return lanes
  // One unpinned process loads the scene once onto every card it uses.
  if (lanes <= 1) return 1
  return Math.ceil(lanes / gpus)
}

/** System RAM used, 0..1, or null when not sampled. */
export function ramFraction(metrics: NodeMetrics | null | undefined): number | null {
  if (!metrics || !(metrics.ramTotalGb > 0)) return null
  return metrics.ramUsedGb / metrics.ramTotalGb
}

/**
 * VRAM used on the fullest card, 0..1, or null when not sampled. The node
 * total (vramUsedGb / vramTotalGb) hides one full card among empty ones, and
 * a card is what runs out.
 */
export function cardVramFraction(metrics: NodeMetrics | null | undefined): number | null {
  if (!metrics) return null
  const cards = (metrics.gpus ?? []).filter((g) => g.vramTotalGb > 0)
  if (cards.length > 0) return Math.max(...cards.map((g) => g.vramUsedGb / g.vramTotalGb))
  return metrics.vramTotalGb > 0 ? metrics.vramUsedGb / metrics.vramTotalGb : null
}

const pct = (f: number): string => `${Math.round(f * 100)}%`

export function guardLanes(
  prev: LaneGuard,
  metrics: NodeMetrics | null | undefined,
  /** exclusive lanes currently running */
  inFlight: number,
  now: number,
  /** the node's GPUs, setting and ceiling; absent = the legacy count-down */
  ctx?: LaneGuardContext
): { guard: LaneGuard; reason: string | null } {
  if (!ctx) return legacyGuard(prev, metrics, inFlight, now)
  const keep = { guard: prev, reason: null }
  const gpus = Math.max(1, Math.floor(ctx.numGpus || 1))
  const levels = laneLevels(gpus, ctx.slotsPerGpu, ctx.cap, ctx.engine)
  const current = guardedLanePlan(gpus, ctx.slotsPerGpu, ctx.cap, prev, ctx.engine).lanes
  const ram = ramFraction(metrics)
  const vram = cardVramFraction(metrics)
  if (ram == null && vram == null) return keep
  const ramHot = ram != null && ram > BACKOFF_MEM_FRAC
  const vramHot = vram != null && vram > BACKOFF_MEM_FRAC
  const calmCleared = (): { guard: LaneGuard; reason: null } =>
    prev.calmSince != null ? { guard: { ...prev, calmSince: null }, reason: null } : keep

  if (ramHot || vramHot) {
    // Lowering the limit stops admissions, not the renders already running:
    // wait for the node to come down to it before judging it again.
    if (inFlight > current) return calmCleared()
    if (prev.backoffAt != null && now - prev.backoffAt < SETTLE_MS) return calmCleared()
    // Every process removed frees its RAM; VRAM falls only when a card holds
    // fewer scenes. With one lane per GPU nothing lower helps VRAM, so the
    // guard leaves every card working rather than idle some of them.
    const next = levels.find(
      (l) => l < current && (ramHot || scenesPerCard(l, gpus) < scenesPerCard(current, gpus))
    )
    if (next == null) return calmCleared()
    const what = ramHot
      ? `RAM at ${pct(ram ?? 0)}`
      : `VRAM at ${pct(vram ?? 0)} on the fullest card`
    const shape = next === 1 && gpus > 1 ? ' (one process across every GPU)' : ''
    return {
      guard: { limit: next, backoffAt: now, calmSince: null },
      reason: `lanes capped at ${next}${shape} — ${what}`
    }
  }

  // Recovery, one plan at a time. Memory is projected to the plan above from
  // what the renders running now use: RAM per process, VRAM per scene copy.
  // Both overestimate (the OS and the driver are counted as if per render),
  // which keeps a node from climbing back into the pressure it just left.
  const above = levels.filter((l) => l > current).pop()
  if (above == null || inFlight <= 0 || inFlight > current) return calmCleared()
  const projectedRam = ram == null ? 0 : (ram * above) / inFlight
  const projectedVram =
    vram == null ? 0 : (vram * scenesPerCard(above, gpus)) / scenesPerCard(current, gpus)
  if (projectedRam > RECOVER_MEM_FRAC || projectedVram > RECOVER_MEM_FRAC) return calmCleared()
  if (prev.calmSince == null) return { guard: { ...prev, calmSince: now }, reason: null }
  if (now - prev.calmSince < SETTLE_MS) return keep
  if (prev.backoffAt != null && now - prev.backoffAt < SETTLE_MS) return keep
  const top = levels[0]
  return {
    guard: {
      limit: above >= top ? Number.POSITIVE_INFINITY : above,
      backoffAt: prev.backoffAt,
      calmSince: null
    },
    reason: `lanes back up to ${above} — memory has room (RAM ${pct(ram ?? 0)}, VRAM ${pct(vram ?? 0)})`
  }
}

/**
 * The count-down for callers that pass no context: one lane fewer per settle
 * period, but only once the previous step has taken effect. Without that
 * gate the renders that caused the pressure, still running, walked the limit
 * down every settle period to one (#222).
 */
function legacyGuard(
  prev: LaneGuard,
  metrics: NodeMetrics | null | undefined,
  inFlight: number,
  now: number
): { guard: LaneGuard; reason: string | null } {
  const mem = memoryFraction(metrics)
  if (mem == null || mem <= BACKOFF_MEM_FRAC) return { guard: prev, reason: null }
  if (prev.backoffAt != null && now - prev.backoffAt < SETTLE_MS)
    return { guard: prev, reason: null }
  if (inFlight > prev.limit) return { guard: prev, reason: null }
  const next = Math.max(1, Math.min(prev.limit, inFlight) - 1)
  if (next >= prev.limit) return { guard: prev, reason: null }
  return {
    guard: { limit: next, backoffAt: now },
    reason: `lanes capped at ${next} — memory at ${pct(mem)}`
  }
}

/**
 * The lane count after the memory guard.
 *
 * @deprecated Keeps the plan's `pin` while cutting its lanes, so a limit
 * below the GPU count pins a few lanes and idles the other cards (#222).
 * Use guardedLanePlan().
 */
export function effectiveLanes(plan: LanePlan, guard: LaneGuard | null | undefined): number {
  return Math.max(1, Math.min(plan.lanes, guard?.limit ?? Number.POSITIVE_INFINITY))
}

/**
 * Throughput for ONE GPU of this model, from one finished chunk: what
 * gpu_perf stores and offer ranking multiplies back up by an offer's GPUs.
 *
 * The scheduler recorded the run's rate × the mean runs on the NODE, then
 * divided by every GPU. For a pinned run that is right only when every card
 * was busy; with fewer runs than GPUs each run had a card to itself and the
 * figure came out at runs/GPUs of the truth: a job's last chunk alone on a
 * 4-GPU node taught 25%, three lanes of four 75% (#225). That pulled every
 * offer of the model down the ranking, 1-GPU offers included.
 *
 * Pinned: the run's own rate × how many runs shared its card (1 at one lane
 * per GPU). Unpinned: the node's rate (run rate × runs on the node) over the
 * GPUs one process uses: every card for Cycles and Octane, one for EEVEE.
 * Null when there is nothing sane to record.
 */
export function perGpuFramesPerHour(i: {
  /** this run's frames ÷ elapsed hours */
  runFramesPerHour: number
  /** the card the run was pinned to, or null when unpinned */
  gpu: number | null
  /** pinned: mean runs on that card while it rendered, itself included */
  meanRunsOnGpu?: number
  /** unpinned: mean runs on the node while it rendered, itself included */
  meanRunsOnNode?: number
  numGpus: number
  engine?: EngineId | null
}): number | null {
  const rate = i.runFramesPerHour
  if (!Number.isFinite(rate) || rate <= 0) return null
  const atLeastOne = (v: number | undefined): number =>
    v != null && Number.isFinite(v) ? Math.max(1, v) : 1
  if (i.gpu != null) return rate * atLeastOne(i.meanRunsOnGpu)
  const gpusUsed = i.engine === 'eevee' ? 1 : Math.max(1, Math.floor(i.numGpus || 1))
  return (rate * atLeastOne(i.meanRunsOnNode)) / gpusUsed
}

/**
 * Runs on the same card as `gpu` right now, itself included: the sample a
 * pinned run averages into meanRunsOnGpu (from activeWorkForNode's `gpu`).
 */
export function runsOnGpu(work: ReadonlyArray<{ gpu?: number | null }>, gpu: number): number {
  return Math.max(1, work.filter((w) => w.gpu === gpu).length)
}
