/**
 * Per-node concurrency auto-judge.
 *
 * How many chunks should run side-by-side on one node? The honest answer is
 * "it depends on the scene": a render whose per-frame cost is mostly a
 * single-threaded CPU pre-compute packs many-to-a-node almost for free, while
 * one that saturates the GPU gains nothing and loses to contention. Neither
 * the hardware spec nor the user knows which they have.
 *
 * So we measure. Two layers:
 *
 *   1. `hardCap()` — a static hardware ceiling (CPU threads, VRAM, RAM),
 *      mirroring `node_ceiling()` in remote/agent/noderunner.py. This is a
 *      safety bound, never a target: exceeding it means renders that OOM or
 *      thrash, so the ramp only ever moves *within* it.
 *
 *   2. `decide()` — a hill-climb on measured aggregate throughput. Start low,
 *      add a slot while total frames/sec keeps improving, stop (or step back)
 *      the moment it doesn't. Converged results are remembered per GPU model
 *      in `gpu_slots`, so the next node of that model starts near the answer
 *      instead of re-climbing from 2.
 *
 * Only jobs flagged `shareNode` are ever packed. An exclusive chunk holds its
 * node alone whatever this module concludes — see the admission rules in
 * scheduler.ts.
 */

import { getDb } from '../db/db'
import type { NodeMetrics } from '../../shared/models'

/** Absolute ceiling, matching the agent's own `min(..., 24)`. */
const ABSOLUTE_MAX_SLOTS = 24

/** Where a node with no learned history starts climbing from. */
const INITIAL_TARGET = 2

/**
 * How long a new target must run before its throughput counts. Chunks take
 * minutes, the scheduler ticks every 15s; judging sooner reads the transient
 * from a slot that has only just started rendering.
 */
export const SETTLE_MS = 90_000

/** Dead-band around the best-known throughput: inside it, more slots buy nothing. */
const IMPROVE_RATIO = 1.05
const DEGRADE_RATIO = 0.95

/** Ramp only while there is real headroom left. */
const RAMP_GPU_UTIL_MAX = 92
const RAMP_MEM_FRAC_MAX = 0.8

/** Above this, back off immediately — the next slot risks an OOM kill. */
const BACKOFF_MEM_FRAC = 0.9

export interface SlotState {
  /** current admission limit for shared chunks on this node */
  target: number
  /** best aggregate throughput seen so far (frames/sec), 0 = nothing measured */
  bestThroughput: number
  /** the target that produced bestThroughput */
  bestTarget: number
  /** epoch ms of the last target change */
  lastChangeAt: number
  /** true once the climb has settled — no further probing */
  converged: boolean
  /**
   * epoch ms of the last memory backoff, tracked separately from
   * `lastChangeAt` so the FIRST pressure sample can still act immediately
   * while repeats wait out a settle period. See `decide()`.
   */
  memBackoffAt?: number | null
}

export interface DecisionInput {
  state: SlotState
  metrics: NodeMetrics | null
  /** chunks actually in flight on the node right now */
  inFlight: number
  /** summed frames/sec across the node's rendering chunks; null = not measurable */
  throughput: number | null
  /** upper bound from settings; 0 = auto (hardware ceiling only) */
  maxNodeSlots: number
  now: number
}

export interface Decision {
  state: SlotState
  /** set when the controller settled this step — worth logging / persisting */
  settledAt: number | null
  /** human-readable reason, for the alert emitted on convergence */
  reason: string
}

/**
 * Static hardware ceiling for one node — the app-side mirror of
 * `node_ceiling()` in noderunner.py. Keep the two in step: the agent clamps
 * whatever we send, so a ceiling that is too generous here just means the
 * agent silently renders fewer chunks than the scheduler thinks it has
 * dispatched, and capacity maths that never resolve.
 *
 * Unknown metrics → a conservative 8. Under-estimating only delays later
 * top-up assignments; over-estimating lets a node advertise capacity it
 * cannot render (observed: a 56-thread/12 GB Titan counted as 24 slots while
 * its agent would run 12, so scale-up never fired).
 */
export function hardCap(metrics: NodeMetrics | null | undefined, maxNodeSlots: number): number {
  // cores // 2, not cores - 2: cpuCores reports THREADS, and one render trace
  // saturates a physical core.
  let cap = metrics && metrics.cpuCores > 0 ? Math.floor(metrics.cpuCores / 2) : 8
  // ~1 GB VRAM per EEVEE slot (measured ~0.5 GB on SDF scenes — 2x headroom).
  if (metrics && metrics.vramTotalGb > 0) {
    cap = Math.min(cap, Math.floor(metrics.vramTotalGb))
  }
  // ~3 GB system RAM per slot.
  if (metrics && metrics.ramTotalGb > 0) {
    cap = Math.min(cap, Math.floor(metrics.ramTotalGb / 3))
  }
  cap = Math.min(cap, ABSOLUTE_MAX_SLOTS)
  if (maxNodeSlots > 0) cap = Math.min(cap, maxNodeSlots)
  return Math.max(1, cap)
}

