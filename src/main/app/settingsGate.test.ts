import { describe, expect, it } from 'vitest'
import type { SettingsPublic } from '../../shared/models'
import { acceptedFields, applySettingsPatch, type SettingsStore } from './settingsGate'
import { SettingsOverlay } from './settingsOverlay'

// Plan 1.14: the one gate a settings change goes through. These cases use a
// store that behaves as settings.ts is to once it lays the session overlay
// over what it saved; settingsGate.ipc.test.ts drives the same gate through
// settings:set on the harness.

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

/** settings.ts in memory: `saved` is settings.json; getSettings lays the overlay over it. */
function store(overlay: SettingsOverlay): SettingsStore & {
  saved: SettingsPublic
  writes: Array<Partial<SettingsPublic>>
} {
  const s = {
    saved: { ...SAVED, offerFilters: { ...SAVED.offerFilters } },
    writes: [] as Array<Partial<SettingsPublic>>,
    getSettings: (): SettingsPublic => overlay.apply({ ...s.saved }),
    updateSettings: (patch: Partial<SettingsPublic>): SettingsPublic => {
      s.writes.push(patch)
      s.saved = {
        ...s.saved,
        ...patch,
        offerFilters: { ...s.saved.offerFilters, ...patch.offerFilters }
      }
      return s.getSettings()
    }
  }
  return s
}

const posix = { pathFlavour: 'posix' as const }

