import { relative } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobSubmission } from '../shared/models'
import { setup, type World } from './test/harness'

// Phase 0 review, carried to plans 1.12 and 1.14: job:create took any
// blendPath string, and every jobs.blend_path is a place
// shell:showItemInFolder may reveal, so a UNC scene path became revealable
// (on Windows, revealing one hands the user's NTLM hash to the share's
// server). A scene must be a file on this computer.

let w: World
beforeEach(async () => {
  w = await setup()
  await w.boot({ start: false })
})
afterEach(() => w.dispose())

function submission(blendPath: string): JobSubmission {
  return {
    blendPath,
    engine: 'cycles',
    frameStart: 1,
    frameEnd: 4,
    frameStep: 1,
    addonIds: [],
    chunkSize: 4
  }
}

describe('job:create: the scene is a local file (plans 1.12, 1.14)', () => {
  it.each([
    ['a network share', '\\\\fileserver\\scenes\\hero.blend', /on this computer/],
    ['a network share, forward slashes', '//fileserver/scenes/hero.blend', /on this computer/]
  ])('refuses %s, and creates no job', async (_what, path, reason) => {
    await expect(w.invoke('job:create', submission(path))).rejects.toThrow(reason)
    expect(w.all('SELECT id FROM jobs')).toEqual([])
  })

  // These two name a scene that is there, so only the check refuses them.
  it('refuses a relative path, even to a scene that exists from where main was started', async () => {
    const path = relative(process.cwd(), w.blend())
    await expect(w.invoke('job:create', submission(path))).rejects.toThrow(/full path/)
    expect(w.all('SELECT id FROM jobs')).toEqual([])
  })

  it("refuses a path with '..' in it, even one that stays on this computer", async () => {
    const path = w.blend().replace(/scenes([\\/])scene\.blend$/, 'scenes$1..$1scenes$1scene.blend')
    expect(path).toContain('..')
    await expect(w.invoke('job:create', submission(path))).rejects.toThrow(/'\.\.'/)
    expect(w.all('SELECT id FROM jobs')).toEqual([])
  })

  it('takes a scene on this computer', async () => {
    const { jobId } = await w.invoke('job:create', submission(w.blend()))
    expect(w.get('SELECT blend_path FROM jobs WHERE id = ?', jobId)).toEqual({
      blend_path: w.blend()
    })
  })
})
