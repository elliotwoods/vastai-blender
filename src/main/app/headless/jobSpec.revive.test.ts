import { writeFileSync } from 'fs'
import { join, relative } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setup, type App, type World } from '../../test/harness'
import type { HeadlessResume } from './jobSpec'

// A resubmitted VR_JOB_SPEC campaign heals a half-done job instead of
// duplicating it, through the same revive as "Re-render missing" (plan
// 1.15, jobs/revive.ts).

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

/** The resume index.ts hands the drivers. */
function resumeAsIndexDoes(app: App): HeadlessResume {
  return {
    recovery: (jobIds) => app.scheduler.resumeRecoveryFor(jobIds),
    job: (jobId) => app.scheduler.resumeJob(jobId, { octaneSignIn: false })
  }
}

function specFor(blend: string): string {
  const path = join(w.dir, 'spec.json')
  writeFileSync(
    path,
    JSON.stringify({ blends: [blend], engine: 'cycles', frameStart: 1, frameEnd: 8 })
  )
  return path
}

describe('runJobSpec on a campaign already submitted', () => {
  it('1.15: queues only the frames a half-done job is missing, and submits no duplicate', async () => {
    const app = await w.boot({ start: false })
    const blend = w.blend()
    const jobId = await w.submitJob(app, {
      blendPath: blend,
      frameStart: 1,
      frameEnd: 8,
      chunkSize: 8
    })
    w.db
      .prepare(`UPDATE frames SET state = 'downloaded' WHERE job_id = ? AND frame <= 5`)
      .run(jobId)
    w.db.prepare(`UPDATE chunks SET state = 'failed', retries = 4 WHERE job_id = ?`).run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    const { runJobSpecFile } = await import('./jobSpec')
    const unsubmitted: string[] = []
    const kick = vi.fn()
    await runJobSpecFile(specFor(blend), { kick, unsubmitted })

    expect(w.all('SELECT id FROM jobs')).toEqual([{ id: jobId }])
    expect(
      w.all('SELECT frame_start, frame_end, state, retries FROM chunks WHERE job_id = ?', jobId)
    ).toEqual([{ frame_start: 6, frame_end: 8, state: 'pending', retries: 0 }])
    expect(unsubmitted).toEqual([])
    expect(kick).toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('3 missing frame(s) queued again in 1 chunk(s)')
    )
  })

  it('a job it cannot revive is named as a part of the campaign not submitted', async () => {
    // A row missingRanges refuses (an inverted range). The revive used to be
    // one UPDATE that could not fail; now it narrows, and a refusal must not
    // end the driver before the rest of the campaign is submitted.
    const app = await w.boot({ start: false })
    const blend = w.blend()
    const jobId = await w.submitJob(app, {
      blendPath: blend,
      frameStart: 1,
      frameEnd: 8,
      chunkSize: 8
    })
    w.db
      .prepare(
        `UPDATE chunks SET state = 'failed', frame_start = 8, frame_end = 5 WHERE job_id = ?`
      )
      .run(jobId)
    w.db.prepare(`UPDATE jobs SET state = 'partial' WHERE id = ?`).run(jobId)

    const { runJobSpecFile } = await import('./jobSpec')
    const unsubmitted: string[] = []
    const kick = vi.fn()
    await runJobSpecFile(specFor(blend), { kick, unsubmitted })

    expect(unsubmitted).toEqual([
      `${blend}: revive failed: frame range ends before it starts (8–5)`
    ])
    expect(kick).toHaveBeenCalled()
  })

  it("1.9 / 1.17: a campaign resubmitted lifts the launch's recovery hold, and a breaker's hold on a job it names", async () => {
    // A headless run has nobody to click Resume. A re-run on a profile with
    // unfinished work held scale-up for good (every launch with work holds
    // since plan 1.9), and a job the breaker held waited for good (s1 and
    // s2 reviews).
    w.settings.maxActiveNodes = 4
    const app = await w.boot({ start: false })
    const blend = w.blend()
    const jobId = await w.submitJob(app, { blendPath: blend, frameStart: 1, frameEnd: 8 })
    w.db.prepare('UPDATE jobs SET attention = ? WHERE id = ?').run(
      JSON.stringify({
        kind: 'repeatedFailure',
        message: 'the same failure on 2 nodes',
        since: 1
      }),
      jobId
    )
    app.nodeManager.init()
    app.scheduler.start()
    expect(app.scheduler.recoveryHoldCount()).not.toBeNull()

    const { runJobSpecFile } = await import('./jobSpec')
    await runJobSpecFile(specFor(blend), {
      kick: vi.fn(),
      unsubmitted: [],
      resume: resumeAsIndexDoes(app)
    })

    expect(app.scheduler.recoveryHoldCount()).toBeNull()
    expect(w.get('SELECT attention FROM jobs WHERE id = ?', jobId)).toEqual({ attention: null })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('its hold released'))
  })

  it('integration review: a campaign lifts the recovery hold for its own jobs only: other unfinished work is neither sent nor rented for, nor waited on', async () => {
    // resumeRecovery lifted it for every unfinished job on the profile, so
    // each headless re-run rented again for older work nobody had confirmed.
    w.settings.maxActiveNodes = 4
    w.settings.spendCapPerHour = 10
    const app = await w.boot({ start: false })
    const earlier = await w.submitJob(app, {
      blendPath: w.blend('earlier.blend'),
      frameStart: 1,
      frameEnd: 4
    })
    app.nodeManager.init()
    app.scheduler.start()
    const held = app.scheduler.recoveryHoldCount()
    expect(held).not.toBeNull()
    for (let i = 0; i < 4; i++) w.vast.addOffer()

    const { runJobSpecFile } = await import('./jobSpec')
    const campaign: string[] = []
    await runJobSpecFile(specFor(w.blend('campaign.blend')), {
      kick: () => app.scheduler.kick(),
      unsubmitted: [],
      campaign,
      resume: resumeAsIndexDoes(app)
    })
    const [{ id: submitted }] = w.all<{ id: string }>('SELECT id FROM jobs WHERE id != ?', earlier)

    const campaignDone = (): boolean => {
      for (const id of w.vast.created) {
        const machine = w.vast.machine(id)
        if (!machine.onSpec) machine.agent.autoFinish()
      }
      return (
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', submitted)?.state ===
        'complete'
      )
    }
    await w.until(campaignDone, 'the campaign rendered', { timeoutMs: 20 * 60_000, stepMs: 5_000 })
    await w.advance(2 * 60_000, 5_000)

    // The earlier job is still held, and none of it went out.
    expect(app.scheduler.recoveryHoldCount()).toBe(held)
    expect(
      w.eventsOf('chunk:changed').filter((c) => c.jobId === earlier && c.state === 'assigned')
    ).toEqual([])
    // The run waits on its own job only: done, with the earlier one open.
    expect(campaign).toEqual([submitted])
    const { openJobs } = await import('./drivers')
    expect(openJobs(campaign)).toBe(0)
    expect(openJobs()).toBe(1)
  })

  it('1.14: a scene named relative to the run is made full; a network path is not submitted', async () => {
    const app = await w.boot({ start: false })
    const blend = w.blend('a.blend')
    const legacy = w.blend('legacy.blend')
    // A job an earlier run made from a relative name keeps that name.
    const legacyId = await w.submitJob(app, { blendPath: legacy, frameStart: 1, frameEnd: 8 })
    w.db
      .prepare('UPDATE jobs SET blend_path = ? WHERE id = ?')
      .run(relative(process.cwd(), legacy), legacyId)
    const path = join(w.dir, 'spec.json')
    writeFileSync(
      path,
      JSON.stringify({
        blends: [
          relative(process.cwd(), blend),
          relative(process.cwd(), legacy),
          '\\\\fileserver\\scenes\\hero.blend'
        ],
        engine: 'cycles',
        frameStart: 1,
        frameEnd: 8
      })
    )

    const { runJobSpecFile } = await import('./jobSpec')
    const unsubmitted: string[] = []
    await runJobSpecFile(path, { kick: vi.fn(), unsubmitted })

    const jobs = w.all<{ blend_path: string }>('SELECT blend_path FROM jobs ORDER BY submitted_at')
    expect(jobs.map((j) => j.blend_path)).toEqual([relative(process.cwd(), legacy), blend])
    expect(unsubmitted).toHaveLength(1)
    expect(unsubmitted[0]).toMatch(/fileserver.*on this computer/)
  })
})