describe('applySettingsPatch (plan 1.14)', () => {
  it('a cleared spend cap is refused and the cap kept: nothing is written (#99 #112)', () => {
    const overlay = new SettingsOverlay()
    const s = store(overlay)
    const r = applySettingsPatch({ spendCapPerHour: null }, s, { ...posix, overlay })
    expect(r.settings.spendCapPerHour).toBe(2)
    expect(r.errors).toEqual([
      expect.objectContaining({ field: 'spendCapPerHour', outcome: 'rejected' })
    ])
    expect(s.writes).toEqual([])
  })

  it('"no spend cap" saves null together with the flag, and a figure turns it back off', () => {
    const overlay = new SettingsOverlay()
    const s = store(overlay)
    applySettingsPatch({ noSpendCap: true }, s, { ...posix, overlay })
    expect(s.saved).toMatchObject({ spendCapPerHour: null, noSpendCap: true })
    applySettingsPatch({ spendCapPerHour: 3.5 }, s, { ...posix, overlay })
    expect(s.saved).toMatchObject({ spendCapPerHour: 3.5, noSpendCap: false })
  })

  it('saves what passed and names what did not; a bad version does not cost the cap beside it', () => {
    const overlay = new SettingsOverlay()
    const s = store(overlay)
    const r = applySettingsPatch(
      { blenderVersionOverride: '4.5; rm -rf ~', spendCapPerHour: 4, idleTimeoutMinutes: 0 },
      s,
      { ...posix, overlay }
    )
    expect(s.saved).toMatchObject({
      blenderVersionOverride: null,
      spendCapPerHour: 4,
      idleTimeoutMinutes: 1
    })
    expect(r.errors.map((e) => [e.field, e.outcome])).toEqual([
      ['blenderVersionOverride', 'rejected'],
      ['idleTimeoutMinutes', 'clamped']
    ])
  })

  it("a user's change during a headless run saves that field alone, never the run's overlay", () => {
    // What getSettings() hands out carries the spec's 30 nodes and filters.
    // Saving the sanitized settings whole would write them to settings.json:
    // the bug the overlay is there to fix.
    const overlay = new SettingsOverlay()
    overlay.set({ maxActiveNodes: 30, eagerFleet: true, offerFilters: { minNumGpus: 4 } })
    const s = store(overlay)
    applySettingsPatch({ idleTimeoutMinutes: 9, offerFilters: { minDiskGb: 80 } }, s, {
      ...posix,
      overlay
    })
    expect(s.writes).toEqual([{ idleTimeoutMinutes: 9, offerFilters: { minDiskGb: 80 } }])
    expect(s.saved.maxActiveNodes).toBe(2)
    expect(s.saved.eagerFleet).toBe(false)
    expect(s.saved.offerFilters).not.toHaveProperty('minNumGpus')
    expect(s.getSettings().maxActiveNodes).toBe(30)
  })

  it("1.14 review: settings sent back as handed out during a headless run write none of the run's values", () => {
    // settings:set still takes a Partial<SettingsPublic>, and the renderer
    // before 1.14 sent the whole offerFilters object. What getSettings()
    // hands out carries the overlay, so sending it back named every field.
    const overlay = new SettingsOverlay()
    const run = {
      maxActiveNodes: 30,
      spendCapPerHour: 12,
      noSpendCap: false,
      eagerFleet: true,
      offerFilters: { minNumGpus: 4 }
    }
    overlay.set(run)
    const s = store(overlay)
    const handedOut = s.getSettings()

    const r = applySettingsPatch({ ...handedOut, idleTimeoutMinutes: 9 }, s, {
      ...posix,
      overlay
    })

    expect(r.errors).toEqual([])
    expect(s.saved).toMatchObject({
      maxActiveNodes: 2,
      spendCapPerHour: 2,
      noSpendCap: false,
      eagerFleet: false,
      idleTimeoutMinutes: 9
    })
    expect(s.saved.offerFilters).not.toHaveProperty('minNumGpus')
    for (const write of s.writes) {
      for (const key of ['maxActiveNodes', 'spendCapPerHour', 'noSpendCap', 'eagerFleet']) {
        expect(write).not.toHaveProperty(key)
      }
      expect(write.offerFilters ?? {}).not.toHaveProperty('minNumGpus')
    }
    // Still the run's, in force, until the run ends or a person changes one.
    expect(overlay.fields()).toEqual(run)
    expect(r.settings).toMatchObject({ maxActiveNodes: 30, spendCapPerHour: 12, eagerFleet: true })
  })

  it("a value the overlay does not hold is the person's, the saved one included", () => {
    const overlay = new SettingsOverlay()
    overlay.set({ maxActiveNodes: 30, spendCapPerHour: 12, noSpendCap: false })
    const s = store(overlay)
    // The saved figures, typed back in: a choice to go back to them now.
    applySettingsPatch({ maxActiveNodes: 2, spendCapPerHour: 2 }, s, { ...posix, overlay })
    expect(s.writes).toEqual([{ maxActiveNodes: 2, spendCapPerHour: 2, noSpendCap: false }])
    expect(overlay.isEmpty()).toBe(true)
    expect(s.getSettings()).toMatchObject({ maxActiveNodes: 2, spendCapPerHour: 2 })
  })

  it('max nodes set to 0 during a headless run is in force at once, not hidden behind the spec', () => {
    const overlay = new SettingsOverlay()
    overlay.set({ maxActiveNodes: 30 })
    const s = store(overlay)
    const r = applySettingsPatch({ maxActiveNodes: 0 }, s, { ...posix, overlay })
    expect(r.settings.maxActiveNodes).toBe(0)
    expect(s.saved.maxActiveNodes).toBe(0)
    expect(overlay.isEmpty()).toBe(true)
  })

  it('a refused field stays under the overlay', () => {
    const overlay = new SettingsOverlay()
    overlay.set({ maxActiveNodes: 30 })
    const s = store(overlay)
    applySettingsPatch({ maxActiveNodes: 'lots' }, s, { ...posix, overlay })
    expect(s.writes).toEqual([])
    expect(s.getSettings().maxActiveNodes).toBe(30)
  })

  it("a write that fails still releases the user's field, which settings.ts already holds", () => {
    const overlay = new SettingsOverlay()
    overlay.set({ maxActiveNodes: 30 })
    const s = store(overlay)
    const update = s.updateSettings
    s.updateSettings = (patch) => {
      update(patch)
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    expect(() => applySettingsPatch({ maxActiveNodes: 1 }, s, { ...posix, overlay })).toThrow(
      /ENOSPC/
    )
    expect(s.getSettings().maxActiveNodes).toBe(1)
  })

  it('paths are judged as this computer spells them', () => {
    const overlay = new SettingsOverlay()
    const s = store(overlay)
    const mac = applySettingsPatch({ projectRoot: 'C:\\Renders' }, s, { ...posix, overlay })
    expect(mac.errors[0]).toMatchObject({ field: 'projectRoot', outcome: 'rejected' })
    const win = applySettingsPatch({ projectRoot: 'C:\\Renders' }, s, {
      pathFlavour: 'win32',
      overlay
    })
    expect(win.errors).toEqual([])
    expect(s.saved.projectRoot).toBe('C:\\Renders')
  })
})

describe('acceptedFields', () => {
  it('drops derived fields, unknown fields and anything refused', () => {
    const current = { ...SAVED }
    const patch = { hasVastApiKey: false, bogus: 1, thumbnails: false, livePreview: 'sometimes' }
    const result = {
      settings: { ...current, thumbnails: false },
      errors: [
        { field: 'bogus', message: 'unknown setting "bogus"', outcome: 'rejected' as const },
        { field: 'livePreview', message: 'must be one of …', outcome: 'rejected' as const }
      ]
    }
    expect(acceptedFields(patch, result)).toEqual({ thumbnails: false })
  })

  it('keeps the spend cap pair together, and leaves both out when either was refused', () => {
    const result = {
      settings: { ...SAVED },
      errors: [{ field: 'spendCapPerHour', message: 'blank', outcome: 'rejected' as const }]
    }
    expect(acceptedFields({ spendCapPerHour: null }, result)).toEqual({})
    expect(
      acceptedFields(
        { spendCapPerHour: 3 },
        { settings: { ...SAVED, spendCapPerHour: 3 }, errors: [] }
      )
    ).toEqual({ spendCapPerHour: 3, noSpendCap: false })
  })
})
