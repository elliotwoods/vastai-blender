import { describe, expect, it } from 'vitest'
import { SETTINGS_LIMITS } from '../../../../shared/settingsSanitize'
import {
  blenderVersionPatch,
  blenderVersionProblem,
  fieldsOf,
  limitsOf,
  mergeFieldErrors,
  noSpendCapPatch,
  spendCapMode
} from './settingsForm'

// Plan 1.14 (#99 #112): the Settings screen sent a patch per keystroke, and
// backspacing the spend cap to retype it saved "no cap".

describe('the spend cap on the Settings screen', () => {
  it('"no spend cap" is only ever the box: ticking it sends the flag, unticking sends nothing', () => {
    expect(noSpendCapPatch(true)).toEqual({ noSpendCap: true })
    // Nothing until a figure is typed; never a null cap.
    expect(noSpendCapPatch(false)).toBeNull()
  })

  it('reads a figure, the flag, and a blank with no flag (a file from before it) apart', () => {
    expect(spendCapMode({ spendCapPerHour: 2, noSpendCap: false })).toBe('cap')
    expect(spendCapMode({ spendCapPerHour: 2 })).toBe('cap')
    expect(spendCapMode({ spendCapPerHour: null, noSpendCap: true })).toBe('noCap')
    // Scale-up reads this as $0/hr and rents nothing; the screen says so.
    expect(spendCapMode({ spendCapPerHour: null })).toBe('blank')
  })
})

describe('field errors from settings:update', () => {
  const clamped = {
    field: 'idleTimeoutMinutes',
    message: "idle timeout can't be below 1, so 1 was saved (got 0)",
    outcome: 'clamped' as const
  }
  const refusedCap = {
    field: 'spendCapPerHour',
    message: 'the spend cap is blank',
    outcome: 'rejected' as const
  }

  it('names the fields a patch touched, filters dotted, the cap and its flag together', () => {
    expect(fieldsOf({ offerFilters: { minDiskGb: 80, cpuBound: true } })).toEqual([
      'offerFilters.minDiskGb',
      'offerFilters.cpuBound'
    ])
    expect(fieldsOf({ noSpendCap: true })).toEqual(['spendCapPerHour', 'noSpendCap'])
    expect(fieldsOf({ maxActiveNodes: 3, spendCapPerHour: 2 })).toEqual([
      'maxActiveNodes',
      'spendCapPerHour',
      'noSpendCap'
    ])
  })

  it("a save replaces the errors of the fields it touched and keeps the others'", () => {
    let shown = mergeFieldErrors([], { idleTimeoutMinutes: 0 }, [clamped])
    shown = mergeFieldErrors(shown, { spendCapPerHour: null }, [refusedCap])
    expect(shown).toEqual([clamped, refusedCap])
    // The cap saved cleanly at last: its error goes, the idle timeout's stays.
    expect(mergeFieldErrors(shown, { spendCapPerHour: 3 }, [])).toEqual([clamped])
    expect(mergeFieldErrors(shown, { noSpendCap: true }, [])).toEqual([clamped])
  })
})

describe('the Blender version override', () => {
  it.each(['4.5', '4.5.3', '5.1', ' 4.2.3 ', ''])('takes %j', (text) => {
    expect(blenderVersionProblem(text)).toBeNull()
  })

  it.each(['4.5; rm -rf ~', '4.5 && curl x|sh', 'latest', '4', '4.5.3.1', '$(id)'])(
    'refuses %j, which would reach the node shell unquoted',
    (text) => {
      expect(blenderVersionProblem(text)).toMatch(/a version such as 4\.5/)
    }
  )

  it('blank means match each .blend', () => {
    expect(blenderVersionPatch('  ')).toEqual({ blenderVersionOverride: null })
    expect(blenderVersionPatch(' 4.5 ')).toEqual({ blenderVersionOverride: '4.5' })
  })
})

describe('limitsOf', () => {
  it("is main's limits, so a field refuses what main would clamp", () => {
    expect(limitsOf('maxActiveNodes')).toEqual({ min: 0, max: 64, integer: true })
    expect(limitsOf('spendCapPerHour')).toEqual({
      min: SETTINGS_LIMITS.spendCapPerHour.min,
      max: SETTINGS_LIMITS.spendCapPerHour.max,
      integer: false
    })
  })
})