/** Fresh state for a node, seeded from what we learned about this GPU model. */
export function initialState(gpuName: string | null, cap: number, now: number): SlotState {
  const learned = gpuName ? learnedSlots(gpuName) : null
  const target = Math.max(1, Math.min(cap, learned?.bestSlots ?? INITIAL_TARGET))
  return {
    target,
    // A learned value is a starting point, not a verdict — this node's scene
    // may be heavier. Leave bestThroughput at 0 so the first real measurement
    // becomes the baseline and the climb re-verifies from here.
    bestThroughput: 0,
    bestTarget: target,
    lastChangeAt: now,
    converged: false,
    memBackoffAt: null
  }
}

/**
 * One control step. Pure — all I/O (metrics, throughput, persistence) is the
 * caller's, which is what makes this testable.
 */
export function decide(input: DecisionInput): Decision {
  const { metrics, inFlight, throughput, maxNodeSlots, now } = input
  const cap = hardCap(metrics, maxNodeSlots)
  const state = { ...input.state }
  const keep = (reason: string): Decision => ({ state, settledAt: null, reason })

  // The ceiling can move under us: metrics arrive after the node is first
  // seen, and the user can lower maxNodeSlots at any time.
  if (state.target > cap) {
    state.target = cap
    state.bestTarget = Math.min(state.bestTarget, cap)
  }

  // Memory pressure outranks everything, including `converged` — an OOM kill
  // loses the whole chunk's progress, so react on the first sample that shows
  // it rather than waiting out the settle period.
  const memFrac = memoryFraction(metrics)
  if (memFrac != null && memFrac > BACKOFF_MEM_FRAC) {
    // ONE step per settle period. Lowering the target only blocks *new*
    // admissions — the renders that caused the pressure keep running for
    // minutes, so memory stays above the threshold and an ungated branch
    // decrements again on every 15s tick: a node happily running 6 slots
    // collapses to 1 within ~75s and, because nothing ever clears `converged`,
    // stays pinned there for the rest of its rented life.
    //
    // The cooldown is keyed off the last MEMORY backoff rather than
    // `lastChangeAt`, so the first pressure sample still acts immediately —
    // an OOM kill loses the whole chunk's progress and is worth pre-empting.
    const cooling = state.memBackoffAt != null && now - state.memBackoffAt < SETTLE_MS
    const next = Math.max(1, Math.min(state.target, inFlight) - 1)
    if (!cooling && next < state.target) {
      state.target = next
      state.bestTarget = next
      // `bestThroughput` was measured at a HIGHER target. Keeping it would pair
      // an inflated rate with the reduced slot count and teach `gpu_slots` that
      // `next` slots achieve what N slots did, poisoning the seed for every
      // later node of this GPU model. A safety backoff is not a throughput
      // measurement — discard it (the caller only persists when it is > 0).
      state.bestThroughput = 0
      state.lastChangeAt = now
      state.memBackoffAt = now
      state.converged = true
      return {
        state,
        settledAt: now,
        reason: `backed off to ${next} slot${next === 1 ? '' : 's'} — memory at ${Math.round(memFrac * 100)}%`
      }
    }
    state.converged = true
    return keep(cooling ? 'at memory limit — last backoff still settling' : 'at memory limit')
  }

  if (state.converged) return keep('converged')
  // Below target the node isn't saturated, so throughput says nothing about
  // whether the target is right — it's just the queue being short.
  if (inFlight < state.target) return keep('not saturated')
  if (now - state.lastChangeAt < SETTLE_MS) return keep('settling')
  if (throughput == null || !(throughput > 0)) return keep('no throughput sample')

  if (state.bestThroughput === 0) {
    // First measurement at the starting target — the baseline to beat.
    state.bestThroughput = throughput
    state.bestTarget = state.target
    return rampOrSettle(state, metrics, cap, memFrac, now)
  }

  if (throughput > state.bestThroughput * IMPROVE_RATIO) {
    state.bestThroughput = throughput
    state.bestTarget = state.target
    return rampOrSettle(state, metrics, cap, memFrac, now)
  }

  if (throughput < state.bestThroughput * DEGRADE_RATIO) {
    // This target is worse than one we already tried — go back to the winner
    // and stop. Lowering the target never kills a running render; it only
    // stops new chunks being admitted until occupancy falls.
    state.target = state.bestTarget
    state.lastChangeAt = now
    state.converged = true
    return {
      state,
      settledAt: now,
      reason: `settled at ${state.target} slot${state.target === 1 ? '' : 's'} — throughput fell with more`
    }
  }

  // Inside the dead-band: measurably no better, so stop paying the contention.
  state.target = state.bestTarget
  state.converged = true
  return {
    state,
    settledAt: now,
    reason: `settled at ${state.target} slot${state.target === 1 ? '' : 's'} — no gain from more`
  }
}

