/**
 * Offer search: build the vast query from user filters, rank the results.
 *
 * Ranking strategy (documented so it can be tuned deliberately):
 *
 *   score = perfPerDollar × reliability² × netFactor
 *
 * - perfPerDollar: what a rented hour actually buys.
 *   Preferred source: OUR OWN measured render throughput for this GPU model
 *   (frames/hour EWMA from completed chunks, `gpu_perf` table) divided by
 *   $/hr — real Blender numbers beat any synthetic benchmark, and the
 *   scheduler gets smarter with every render. Until a GPU model has been
 *   measured, fall back to vast's `dlperf_per_dphtotal` (DL benchmark per
 *   dollar — a reasonable GPU-compute proxy), normalised so measured and
 *   proxy scores are comparable. Last resort: 1/price (cheapest first).
 * - reliability²: a machine that dies mid-chunk wastes the whole chunk plus
 *   re-render time; squaring punishes the 0.9s vs the 0.99s hard.
 * - netFactor: the node's UPLOAD feeds our frame/clip downloads — a fast GPU
 *   behind a 20 Mbps uplink stalls the pipeline. Saturates at 200 Mbps
 *   (beyond that other factors dominate), floors at 0.25 (never fully
 *   disqualifying, since filters already set a minimum).
 */

import { getDb } from '../db/db'
import type { Offer, OfferFilters } from '../../shared/models'
import { searchOffers } from './vastClient'
import type { RawOffer } from './types'

/** How a search is narrowed beyond the user's OfferFilters. */
export interface OfferSearchOptions {
  /**
   * Plan 1.18: datacenter hosts only, which Vast calls its secure cloud:
   * vetted businesses rather than individuals. Octane rentals ask for it
   * when settings.octane.secureCloudOnly is on, since any OTOY sign-in on a
   * node, by hand or scripted, is disclosed to whoever has root there.
   */
  secureCloudOnly?: boolean
}

export function buildQuery(
  f: OfferFilters,
  opts: OfferSearchOptions = {}
): Record<string, unknown> {
  const q: Record<string, unknown> = {
    rentable: { eq: true },
    verified: { eq: true },
    type: 'ondemand',
    // gpu_ram is MB in the API
    gpu_ram: { gte: f.minGpuRamGb * 1024 },
    inet_down: { gte: f.minInetDownMbps },
    reliability2: { gte: f.minReliability },
    disk_space: { gte: f.minDiskGb },
    cuda_max_good: { gte: 12.1 },
    order: [['dph_total', 'asc']]
  }
  if (f.maxDphTotal != null) q.dph_total = { lte: f.maxDphTotal }
  if (f.gpuNames.length === 1) q.gpu_name = { eq: f.gpuNames[0] }
  else if (f.gpuNames.length > 1) q.gpu_name = { in: f.gpuNames }
  // CPU floor for CPU-bound fleets: without it the per-dollar ranking rents
  // cheap 8-16-thread boxes whose aggregate cores can never hit the
  // campaign's throughput target (measured 2026-07-27: a fleet of i7/Xeon
  // leftovers delivered ~4 frames/min across 80 slots).
  if (f.minCpuCores != null) q.cpu_cores_effective = { gte: f.minCpuCores }
  if (f.minNumGpus != null) q.num_gpus = { gte: f.minNumGpus }
  if (opts.secureCloudOnly) q.datacenter = { eq: true }
  return q
}

/**
 * Whether Vast's reply says the offer is on a datacenter (secure cloud)
 * host. The query asks Vast for those only; this holds each offer to it as
 * well, and an offer whose reply does not say so is not taken for one: a
 * query key Vast ignored, or a field it renamed, must leave the search
 * empty, never rent a host nobody vetted for a sign-in the user asked to
 * keep off them.
 */
function onDatacenter(r: RawOffer): boolean {
  const o = r as RawOffer & { datacenter?: unknown; hosting_type?: unknown }
  return o.datacenter === true || o.hosting_type === 1
}

function toOffer(r: RawOffer): Offer {
  return {
    id: r.id,
    machineId: r.machine_id,
    gpuName: r.gpu_name,
    numGpus: r.num_gpus,
    gpuRamGb: Math.round((r.gpu_ram / 1024) * 10) / 10,
    dphTotal: r.dph_total,
    dlperfPerDph: r.dlperf_per_dphtotal ?? null,
    inetDownMbps: r.inet_down,
    inetUpMbps: r.inet_up,
    reliability: r.reliability2 ?? r.reliability ?? 0,
    cudaMaxGood: r.cuda_max_good ?? null,
    geolocation: r.geolocation ?? null,
    diskSpaceGb: r.disk_space,
    cpuName: r.cpu_name ?? null,
    cpuCoresEffective: r.cpu_cores_effective ?? r.cpu_cores ?? null,
    cpuGhz: r.cpu_ghz ?? null
  }
}

/**
 * Measured frames/hour for ONE GPU of this model (see recordThroughput), or
 * null while nothing is learned. Exported for scale-up (plans 1.5, 1.21):
 * the tail rule's provisional fleet rate is this × each usable node's GPUs.
 */
export function measuredFramesPerHour(gpuName: string): number | null {
  try {
    const row = getDb()
      .prepare('SELECT frames_per_hour FROM gpu_perf WHERE gpu_name = ?')
      .get(gpuName) as { frames_per_hour: number } | undefined
    return row?.frames_per_hour ?? null
  } catch {
    return null
  }
}

