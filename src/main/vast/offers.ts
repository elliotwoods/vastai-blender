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

export function buildQuery(f: OfferFilters): Record<string, unknown> {
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
  return q
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

function measuredFramesPerHour(gpuName: string): number | null {
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
 */
export function recordThroughput(gpuName: string, framesPerHour: number): void {
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
    // frames/hour per dollar/hour = frames per dollar. Scale to roughly the
    // magnitude of dlperf_per_dphtotal so mixed fleets rank sanely.
    perfPerDollar = (measured / o.dphTotal) * 0.5
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
 * already failed this session.
 */
export async function findOffers(
  filters: OfferFilters,
  exclude: Set<number> = new Set()
): Promise<Offer[]> {
  const raw = await searchOffers(buildQuery(filters))
  const offers = raw.map(toOffer).filter((o) => !exclude.has(o.machineId))
  const cpuBound = filters.cpuBound === true
  return offers.sort((a, b) => scoreOffer(b, cpuBound) - scoreOffer(a, cpuBound))
}
