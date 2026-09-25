/**
 * Headless batch driver: VR_JOB_SPEC=<path to .json> submits a whole
 * campaign at boot. It generalises VR_E2E_BLEND (pinned to one blend,
 * Cycles, frames 1-20, no addons, e2e.ts), so a scripted run can set the
 * engine, frame range, addon zips and fleet size. Moved here from index.ts
 * (plan 2.1's composition root), unchanged. Spec shape:
 *   {
 *     "blends": ["C:/.../suzanne.blend", ...]  // or "blendDir": "C:/.../blends/<cfg>"
 *     "engine": "eevee", "frameStart": 1, "frameEnd": 200, "frameStep": 1,
 *     "addonZips": ["C:/.../auroravision-0.2.0.zip"],
 *     "chunkSize": null, "maxActiveNodes": 4, "spendCapPerHour": 2,
 *     "shareNode": true,      // jobs may co-run on one node (per-blend override too)
 *     "maxNodeSlots": 0,      // 0 = let the app judge concurrency per node
 *     "slotsPerGpu": 1,       // renders per GPU on a node (0 = one process, all GPUs)
 *     "eagerFleet": true,     // buy ahead: rent to maxActiveNodes while any chunk is open
 *     "offerFilters": { "minNumGpus": 4 }  // partial override of the stored filters
 *   }
 */

import { join } from 'path'

export interface JobSpecDeps {
  /** Start the scheduler on what was submitted. */
  kick(): void
  /** Each part of the campaign that was not submitted, and why; the exit status reads it. */
  unsubmitted: string[]
}

/**
 * The settings a spec asks for, spelled as settings are. Exactly the fields
 * and the conditions the driver has always read: a zero fleet size or cap is
 * no request, and `nodeSlots` is the pre-2.1 name for `maxNodeSlots`.
 */
export function specSettingsPatch(spec: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (spec.maxActiveNodes) patch.maxActiveNodes = spec.maxActiveNodes
  if (spec.spendCapPerHour) patch.spendCapPerHour = spec.spendCapPerHour
  // Cap on the auto-judged render slots per node; 0/absent = auto.
  const slotCap = spec.maxNodeSlots ?? spec.nodeSlots
  if (slotCap != null) patch.maxNodeSlots = slotCap
  // Buy-ahead fleet: rent to maxActiveNodes while any chunk is open.
  if (spec.eagerFleet != null) patch.eagerFleet = spec.eagerFleet
  // Render slots per GPU on multi-GPU nodes (0 = one process on all GPUs).
  if (spec.slotsPerGpu != null) patch.slotsPerGpu = spec.slotsPerGpu
  // Partial offer-filter overrides (e.g. {"cpuBound": true}) merge over
  // the stored filters via updateSettings' offerFilters merge.
  if (spec.offerFilters) patch.offerFilters = spec.offerFilters
  return patch
}

/**
 * Submit the campaign at `specPath`. Throws when the spec cannot be read or
 * parsed; each blend createJob refuses is collected in `deps.unsubmitted`
 * instead, so one bad blend does not cost the rest of the campaign.
 */
