import { describe, expect, it } from 'vitest'
import {
  coreParams,
  gradeToFilter,
  gradesEqual,
  hasShaderOnly,
  IDENTITY_GRADE,
  isNeutral,
  resolvePreset,
  SHADER_ONLY_KEYS,
  type Grade
} from './grade'

describe('the two tiers', () => {
  it('gives every shader-only field an identity default', () => {
    // This is the whole localStorage migration: useGrade spreads a stored
    // object over DEFAULT_GRADE, so identity defaults are what let a v1 entry
    // written before these fields existed reproduce exactly the old picture.
    for (const k of SHADER_ONLY_KEYS) {
      expect(hasShaderOnly({ ...IDENTITY_GRADE, [k]: IDENTITY_GRADE[k] })).toBe(false)
    }
    expect(hasShaderOnly(IDENTITY_GRADE)).toBe(false)
  })

  it('reproduces a pre-shader stored grade unchanged', () => {
    // Exactly what localStorage holds for a user of the CSS-only build.
    const storedV1 = { contrast: 1.35, brightness: 0.96, saturate: 1.1, lift: 0 }
    const loaded: Grade = { ...IDENTITY_GRADE, ...storedV1 }
    expect(gradeToFilter(loaded)).toBe('contrast(1.35) brightness(0.96) saturate(1.1)')
    expect(hasShaderOnly(loaded)).toBe(false)
  })

  it('flags a grade the CSS path cannot express', () => {
    expect(hasShaderOnly({ ...IDENTITY_GRADE, exposure: 0.5 })).toBe(true)
    expect(hasShaderOnly({ ...IDENTITY_GRADE, gamma: 1.2 })).toBe(true)
    expect(hasShaderOnly({ ...IDENTITY_GRADE, temperature: -0.3 })).toBe(true)
  })
})

describe('coreParams', () => {
  it('folds lift into brightness exactly once', () => {
    // Both graders read coreParams, so this is the only place the two can
    // agree or drift. gradeToFilter must not re-apply it.
    const g: Grade = { ...IDENTITY_GRADE, brightness: 0.9, lift: 0.05 }
    expect(coreParams(g).brightness).toBeCloseTo(0.95, 10)
    expect(gradeToFilter(g)).toContain('brightness(0.95)')
  })

  it('ignores the shader-only tier', () => {
    const g: Grade = { ...IDENTITY_GRADE, exposure: 2, gamma: 0.5, temperature: 1 }
    expect(gradeToFilter(g)).toBe(gradeToFilter(IDENTITY_GRADE))
  })
})

describe('presets', () => {
  it('resolves partials over identity, so a preset fully defines a look', () => {
    // The bug this prevents: presets used to be merged as partial patches, so
    // "punchy" applied after a session with exposure set would inherit that
    // exposure and mean something different depending on history.
    expect(resolvePreset('punchy')).toEqual({
      ...IDENTITY_GRADE,
      contrast: 1.35,
      brightness: 0.96,
      saturate: 1.1
    })
    for (const name of ['neutral', 'punchy', 'flat', 'high', 'mono']) {
      const resolved = resolvePreset(name)
      for (const k of SHADER_ONLY_KEYS) expect(resolved[k]).toBe(IDENTITY_GRADE[k])
    }
  })

  it('falls back to identity for an unknown name', () => {
    expect(resolvePreset('nope')).toEqual(IDENTITY_GRADE)
  })
})

describe('gradesEqual', () => {
  it('compares field-wise, not by key order', () => {
    // The old check was JSON.stringify(a) === JSON.stringify(b), which breaks
    // as soon as Grade grows a field the presets omit.
    const a: Grade = { ...IDENTITY_GRADE, contrast: 1.35 }
    const reordered = {
      saturate: 1,
      lift: 0,
      brightness: 1,
      contrast: 1.35,
      exposure: 0,
      gamma: 1,
      temperature: 0
    }
    expect(gradesEqual(a, reordered)).toBe(true)
    expect(gradesEqual(a, { ...a, temperature: 0.01 })).toBe(false)
  })

  it('treats identity as neutral', () => {
    expect(isNeutral(IDENTITY_GRADE)).toBe(true)
    expect(isNeutral({ ...IDENTITY_GRADE, exposure: 0.1 })).toBe(false)
  })
})
