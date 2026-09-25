/**
 * Headless E2E driver: VR_E2E_BLEND=<path> submits a small Cycles job at
 * boot; the scheduler then scales up, renders, downloads, and idles down.
 * Moved here from index.ts (plan 2.1's composition root).
 */

import { resolve } from 'path'
import type { HeadlessResume } from './jobSpec'

export interface E2eDeps {
  /** Start the scheduler on what was submitted. */
  kick(): void
  /** As a campaign's (jobSpec.ts): the E2E job's holds are lifted, and only its. */
  resume?: HeadlessResume
  /** Filled with the E2E job's id: what the run waits on. */
  campaign?: string[]
}

/** Submit the one E2E job for `blendPath`, unless one is already open. Throws when createJob refuses. */
export async function runE2e(blendPath: string, deps: E2eDeps): Promise<void> {
  const { createJob, listJobs } = await import('../../jobs/jobs')
  // Named relative to where the run was started, as it always could be. A
  // job's scene must be a full path (validateSubmission), so a relative
  // VR_E2E_BLEND submitted nothing and exited 1 (integration review). A
  // network path is left as it is, for createJob to refuse.
  const full = /^[\\/]{2}/.test(blendPath) ? blendPath : resolve(blendPath)
  // Guard against duplicate submissions across main-process restarts, under
  // either spelling: a job an earlier run made keeps the one it was given.
  const existing = listJobs().find(
    (j) =>
      (j.blendPath === full || j.blendPath === blendPath) && ['queued', 'running'].includes(j.state)
  )
  let jobId: string
  if (existing) {
    jobId = existing.id
    console.log(`[e2e] active job already exists: ${jobId}`)
    deps.resume?.job(jobId)
  } else {
    jobId = await createJob({
      blendPath: full,
      engine: 'cycles',
      frameStart: 1,
      frameEnd: 20,
      frameStep: 1,
      addonIds: [],
      chunkSize: null
    })
    console.log(`[e2e] job created: ${jobId}`)
  }
  deps.campaign?.push(jobId)
  deps.resume?.recovery([jobId])
  deps.kick()
}
