import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Offer, OfferFilters } from '../../shared/models'
import type { RawOffer } from './types'

// gpu_perf lives in SQLite (db.ts pulls in electron) — stub a tiny table.
const perf = new Map<string, { frames_per_hour: number; samples: number }>()
vi.mock('../db/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (name: string) => perf.get(name),
      run: (...args: unknown[]) => {
        if (sql.startsWith('INSERT')) {
          perf.set(args[0] as string, { frames_per_hour: args[1] as number, samples: 1 })
        } else {
          const row = perf.get(args[2] as string)!
          row.frames_per_hour = args[0] as number
          row.samples++
        }
      }
    })
  })
}))
// What /bundles/ answers, and the queries it was sent.
const market: Array<RawOffer & Record<string, unknown>> = []
const queries: Array<Record<string, unknown>> = []
vi.mock('./vastClient', () => ({
  searchOffers: async (q: Record<string, unknown>) => {
    queries.push(q)
    return market.map((o) => ({ ...o }))
  }
}))

const { buildQuery, findOffers, recordThroughput, scoreOffer } = await import('./offers')

const filters = (f: Partial<OfferFilters> = {}): OfferFilters => ({
  gpuNames: [],
  maxDphTotal: null,
  minGpuRamGb: 10,
  minInetDownMbps: 100,
  minReliability: 0.95,
  minDiskGb: 40,
  ...f
})

const offer = (o: Partial<Offer> = {}): Offer => ({
  id: 1,
  machineId: 1,
  gpuName: 'RTX 4090',
  numGpus: 1,
  gpuRamGb: 24,
  dphTotal: 0.4,
  dlperfPerDph: 200,
  inetDownMbps: 500,
  inetUpMbps: 500,
  reliability: 0.99,
  cudaMaxGood: 12.4,
  geolocation: null,
  diskSpaceGb: 100,
  cpuName: null,
  cpuCoresEffective: 32,
  cpuGhz: 4,
  ...o
})

beforeEach(() => {
  perf.clear()
  market.length = 0
  queries.length = 0
})

function raw(id: number, extra: Record<string, unknown> = {}): RawOffer & Record<string, unknown> {
  return {
    id,
    machine_id: 100 + id,
    gpu_name: 'RTX 4090',
    num_gpus: 1,
    gpu_ram: 24_576,
    dph_total: 0.4,
    inet_down: 1000,
    inet_up: 500,
    reliability2: 0.99,
    disk_space: 100,
    ...extra
  }
}

describe('buildQuery', () => {
  it('filters on GPU count only when asked', () => {
    expect(buildQuery(filters()).num_gpus).toBeUndefined()
    expect(buildQuery(filters({ minNumGpus: 4 })).num_gpus).toEqual({ gte: 4 })
    expect(buildQuery(filters({ minNumGpus: null })).num_gpus).toBeUndefined()
  })

  it('1.18: asks for datacenter (secure cloud) hosts only when told to', () => {
    expect(buildQuery(filters()).datacenter).toBeUndefined()
    expect(buildQuery(filters(), { secureCloudOnly: false }).datacenter).toBeUndefined()
    expect(buildQuery(filters(), { secureCloudOnly: true }).datacenter).toEqual({ eq: true })
  })
})

describe('findOffers, secure cloud only (1.18)', () => {
  it('1.18: keeps only offers whose reply says datacenter, whatever the query was answered with', async () => {
    market.push(
      raw(1, { datacenter: true }),
      raw(2, { hosting_type: 1 }),
      raw(3, { datacenter: false, hosting_type: 0 }),
      // Says nothing either way: a query key Vast ignored, or a renamed field.
      raw(4)
    )
    const found = await findOffers(filters(), new Set(), { secureCloudOnly: true })
    expect(found.map((o) => o.id).sort()).toEqual([1, 2])
    expect(queries[0].datacenter).toEqual({ eq: true })
  })

  it('1.18: without the option every host is a candidate, as before', async () => {
    market.push(raw(1, { datacenter: true }), raw(3, { hosting_type: 0 }), raw(4))
    const found = await findOffers(filters())
    expect(found.map((o) => o.id).sort()).toEqual([1, 3, 4])
    expect(queries[0].datacenter).toBeUndefined()
  })
})

describe('measured throughput is per GPU', () => {
  it('stores a node total divided by its GPU count', () => {
    recordThroughput('RTX 4090', 240, 4)
    expect(perf.get('RTX 4090')?.frames_per_hour).toBe(60)
  })

  it('learns the same figure from a 1-GPU and a 4-GPU node', () => {
    recordThroughput('RTX 4090', 60, 1)
    recordThroughput('RTX 4090', 240, 4)
    expect(perf.get('RTX 4090')?.frames_per_hour).toBeCloseTo(60)
  })

  it('ranks a 4-GPU node at 4x the price the same as four 1-GPU nodes', () => {
    recordThroughput('RTX 4090', 60, 1)
    const one = scoreOffer(offer({ numGpus: 1, dphTotal: 0.4 }))
    const four = scoreOffer(offer({ numGpus: 4, dphTotal: 1.6 }))
    expect(four).toBeCloseTo(one)
    // ...and a cheaper-per-GPU 4-GPU node wins.
    expect(scoreOffer(offer({ numGpus: 4, dphTotal: 1.2 }))).toBeGreaterThan(one)
  })
})
