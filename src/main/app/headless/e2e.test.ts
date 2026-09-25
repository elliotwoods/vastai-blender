import { relative } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type World } from '../../test/harness'

// VR_E2E_BLEND, as a person types it: relative to where the run started.

let w: World
beforeEach(async () => {
  w = await setup()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await w.dispose()
})

describe('runE2e', () => {
  it('integration review: a scene named relative to the run is made full, and a re-run finds the job it made', async () => {
    // A job's scene must be a full path (validateSubmission, b5785f2): a
    // relative VR_E2E_BLEND submitted nothing, and the run exited 1.
    await w.boot({ start: false })
    const blend = w.blend('e2e.blend')
    const named = relative(process.cwd(), blend)
    const { runE2e } = await import('./e2e')
    const campaign: string[] = []
    const kick = vi.fn()

    await runE2e(named, { kick, campaign })
    expect(w.all('SELECT blend_path FROM jobs')).toEqual([{ blend_path: blend }])
    expect(campaign).toHaveLength(1)
    expect(kick).toHaveBeenCalledTimes(1)

    // The next launch's driver: no second job, and it waits on this one.
    const again: string[] = []
    await runE2e(named, { kick, campaign: again })
    expect(w.all('SELECT id FROM jobs')).toEqual([{ id: campaign[0] }])
    expect(again).toEqual(campaign)
  })
})