/** Throughput improved: take another step if there's room and headroom. */
function rampOrSettle(
  state: SlotState,
  metrics: NodeMetrics | null,
  cap: number,
  memFrac: number | null,
  now: number
): Decision {
  if (state.target >= cap) {
    state.converged = true
    return { state, settledAt: now, reason: `settled at ${state.target} slots — hardware ceiling` }
  }
  if (metrics && metrics.gpuUtil >= RAMP_GPU_UTIL_MAX) {
    state.converged = true
    return {
      state,
      settledAt: now,
      reason: `settled at ${state.target} slots — GPU saturated (${Math.round(metrics.gpuUtil)}%)`
    }
  }
  if (memFrac != null && memFrac > RAMP_MEM_FRAC_MAX) {
    state.converged = true
    return {
      state,
      settledAt: now,
      reason: `settled at ${state.target} slots — ${Math.round(memFrac * 100)}% memory used`
    }
  }
  state.target += 1
  state.lastChangeAt = now
  return { state, settledAt: null, reason: `probing ${state.target} slots` }
}

/** Worst of the VRAM and system-RAM fractions; null when neither was sampled. */
function memoryFraction(metrics: NodeMetrics | null | undefined): number | null {
  if (!metrics) return null
  const fracs: number[] = []
  if (metrics.vramTotalGb > 0) fracs.push(metrics.vramUsedGb / metrics.vramTotalGb)
  if (metrics.ramTotalGb > 0) fracs.push(metrics.ramUsedGb / metrics.ramTotalGb)
  return fracs.length ? Math.max(...fracs) : null
}

// ---------------------------------------------------------------------------
// Learned optimum per GPU model (same EWMA shape as recordThroughput/gpu_perf)
// ---------------------------------------------------------------------------

export interface LearnedSlots {
  bestSlots: number
  framesPerHour: number
  samples: number
}

export function learnedSlots(gpuName: string): LearnedSlots | null {
  const row = getDb()
    .prepare('SELECT best_slots, frames_per_hour, samples FROM gpu_slots WHERE gpu_name = ?')
    .get(gpuName) as { best_slots: number; frames_per_hour: number; samples: number } | undefined
  if (!row) return null
  return { bestSlots: row.best_slots, framesPerHour: row.frames_per_hour, samples: row.samples }
}

/**
 * Remember where a node settled. Throughput is EWMA'd (30% new) like
 * gpu_perf, but the slot count tracks the *best* observation rather than an
 * average: a node that measured 8 slots on a light scene and 3 on a heavy one
 * should start at 8 and ramp down — starting at the mean would leave the
 * light case permanently under-packed, and ramping down is cheap while
 * ramping up costs a settle period per step.
 */
export function recordNodeSlots(gpuName: string, slots: number, framesPerSec: number): void {
  if (!Number.isFinite(slots) || slots < 1) return
  if (!Number.isFinite(framesPerSec) || framesPerSec <= 0) return
  const framesPerHour = framesPerSec * 3600
  const db = getDb()
  const row = db
    .prepare('SELECT best_slots, frames_per_hour FROM gpu_slots WHERE gpu_name = ?')
    .get(gpuName) as { best_slots: number; frames_per_hour: number } | undefined
  if (row) {
    db.prepare(
      'UPDATE gpu_slots SET best_slots = ?, frames_per_hour = ?, samples = samples + 1, updated_at = ? WHERE gpu_name = ?'
    ).run(
      Math.max(row.best_slots, Math.round(slots)),
      row.frames_per_hour * 0.7 + framesPerHour * 0.3,
      Date.now(),
      gpuName
    )
  } else {
    db.prepare(
      'INSERT INTO gpu_slots (gpu_name, best_slots, frames_per_hour, samples, updated_at) VALUES (?, ?, ?, 1, ?)'
    ).run(gpuName, Math.round(slots), framesPerHour, Date.now())
  }
}