describe('runJobSpec on an inline spec (B6)', () => {
  it('names each job: a blend entry its own, else the spec name leads the file name', async () => {
    await w.boot({ start: false })
    const { runJobSpec } = await import('./jobSpec')
    const unsubmitted: string[] = []
    const campaign: string[] = []
    await runJobSpec(
      {
        name: 'hero pass',
        blends: [w.blend('a.blend'), { path: w.blend('b.blend'), name: 'the B side' }],
        engine: 'cycles',
        frameStart: 1,
        frameEnd: 4
      },
      { kick: vi.fn(), unsubmitted, campaign }
    )
    expect(unsubmitted).toEqual([])
    const names = campaign.map(
      (id) => w.get<{ name: string }>('SELECT name FROM jobs WHERE id = ?', id)?.name
    )
    expect(names).toEqual(['hero pass · a', 'the B side'])
  })

  it("dedupe 'never' submits a scene again; the default heals the open job instead", async () => {
    await w.boot({ start: false })
    const { runJobSpec } = await import('./jobSpec')
    const blend = w.blend()
    const spec = { blends: [blend], engine: 'cycles', frameStart: 1, frameEnd: 4 }
    const first: string[] = []
    await runJobSpec(spec, { kick: vi.fn(), unsubmitted: [], campaign: first })
    const again: string[] = []
    await runJobSpec(spec, { kick: vi.fn(), unsubmitted: [], campaign: again })
    expect(again).toEqual(first)
    const fresh: string[] = []
    await runJobSpec(
      { ...spec, dedupe: 'never' },
      { kick: vi.fn(), unsubmitted: [], campaign: fresh }
    )
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).not.toBe(first[0])
    expect(w.all('SELECT id FROM jobs')).toHaveLength(2)
  })

  it('a bad name or dedupe refuses the whole spec before anything is submitted', async () => {
    await w.boot({ start: false })
    const { runJobSpec } = await import('./jobSpec')
    const kick = vi.fn()
    await expect(
      runJobSpec({ blends: [w.blend()], dedupe: 'sometimes' }, { kick, unsubmitted: [] })
    ).rejects.toThrow(/dedupe must be one of campaign, never/)
    await expect(
      runJobSpec({ blends: [{ path: w.blend(), name: '' }] }, { kick, unsubmitted: [] })
    ).rejects.toThrow(/blends\[0\]\.name/)
    expect(w.all('SELECT id FROM jobs')).toEqual([])
    expect(kick).not.toHaveBeenCalled()
  })

  it("trackCampaignSettings releases the campaign's settings once its jobs are done", async () => {
    await w.boot({ start: false })
    const { trackCampaignSettings } = await import('./jobSpec')
    const { SettingsOverlay } = await import('../settingsOverlay')
    const overlay = new SettingsOverlay()
    overlay.set({ maxActiveNodes: 3 })
    let open = 1
    trackCampaignSettings(
      ['job-x'],
      { maxActiveNodes: 3 },
      { openJobs: () => open, overlay, pollMs: 1_000 }
    )
    await w.advance(3_000)
    expect(overlay.fields()).toEqual({ maxActiveNodes: 3 })
    open = 0
    await w.advance(2_000)
    expect(overlay.fields()).toEqual({})
  })
})