/**
 * Record a completed chunk's throughput for this GPU model (EWMA 30% new).
 * Called by the scheduler; includes per-chunk overheads (upload/encode) on
 * purpose — that's the throughput we actually experience.
 *
 * `nodeFramesPerHour` is what the whole node delivered; it is stored PER GPU.
 * The table is keyed by GPU model alone, and before this a 4×4090 node and a
 * 1×4090 node wrote their node totals under the same "RTX 4090" key, so the
 * figure swung ~4x with whichever size happened to finish a chunk last — and
 * scoring then divided it by each offer's whole-node price, so every 1-GPU
 * offer was ranked on a 4-GPU node's output (or the reverse). Per GPU, the
 * figure means the same thing whatever size of node measured it, and
 * scoreOffer multiplies it back up by the offer's GPU count.
 */
export function recordThroughput(gpuName: string, nodeFramesPerHour: number, numGpus = 1): void {
  const framesPerHour = nodeFramesPerHour / Math.max(1, Math.floor(numGpus || 1))
  if (!Number.isFinite(framesPerHour) || framesPerHour <= 0) return
  const db = getDb()
  const row = db
    .prepare('SELECT frames_per_hour, samples FROM gpu_perf WHERE gpu_name = ?')
    .get(gpuName) as { frames_per_hour: number; samples: number } | undefined
  if (row) {
    const next = row.frames_per_hour * 0.7 + framesPerHour * 0.3
    db.prepare(
      'UPDATE gpu_perf SET frames_per_hour = ?, samples = samples + 1, updated_at = ? WHERE gpu_name = ?'
    ).run(next, Date.now(), gpuName)
  } else {
    db.prepare(
      'INSERT INTO gpu_perf (gpu_name, frames_per_hour, samples, updated_at) VALUES (?, ?, 1, ?)'
    ).run(gpuName, framesPerHour, Date.now())
  }
}

/**
 * CPU proxy for cpuBound workloads: the render trace is one single-threaded
 * process per slot and slots scale with cores, so TOTAL node throughput is
 * ~clock × cores — cores count LINEARLY (a √cores discount let 8-16-thread
 * bargain boxes win on price and starve the fleet; measured 2026-07-27).
 * Clock counts QUADRATICALLY (normalized at 4 GHz): at equal cores×clock,
 * fewer/faster cores beat many slow ones — per-frame latency is 1/clock and
 * contention grows with slot count (measured 7.5 min/frame/slot on low-clock
 * rental Xeons vs ~2 min on a high-clock desktop core).
 * Cores capped at 64: beyond that VRAM/slot ceilings bind first.
 */
function cpuProxy(o: Offer): number {
  const ghz = o.cpuGhz ?? 3.0 // unknown clock — assume a mediocre one
  const cores = Math.min(o.cpuCoresEffective ?? 8, 64)
  return (ghz / 4.0) * ghz * cores
}

/** In cpuBound mode, cap how much vast's GPU DL benchmark can matter. */
const CPU_BOUND_DLPERF_CAP = 250

export function scoreOffer(o: Offer, cpuBound = false): number {
  const measured = measuredFramesPerHour(o.gpuName)
  let perfPerDollar: number
  if (measured != null) {
    // frames/hour per dollar/hour = frames per dollar. `measured` is per GPU
    // and dphTotal is the whole node's price, so scale by the GPU count — each
    // GPU runs its own render lane (see scheduler/gpuLanes). Scale to roughly
    // the magnitude of dlperf_per_dphtotal so mixed fleets rank sanely.
    // (dlperf_per_dphtotal needs no such correction: vast's DLPerf already
    // scores the whole machine.)
    const gpus = Math.max(1, o.numGpus || 1)
    perfPerDollar = ((measured * gpus) / o.dphTotal) * 0.5
  } else if (cpuBound) {
    // CPU-bound: rank unmeasured machines by CPU per dollar; the DL benchmark
    // only tie-breaks (capped) so premium datacenter GPUs stop auto-winning.
    const dl = Math.min(o.dlperfPerDph ?? 0, CPU_BOUND_DLPERF_CAP)
    perfPerDollar = cpuProxy(o) / o.dphTotal + dl * 0.1
  } else if (o.dlperfPerDph != null) {
    perfPerDollar = o.dlperfPerDph
  } else {
    perfPerDollar = 10 / o.dphTotal
  }
  const netFactor = Math.min(1, Math.max(0.25, o.inetUpMbps / 200))
  return perfPerDollar * o.reliability * o.reliability * netFactor
}

/**
 * Rank by the documented score (descending). `exclude` filters machines that
 * already failed this session; `opts.secureCloudOnly` keeps datacenter hosts
 * only (onDatacenter).
 */
export async function findOffers(
  filters: OfferFilters,
  exclude: Set<number> = new Set(),
  opts: OfferSearchOptions = {}
): Promise<Offer[]> {
  const raw = await searchOffers(buildQuery(filters, opts))
  const offers = raw
    .filter((r) => !opts.secureCloudOnly || onDatacenter(r))
    .map(toOffer)
    .filter((o) => !exclude.has(o.machineId))
  const cpuBound = filters.cpuBound === true
  return offers.sort((a, b) => scoreOffer(b, cpuBound) - scoreOffer(a, cpuBound))
}
