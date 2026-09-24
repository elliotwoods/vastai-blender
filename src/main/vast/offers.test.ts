import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Offer, OfferFilters } from '../../shared/models'

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
vi.mock('./vastClient', () => ({ searchOffers: async () => [] }))

const { buildQuery, recordThroughput, scoreOffer } = await import('./offers')

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

beforeEach(() => perf.clear())

describe('buildQuery', () => {
  it('filters on GPU count only when asked', () => {
    expect(buildQuery(filters()).num_gpus).toBeUndefined()
    expect(buildQuery(filters({ minNumGpus: 4 })).num_gpus).toEqual({ gte: 4 })
    expect(buildQuery(filters({ minNumGpus: null })).num_gpus).toBeUndefined()
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
