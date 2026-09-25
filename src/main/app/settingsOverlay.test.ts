import { describe, expect, it } from 'vitest'
import type { SettingsPublic } from '../../shared/models'
import { SettingsOverlay } from './settingsOverlay'

// Plan 1.14: a headless spec's settings are this session's alone. Field:
// two sessions of VR_JOB_SPEC runs rewrote Elliot's settings.json for good.

const SAVED: SettingsPublic = {
  hasVastApiKey: true,
  hasOtoyCredentials: false,
  projectRoot: '/Users/me/vast-renders',
  maxActiveNodes: 2,
  spendCapPerHour: 2,
  noSpendCap: false,
  idleTimeoutMinutes: 5,
  proxyCodec: 'hevc',
  blenderVersionOverride: null,
  offerFilters: {
    gpuNames: [],
    maxDphTotal: null,
    minGpuRamGb: 10,
    minInetDownMbps: 100,
    minReliability: 0.95,
    minDiskGb: 40
  },
  sshKeyPath: '',
  concurrentTransfersPerNode: 3,
  thumbnails: true,
  livePreview: 'onDemand',
  livePreviewWidth: 960,
  maxNodeSlots: 0,
  slotsPerGpu: 1,
  eagerFleet: false,
  co2OverheadFactor: 1.6,
  installId: 'aaaaaaaa-0000-0000-0000-000000000000'
}

describe('SettingsOverlay (plan 1.14)', () => {
  it('empty, it hands the saved settings back as they are', () => {
    const o = new SettingsOverlay()
    expect(o.isEmpty()).toBe(true)
    expect(o.apply(SAVED)).toBe(SAVED)
  })

  it("lays a run's fields over the saved ones, filter by filter, and leaves the saved object alone", () => {
    const o = new SettingsOverlay()
    o.set({
      maxActiveNodes: 30,
      spendCapPerHour: 12,
      noSpendCap: false,
      offerFilters: { minNumGpus: 4 }
    })
    const s = o.apply(SAVED)
    expect(s).toMatchObject({ maxActiveNodes: 30, spendCapPerHour: 12, idleTimeoutMinutes: 5 })
    expect(s.offerFilters).toEqual({ ...SAVED.offerFilters, minNumGpus: 4 })
    expect(SAVED.maxActiveNodes).toBe(2)
    expect(SAVED.offerFilters).not.toHaveProperty('minNumGpus')
  })

  it("never holds main's own fields", () => {
    const o = new SettingsOverlay()
    o.set({ installId: 'bbbbbbbb-0000', hasVastApiKey: false, maxActiveNodes: 3 })
    expect(o.fields()).toEqual({ maxActiveNodes: 3 })
  })

  it('a field the user saves is theirs: released, the rest stays in force', () => {
    const o = new SettingsOverlay()
    o.set({ maxActiveNodes: 30, eagerFleet: true, offerFilters: { minNumGpus: 4, cpuBound: true } })
    expect(o.release({ maxActiveNodes: 0, offerFilters: { cpuBound: false } })).toEqual([
      'maxActiveNodes',
      'offerFilters.cpuBound'
    ])
    expect(o.fields()).toEqual({ eagerFleet: true, offerFilters: { minNumGpus: 4 } })
    expect(o.apply({ ...SAVED, maxActiveNodes: 0 }).maxActiveNodes).toBe(0)
  })

  it('the spend cap and its flag are released together, whichever the user saved', () => {
    const o = new SettingsOverlay()
    o.set({ spendCapPerHour: 12, noSpendCap: false })
    o.release({ noSpendCap: true })
    expect(o.isEmpty()).toBe(true)
  })
})
