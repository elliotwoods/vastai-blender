import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsPublic } from '../../../shared/models'
import { SettingsOverlay } from '../settingsOverlay'
import { applySpecSettings, specSettingsPatch } from './jobSpec'

// Plan 1.14: a VR_JOB_SPEC campaign's settings are its session's alone,
// through the same sanitizer as the Settings screen's. Field: two sessions
// of spec runs rewrote Elliot's settings.json for good (indexLifecycle.test.ts
// drives that through index.ts against the real settings.ts).

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
  co2OverheadFactor: 1.6
}

let stderr: string[]
beforeEach(() => {
  stderr = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('specSettingsPatch: the fields a spec has always set', () => {
  it('reads each, as the driver in index.ts did', () => {
    expect(
      specSettingsPatch({
        maxActiveNodes: 4,
        spendCapPerHour: 2,
        maxNodeSlots: 0,
        eagerFleet: false,
        slotsPerGpu: 0,
        offerFilters: { cpuBound: true },
        engine: 'eevee',
        blends: ['/a.blend']
      })
    ).toEqual({
      maxActiveNodes: 4,
      spendCapPerHour: 2,
      maxNodeSlots: 0,
      eagerFleet: false,
      slotsPerGpu: 0,
      offerFilters: { cpuBound: true }
    })
  })

  it('a zero fleet size or cap is no request; nodeSlots is the old name for maxNodeSlots', () => {
    expect(specSettingsPatch({ maxActiveNodes: 0, spendCapPerHour: 0, nodeSlots: 3 })).toEqual({
      maxNodeSlots: 3
    })
  })
})

describe('applySpecSettings (plan 1.14)', () => {
  /** getSettings() as settings.ts is to answer once it lays the overlay over what is saved. */
  const withOverlay = (o: SettingsOverlay) => (): SettingsPublic => o.apply(SAVED)

  it('puts the checked settings in the overlay, and says nothing is saved', () => {
    const o = new SettingsOverlay()
    const fields = applySpecSettings(
      { maxActiveNodes: 30, spendCapPerHour: 12, offerFilters: { minNumGpus: 4 } },
      withOverlay(o),
      o
    )
    expect(fields).toEqual({
      maxActiveNodes: 30,
      spendCapPerHour: 12,
      noSpendCap: false,
      offerFilters: { minNumGpus: 4 }
    })
    expect(o.fields()).toEqual(fields)
    expect(stderr).toEqual([])
  })

  it('a value past its limit runs at the limit, and a refused one at the saved value, each said', () => {
    const o = new SettingsOverlay()
    const fields = applySpecSettings(
      { maxActiveNodes: 500, eagerFleet: 'yes', slotsPerGpu: 1.5 },
      withOverlay(o),
      o
    )
    expect(fields).toEqual({ maxActiveNodes: 64 })
    expect(stderr).toEqual([
      expect.stringMatching(/^\[spec\] setting clamped: max active nodes can be at most 64/),
      expect.stringMatching(/^\[spec\] setting refused: buy-ahead fleet must be on or off/),
      expect.stringMatching(
        /^\[spec\] setting refused: render slots per GPU must be a whole number/
      )
    ])
  })

  it('a setting getSettings() does not hand out as asked is named on stderr, with the value in force', () => {
    // A build whose settings.ts does not yet lay the overlay over what it
    // saved: the campaign must not run at other settings without a word.
    const o = new SettingsOverlay()
    applySpecSettings({ maxActiveNodes: 30, offerFilters: { minNumGpus: 4 } }, () => SAVED, o)
    expect(stderr).toEqual([
      '[spec] not in force: this build does not apply a run-only setting, so these run at the ' +
        'saved value: maxActiveNodes 2 (the spec asked for 30), offerFilters.minNumGpus ' +
        'undefined (the spec asked for 4)'
    ])
  })

  it('a spec with no settings leaves the overlay empty', () => {
    const o = new SettingsOverlay()
    expect(applySpecSettings({ blends: ['/a.blend'] }, withOverlay(o), o)).toEqual({})
    expect(o.isEmpty()).toBe(true)
  })
})
