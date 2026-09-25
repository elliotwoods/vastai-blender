/**
 * Headless E2E driver: VR_E2E_BLEND=<path> submits a small Cycles job at
 * boot; the scheduler then scales up, renders, downloads, and idles down.
 * Moved here from index.ts (plan 2.1's composition root).
 */

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
  // Guard against duplicate submissions across main-process restarts.
  const existing = listJobs().find(
    (j) => j.blendPath === blendPath && ['queued', 'running'].includes(j.state)
  )
  let jobId: string
  if (existing) {
    jobId = existing.id
    console.log(`[e2e] active job already exists: ${jobId}`)
    deps.resume?.job(jobId)
  } else {
    jobId = await createJob({
      blendPath,
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
