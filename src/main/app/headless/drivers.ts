/**
 * The headless drivers, started from index.ts once the app is up: a
 * VR_JOB_SPEC campaign (jobSpec.ts) and a VR_E2E_BLEND job (e2e.ts). Moved
 * out of the composition root (plan 2.1; findings #10 #165).
 *
 * Both drivers stop by the quit policy, VR_QUIT_POLICY (app/lifecycle.ts),
 * never by a dialog. `destroy`, the default: SIGINT, SIGTERM, SIGHUP, a
 * quit or a Windows session end destroys every node and exits, and so does
 * the campaign being done (no job queued or running). A signal during that
 * destroy does not cut it short: a SIGHUP never does (a closed terminal
 * sends two), and only a second Ctrl+C, or a second SIGTERM, 2 s or more
 * after the first of its kind, exits without waiting. `leave`: those exit and leave the nodes as
 * they are, and a finished campaign keeps running for the idle
 * scale-down. The exit status is 3 when instances may be left billing,
 * else 1 when part of the campaign was never submitted (each such part is
 * collected in `unsubmitted`), else 0.
 *
 * A spec whose settings cannot all be put in force for the run
 * (SpecSettingsRefused, jobSpec.ts) submits nothing, and the run ends at
 * once, by either policy (Lifecycle.endCampaign), rather than wait out jobs
 * an earlier run left open at the saved settings.
 */

import { getDb } from '../../db/db'
import type { Lifecycle } from '../lifecycle'
import { runE2e } from './e2e'
import { SpecSettingsRefused, runJobSpec } from './jobSpec'

/** How long after boot a driver submits: the scheduler and node manager are started by then. */
export const SUBMIT_DELAY_MS = 3_000

export interface HeadlessDriverOptions {
  /** VR_JOB_SPEC */
  jobSpecPath?: string
  /** VR_E2E_BLEND */
  e2eBlend?: string
  lifecycle: Pick<Lifecycle, 'watchCampaign' | 'endCampaign'>
  /** scheduler.kick */
  kick(): void
  /** The scheduler's resumeRecovery and resumeJob, for a campaign submitted (jobSpec.ts). */
  resume?: { recovery(): void; job(jobId: string): boolean }
}

/** Jobs a headless campaign still waits on. */
export function openJobs(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running')")
    .get() as { n: number }
  return row.n
}

/** Start whichever drivers the environment asked for. A no-op for the app a person runs. */
export function startHeadlessDrivers(opts: HeadlessDriverOptions): void {
  const { jobSpecPath, e2eBlend, lifecycle, kick, resume } = opts
  if (jobSpecPath) {
    const unsubmitted: string[] = []
    let refused = false
    setTimeout(() => {
      void runJobSpec(jobSpecPath, { kick, unsubmitted, resume })
        .catch((e) => {
          refused = e instanceof SpecSettingsRefused
          if (refused) console.error(`[spec] ${(e as Error).message}`)
          else console.error('[spec] submission failed:', e)
          unsubmitted.push(`${jobSpecPath}: ${(e as Error)?.message ?? e}`)
        })
        .finally(() =>
          refused
            ? lifecycle.endCampaign(unsubmitted)
            : lifecycle.watchCampaign(openJobs, unsubmitted)
        )
    }, SUBMIT_DELAY_MS)
  }

  if (e2eBlend) {
    const unsubmitted: string[] = []
    setTimeout(() => {
      void runE2e(e2eBlend, { kick })
        .catch((e) => {
          console.error('[e2e] job creation failed:', e)
          unsubmitted.push(`${e2eBlend}: ${(e as Error)?.message ?? e}`)
        })
        .finally(() => lifecycle.watchCampaign(openJobs, unsubmitted))
    }, SUBMIT_DELAY_MS)
  }
}
