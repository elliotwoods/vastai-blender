import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsPublic } from '../../../shared/models'
import { SettingsOverlay } from '../settingsOverlay'
import {
  SpecSettingsRefused,
  applySpecSettings,
  inlineSpecProblems,
  specSettingsPatch
} from './jobSpec'

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

  it('a value past its limit is in force at the limit, and said on stderr', () => {
    const o = new SettingsOverlay()
    const fields = applySpecSettings({ maxActiveNodes: 500 }, withOverlay(o), o)
    expect(fields).toEqual({ maxActiveNodes: 64 })
    expect(o.fields()).toEqual({ maxActiveNodes: 64 })
    expect(stderr).toEqual([
      expect.stringMatching(/^\[spec\] setting clamped: max active nodes can be at most 64/)
    ])
  })

  it('a setting the sanitizer refuses refuses the campaign, and puts none of its settings in force', () => {
    // It would otherwise run at the saved value, which may rent more.
    const o = new SettingsOverlay()
    const apply = (): unknown =>
      applySpecSettings(
        { maxActiveNodes: 1, eagerFleet: 'yes', slotsPerGpu: 1.5 },
        withOverlay(o),
        o
      )
    expect(apply).toThrow(SpecSettingsRefused)
    expect(apply).toThrow(/^the spec's settings cannot all be put in force for this run, so none/)
    expect(apply).toThrow(/eagerFleet: buy-ahead fleet must be on or off/)
    expect(apply).toThrow(/slotsPerGpu: render slots per GPU must be a whole number/)
    expect(o.isEmpty()).toBe(true)
    expect(stderr).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[spec\] setting refused: buy-ahead fleet must be on or off/)
      ])
    )
  })

  it('1.14 review: settings getSettings() does not hand out refuse the campaign, rather than run it at the saved caps', () => {
    // A build whose settings.ts does not lay the overlay over what it saved
    // (the one this landed in). Saved as the field incident left Elliot's
    // profile: a smoke test asking for 1 node at $2/hr, no buy-ahead, would
    // have rented up to 30 and bought ahead to $50/hr.
    const saved: SettingsPublic = {
      ...SAVED,
      maxActiveNodes: 30,
      spendCapPerHour: 50,
      eagerFleet: true
    }
    const o = new SettingsOverlay()
    let thrown: unknown
    try {
      applySpecSettings(
        {
          maxActiveNodes: 1,
          spendCapPerHour: 2,
          eagerFleet: false,
          offerFilters: { minNumGpus: 4 }
        },
        () => saved,
        o
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SpecSettingsRefused)
    expect((thrown as SpecSettingsRefused).problems).toEqual([
      'maxActiveNodes is 30, not the 1 the spec asked for',
      'eagerFleet is true, not the false the spec asked for',
      'offerFilters.minNumGpus is unset, not the 4 the spec asked for',
      'spendCapPerHour is 50, not the 2 the spec asked for'
    ])
    expect((thrown as Error).message).toMatch(
      /\(this build's settings\.ts does not apply settings for one run only\)$/
    )
    expect(o.isEmpty()).toBe(true)
  })

  it('a spec with no settings leaves the overlay empty', () => {
    const o = new SettingsOverlay()
    expect(applySpecSettings({ blends: ['/a.blend'] }, withOverlay(o), o)).toEqual({})
    expect(o.isEmpty()).toBe(true)
  })
})

describe('inlineSpecProblems: a spec sent over main/api (B6)', () => {
  it('takes full local paths, a name and a dedupe', () => {
    expect(
      inlineSpecProblems(
        {
          blends: ['/scenes/a.blend', { path: '/scenes/b.blend', name: 'B' }],
          addonZips: ['/addons/x.zip'],
          name: 'hero',
          dedupe: 'never'
        },
        'posix'
      )
    ).toEqual([])
    expect(inlineSpecProblems({ blendDir: 'C:\\scenes' }, 'win32')).toEqual([])
  })

  it.each([
    [{ blends: ['scenes/a.blend'] }, /blends\[0\] must be a full path/],
    [{ blends: ['//server/share/a.blend'] }, /blends\[0\] must be on this computer/],
    [{ blends: [{ path: '\\\\server\\a.blend' }] }, /blends\[0\]\.path must be on this computer/],
    [{ blends: ['/a/../b.blend'] }, /'\.\.'/],
    [{ blendDir: 'relative' }, /blendDir must be a full path/],
    [{ blends: ['/a.blend'], addonZips: ['x.zip'] }, /addonZips\[0\]/],
    [{ blends: [] }, /needs "blends"/],
    [{ blends: [7] }, /blends\[0\] must be a path/],
    [{ blends: ['/a.blend'], name: 5 }, /name must be a non-empty string/],
    [{ blends: ['/a.blend'], dedupe: 'always' }, /dedupe must be one of/]
  ])('refuses %j', (spec, why) => {
    expect(inlineSpecProblems(spec, 'posix').join('; ')).toMatch(why)
  })
})