export async function runJobSpec(specPath: string, deps: JobSpecDeps): Promise<void> {
  const { readFileSync, readdirSync } = await import('fs')
  const { createJob, listJobs } = await import('../../jobs/jobs')
  const { reviveFailedChunks } = await import('../../jobs/revive')
  const { registerAddon } = await import('../../addons/addons')
  const { updateSettings } = await import('../../settings')

  const spec = JSON.parse(readFileSync(specPath, 'utf-8'))

  const patch = specSettingsPatch(spec)
  if (Object.keys(patch).length) {
    updateSettings(patch)
    console.log(`[spec] settings ${JSON.stringify(patch)}`)
  }

  // Register each zip fresh: the registry keys on the manifest id and re-hashes the
  // file, so re-running after an extension rebuild replaces the stale entry even
  // when the version string is unchanged.
  const addonIds: string[] = []
  for (const zip of spec.addonZips ?? []) {
    const info = registerAddon(zip)
    addonIds.push(info.id)
    console.log(`[spec] addon ${info.id} v${info.version} ${info.zipHash.slice(0, 12)}`)
  }

  // Blend list entries are either plain paths or objects with per-blend
  // frame overrides: {"path": "...", "frameStart": 1, "frameEnd": 120}.
  // Needed for mixed-length submissions (e.g. experiment scenes with
  // different animation lengths in one campaign spec).
  interface BlendEntry {
    path: string
    frameStart?: number
    frameEnd?: number
    frameStep?: number
    /** may co-run with other chunks on one node; falls back to spec.shareNode */
    shareNode?: boolean
  }
  let blends: BlendEntry[] = (spec.blends ?? []).map((b: string | BlendEntry): BlendEntry =>
    typeof b === 'string' ? { path: b } : b
  )
  if (!blends.length && spec.blendDir) {
    blends = readdirSync(spec.blendDir)
      .filter((f: string) => f.toLowerCase().endsWith('.blend'))
      .sort()
      .map((f: string): BlendEntry => ({ path: join(spec.blendDir, f) }))
  }
  if (!blends.length) {
    console.error('[spec] no blends resolved — nothing submitted')
    deps.unsubmitted.push(`${specPath}: no blends resolved`)
    return
  }

  // 'partial' included: resubmitting a spec HEALS a half-done job
  // (failed chunks revived below) instead of duplicating it.
  const allJobs = listJobs()
  const active = allJobs.filter((j) => ['queued', 'running', 'partial'].includes(j.state))
  let created = 0
  for (const blend of blends) {
    // Satisfied: a prior job for the same blend AND the same frame
    // range already completed — re-running the spec must not re-render
    // finished work. (Observed: complete jobs were re-created on every
    // respec because dedup only looked at ACTIVE jobs.)
    const wantStart = blend.frameStart ?? spec.frameStart ?? 1
    const wantEnd = blend.frameEnd ?? spec.frameEnd ?? 200
    const satisfied = allJobs.find(
      (j) =>
        j.state === 'complete' &&
        j.blendPath === blend.path &&
        j.frameStart === wantStart &&
        j.frameEnd === wantEnd
    )
    if (satisfied) {
      console.log(`[spec] skip (already complete): ${blend.path}`)
      continue
    }
    const existing = active.find((j) => j.blendPath === blend.path)
    if (existing) {
      // Revive permanently-failed chunks (retry budget exhausted, e.g.
      // by a since-fixed dispatch bug) so the scheduler re-runs only
      // the missing work (jobs/revive.ts).
      const revived = reviveFailedChunks(existing.id)
      console.log(
        `[spec] skip (already active): ${blend.path}` +
          (revived ? ` — revived ${revived} failed chunk(s)` : '')
      )
      continue
    }
    // One blend createJob refuses (missing file, impossible range) must
    // not cost the rest of the campaign its submission — or skip the
    // kick() below that starts it.
    let jobId: string
    try {
      jobId = await createJob({
        blendPath: blend.path,
        engine: spec.engine ?? 'eevee',
        frameStart: blend.frameStart ?? spec.frameStart ?? 1,
        frameEnd: blend.frameEnd ?? spec.frameEnd ?? 200,
        frameStep: blend.frameStep ?? spec.frameStep ?? 1,
        addonIds,
        chunkSize: spec.chunkSize ?? null,
        shareNode: blend.shareNode ?? spec.shareNode ?? false
      })
    } catch (e) {
      console.error(`[spec] skip (${(e as Error).message}): ${blend.path}`)
      deps.unsubmitted.push(`${blend.path}: ${(e as Error).message}`)
      continue
    }
    created++
    console.log(`[spec] job ${created}/${blends.length} ${jobId} ${blend.path}`)
  }
  console.log(`[spec] submitted ${created} job(s)`)
  deps.kick()
}
