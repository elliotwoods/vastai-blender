import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type App, type World } from '../../test/harness'
import { SettingsOverlay } from '../settingsOverlay'
import type { HandoffDeps, HandoffRequest, HandoffResult } from './handoff'
// handoff.ts / drivers.ts are loaded after the harness has stubbed electron (as jobSpec.revive.test.ts does)
const handoff = (): Promise<typeof import('./handoff')> => import('./handoff')

// VR_JOB_SPEC hand-off (handoff.ts): a campaign launched while the app runs on
// the profile is submitted by that app. The running app's fleet is shared, so
// a handed-off spec's fleet settings go in force only with no other work open,
// and are released when its campaign is done.

describe('acceptHandoff, in the running app', () => {
  let w: World
  beforeEach(async () => {
    w = await setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await w.dispose()
  })

  function spec(extra: Record<string, unknown>, blends: unknown[]): string {
    const path = join(w.dir, `spec-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(
      path,
      JSON.stringify({ engine: 'cycles', frameStart: 1, frameEnd: 4, blends, ...extra })
    )
    return path
  }

  function request(jobSpec: string, cwd: string): HandoffRequest {
    return {
      scripted: true,
      jobSpec,
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      cwd
    }
  }

  async function deps(app: App, overlay: SettingsOverlay, kick = vi.fn()): Promise<HandoffDeps> {
    const { openJobs } = await import('./drivers')
    return {
      userData: w.dir,
      kick,
      resume: {
        recovery: (ids: readonly string[]) => app.scheduler.resumeRecoveryFor(ids),
        job: (id: string) => app.scheduler.resumeJob(id, { octaneSignIn: false })
      },
      openJobs,
      overlay,
      pollMs: 1_000
    }
  }

  function answer(req: HandoffRequest): HandoffResult {
    return JSON.parse(readFileSync(join(w.dir, 'handoff', `${req.requestId}.json`), 'utf-8'))
  }

  it('submits the campaign, a relative blend resolved from the launching directory, and answers', async () => {
    const app = await w.boot({ start: false })
    const blend = w.blend('shot.blend')
    const req = request(spec({}, [basename(blend)]), dirname(blend))
    const kick = vi.fn()
    const result = await (
      await handoff()
    ).acceptHandoff(req, await deps(app, new SettingsOverlay(), kick))

    expect(result.ok).toBe(true)
    expect(result.jobs).toHaveLength(1)
    expect(w.all('SELECT blend_path FROM jobs')).toEqual([{ blend_path: blend }])
    expect(kick).toHaveBeenCalled()
    expect(answer(req)).toEqual(result)
  })

  it('with other work open, refuses fleet settings that differ, and submits nothing', async () => {
    const app = await w.boot({ start: false })
    await w.submitJob(app, { blendPath: w.blend('theirs.blend') })
    const overlay = new SettingsOverlay()
    const req = request(
      spec({ maxActiveNodes: 3, spendCapPerHour: 18 }, [w.blend('mine.blend')]),
      w.dir
    )
    const result = await (await handoff()).acceptHandoff(req, await deps(app, overlay))

    expect(result.ok).toBe(false)
    expect(result.refused).toMatch(/open job\(s\) at its own settings/)
    expect(result.refused).toMatch(/maxActiveNodes/)
    expect(w.all('SELECT COUNT(*) AS n FROM jobs')).toEqual([{ n: 1 }])
    expect(overlay.isEmpty()).toBe(true)
    expect(answer(req).refused).toBe(result.refused)
  })

  it('with other work open, a spec without fleet settings just adds its jobs', async () => {
    const app = await w.boot({ start: false })
    await w.submitJob(app, { blendPath: w.blend('theirs.blend') })
    const req = request(spec({}, [w.blend('mine.blend')]), w.dir)
    const result = await (
      await handoff()
    ).acceptHandoff(req, await deps(app, new SettingsOverlay()))

    expect(result.ok).toBe(true)
    expect(w.all('SELECT COUNT(*) AS n FROM jobs')).toEqual([{ n: 2 }])
  })

  it('with no other work, puts the settings in force for the campaign and releases them when it is done', async () => {
    const app = await w.boot({ start: false })
    // the app's own overlay: getSettings() reads it, and applySpecSettings checks the settings came through
    const { sessionOverlay: overlay } = await import('../settingsOverlay')
    const { getSettings } = await import('../../settings')
    const req = request(
      spec({ maxActiveNodes: 1, spendCapPerHour: 8 }, [w.blend('mine.blend')]),
      w.dir
    )
    const result = await (await handoff()).acceptHandoff(req, await deps(app, overlay))

    expect(result.ok).toBe(true)
    expect(result.settings).toMatchObject({ maxActiveNodes: 1, spendCapPerHour: 8 })
    expect(overlay.fields()).toMatchObject({ maxActiveNodes: 1, spendCapPerHour: 8 })
    expect(getSettings()).toMatchObject({ maxActiveNodes: 1, spendCapPerHour: 8 })

    await w.advance(5_000)
    expect(overlay.isEmpty()).toBe(false) // still rendering

    w.db.prepare(`UPDATE jobs SET state = 'complete' WHERE id = ?`).run(result.jobs[0])
    await w.advance(5_000)
    expect(overlay.isEmpty()).toBe(true)
    expect(getSettings()).toMatchObject({ maxActiveNodes: 2, spendCapPerHour: 2 }) // the saved ones again
  })

  it('a spec that cannot be read is answered as not submitted', async () => {
    const app = await w.boot({ start: false })
    const req = request(join(w.dir, 'missing.json'), w.dir)
    const result = await (
      await handoff()
    ).acceptHandoff(req, await deps(app, new SettingsOverlay()))

    expect(result.ok).toBe(false)
    expect(result.unsubmitted[0]).toMatch(/missing\.json/)
    expect(answer(req).ok).toBe(false)
  })
})

describe('the refused launch', () => {
  it('isHandoffRequest: only a well-formed request, never a plain scripted flag', async () => {
    const { isHandoffRequest } = await handoff()
    const ok = { scripted: true, jobSpec: '/s.json', requestId: '0b8d1c2e-aaaa-bbbb', cwd: '/' }
    expect(isHandoffRequest(ok)).toBe(true)
    expect(isHandoffRequest({ scripted: true })).toBe(false)
    expect(isHandoffRequest({ ...ok, requestId: '../../etc' })).toBe(false)
    expect(isHandoffRequest(null)).toBe(false)
  })

  it('awaitHandoffResult reads the answer, or gives up with null', async () => {
    const { awaitHandoffResult } = await handoff()
    const dir = mkdtempSync(join(tmpdir(), 'handoff-'))
    expect(awaitHandoffResult(join(dir, 'none.json'), 300, 50)).toBeNull()
    const path = join(dir, 'r.json')
    const r: HandoffResult = {
      requestId: 'r',
      ok: true,
      jobs: ['j1'],
      unsubmitted: [],
      settings: {}
    }
    writeFileSync(path, JSON.stringify(r))
    expect(awaitHandoffResult(path, 300, 50)).toEqual(r)
  })

  it('describeHandoff: exit 0 only when the whole campaign went in', async () => {
    const { describeHandoff } = await handoff()
    const base: HandoffResult = {
      requestId: 'r',
      ok: true,
      jobs: ['j1'],
      unsubmitted: [],
      settings: {}
    }
    expect(describeHandoff(base, '/ud').status).toBe(0)
    expect(describeHandoff({ ...base, ok: false, refused: 'x' }, '/ud')).toMatchObject({
      status: 1
    })
    expect(describeHandoff(null, '/ud').status).toBe(1)
    expect(describeHandoff(null, '/ud').text).toMatch(/did not answer/)
  })
})
