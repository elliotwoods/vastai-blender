/**
 * Headless batch driver: VR_JOB_SPEC=<path to .json> submits a whole
 * campaign at boot. It generalises VR_E2E_BLEND (pinned to one blend,
 * Cycles, frames 1-20, no addons, e2e.ts), so a scripted run can set the
 * engine, frame range, addon zips and fleet size. Moved here from index.ts
 * (plan 2.1's composition root); its behaviour is unchanged but for the
 * settings (below). Spec shape:
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
 *
 * The spec's settings are this run's alone (plan 1.14). They used to go
 * through updateSettings, which saved them: two sessions of spec runs left
 * Elliot's own settings.json rewritten for good, and the next time he opened
 * the app it rented with a campaign's fleet size and filters. They now go
 * through the same sanitizer as the Settings screen's and into the session
 * overlay (app/settingsOverlay.ts), and settings.json is never written.
 *
 * All of them are in force, or the campaign is not submitted. A setting the
 * sanitizer refuses, or one getSettings() does not then hand out (a build
 * whose settings.ts does not lay the overlay), would leave the campaign
 * renting at the saved settings instead: a smoke test asking for 1 node at
 * $2/hr could rent 30 and buy ahead to $50/hr on a profile saved that way.
 * So applySpecSettings throws SpecSettingsRefused, before anything is
 * submitted or kicked, and the run ends (drivers.ts, Lifecycle.endCampaign).
 * A value clamped to its limit is in force at the limit, said on stderr.
 */

import { join, resolve } from 'path'
import type { SettingsFieldError, SettingsPublic } from '../../../shared/models'
import { sanitizeSettingsPatch } from '../../../shared/settingsSanitize'
import { hostPathFlavour } from '../../paths'
import { acceptedFields } from '../settingsGate'
import { sessionOverlay, type OverlayFields, type SettingsOverlay } from '../settingsOverlay'

export interface JobSpecDeps {
  /** Start the scheduler on what was submitted. */
  kick(): void
  /** Each part of the campaign that was not submitted, and why; the exit status reads it. */
  unsubmitted: string[]
  /** Defaults to this process's. */
  overlay?: SettingsOverlay
  /**
   * The scheduler's holds a campaign submitted is the user's say-so to lift
   * (index.ts passes the scheduler's): the recovery hold on a launch with
   * unfinished work (plan 1.9), for the campaign's own jobs only, and a
   * breaker's hold on a job the campaign names again (plan 1.17). A headless
   * run has nobody to click Resume, so without these a re-run on a profile
   * with unfinished jobs rented nothing new, and a held job waited for good.
   * Other unfinished work on the profile stays held: the campaign did not
   * name it (integration review).
   */
  resume?: HeadlessResume
  /**
   * Filled with the campaign's jobs, each blend's: the one submitted, or the
   * open one it names again. What a headless run waits on (drivers.ts).
   */
  campaign?: string[]
  /**
   * Where relative paths in the spec (blends, blendDir, addonZips) are from:
   * the directory the run was started in. A spec handed to a running app
   * (handoff.ts) passes the launching process's; defaults to this process's.
   */
  cwd?: string
  /**
   * 'session' (a headless run's own app, the default): the spec's settings go
   * in force for the session (applySpecSettings). 'handoff' (a spec handed to
   * an app already running, handoff.ts): the same when the app has no other
   * open work, else they must already be in force (applyHandoffSettings).
   */
  settingsMode?: 'session' | 'handoff'
  /** Open jobs on the app now (drivers.openJobs); read by 'handoff'. */
  openWork?: () => number
  /** Filled with the fields this spec put in the overlay, for the caller to release later. */
  applied?: OverlayFields
}

/** What a headless campaign may lift (JobSpecDeps.resume). */
export interface HeadlessResume {
  /** The recovery hold, for these jobs only (scheduler.resumeRecoveryFor). */
  recovery(jobIds: readonly string[]): void
  /** A breaker's hold on this job, never a missed Octane sign-in's (scheduler.resumeJob). */
  job(jobId: string): boolean
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
  // the stored filters, filter by filter.
  if (spec.offerFilters) patch.offerFilters = spec.offerFilters
  return patch
}

/** A field of the overlay that getSettings() does not hand out as set, with what it hands out. */
interface NotInForce {
  field: string
  asked: unknown
  inForce: unknown
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Fields of `fields` that `settings` does not carry as set. */
function notInForce(fields: OverlayFields, settings: SettingsPublic): NotInForce[] {
  const out: NotInForce[] = []
  const now = settings as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'offerFilters') {
      const filters = (settings.offerFilters ?? {}) as unknown as Record<string, unknown>
      for (const [f, v] of Object.entries(value as Record<string, unknown>)) {
        if (!sameValue(filters[f], v)) {
          out.push({ field: `offerFilters.${f}`, asked: v, inForce: filters[f] })
        }
      }
    } else if (!sameValue(now[key], value)) {
      out.push({ field: key, asked: value, inForce: now[key] })
    }
  }
  return out
}

/**
 * A spec's settings that cannot all be put in force for its run: the
 * campaign is refused whole, before any of it is submitted (see the header).
 * `problems` names each setting and what is wrong with it; `why`, when
 * given, is what they have in common.
 */
export class SpecSettingsRefused extends Error {
  override readonly name = 'SpecSettingsRefused'

  constructor(
    readonly problems: readonly string[],
    why?: string
  ) {
    super(
      "the spec's settings cannot all be put in force for this run, so none of it was " +
        `submitted: ${problems.join('; ')}${why ? ` (${why})` : ''}`
    )
  }
}

/**
 * Put the spec's settings in force for this session: checked by the
 * sanitizer against what is in force now, then laid over it in the
 * overlay. Nothing is saved. Says on stderr what the sanitizer clamped.
 * Throws SpecSettingsRefused, leaving none of the spec's settings in the
 * overlay, when the sanitizer refuses one or getSettings() does not then
 * hand out each as set: a campaign never runs at settings other than it
 * asked for. Returns the fields put in force.
 */
export function applySpecSettings(
  spec: Record<string, unknown>,
  getSettings: () => SettingsPublic,
  overlay: SettingsOverlay = sessionOverlay
): OverlayFields {
  const asked = specSettingsPatch(spec)
  if (Object.keys(asked).length === 0) return {}
  const result = sanitizeSettingsPatch(asked, getSettings(), { pathFlavour: hostPathFlavour() })
  for (const e of result.errors) console.error(`[spec] setting ${describeOutcome(e)}`)
  const refused = result.errors.filter((e) => e.outcome === 'rejected')
  if (refused.length) {
    throw new SpecSettingsRefused(refused.map((e) => `${e.field}: ${e.message}`))
  }
  const fields = acceptedFields(asked, result)
  overlay.set(fields)
  const missing = notInForce(fields, getSettings())
  if (missing.length) {
    // Taken back out: nothing of a refused campaign stays in force.
    overlay.release(fields)
    throw new SpecSettingsRefused(
      missing.map(
        (m) =>
          `${m.field} is ${m.inForce === undefined ? 'unset' : JSON.stringify(m.inForce)}, ` +
          `not the ${JSON.stringify(m.asked)} the spec asked for`
      ),
      "this build's settings.ts does not apply settings for one run only"
    )
  }
  console.log(
    `[spec] settings for this run only (settings.json is left as it is) ${JSON.stringify(fields)}`
  )
  return fields
}

/**
 * A spec handed to an app already running (handoff.ts). Its fleet settings are
 * that app's for everything it renders: with other work open there (another
 * campaign, or a person's jobs), putting them in force would change that
 * work's fleet caps and filters behind its back. So with no other open work
 * they go in force as for a headless run (applySpecSettings) and the caller
 * releases them when the campaign is done; with open work, each must already
 * be in force (as sanitized), else SpecSettingsRefused and nothing is
 * submitted. A spec without fleet settings just adds its jobs.
 */
export function applyHandoffSettings(
  spec: Record<string, unknown>,
  getSettings: () => SettingsPublic,
  openWork: () => number,
  overlay: SettingsOverlay = sessionOverlay
): OverlayFields {
  const asked = specSettingsPatch(spec)
  if (Object.keys(asked).length === 0) return {}
  const open = openWork()
  if (open === 0) return applySpecSettings(spec, getSettings, overlay)
  const now = getSettings()
  const result = sanitizeSettingsPatch(asked, now, { pathFlavour: hostPathFlavour() })
  const refused = result.errors.filter((e) => e.outcome === 'rejected')
  if (refused.length) {
    throw new SpecSettingsRefused(refused.map((e) => `${e.field}: ${e.message}`))
  }
  // An unset flag is false (e.g. noSpendCap, which the sanitizer adds beside a cap): not a change.
  const differ = notInForce(acceptedFields(asked, result), now).filter(
    (m) => !(m.inForce === undefined && m.asked === false)
  )
  if (differ.length) {
    throw new SpecSettingsRefused(
      differ.map(
        (m) =>
          `${m.field}: asks ${JSON.stringify(m.asked)}, the running app has ` +
          `${m.inForce === undefined ? 'it unset' : JSON.stringify(m.inForce)}`
      ),
      `the running app has ${open} open job(s) at its own settings; submit without fleet ` +
        'settings (or with the ones in force), or when its work is done'
    )
  }
  console.log('[spec] settings already in force on the running app; nothing changed')
  return {}
}

function describeOutcome(e: SettingsFieldError): string {
  return `${e.outcome === 'clamped' ? 'clamped' : 'refused'}: ${e.message}`
}

/**
 * Submit the campaign at `specPath`. Throws when the spec cannot be read or
 * parsed, and SpecSettingsRefused when its settings cannot all be put in
 * force, in each case before anything is submitted or kicked. Each blend
 * createJob refuses is collected in `deps.unsubmitted` instead, so one bad
 * blend does not cost the rest of the campaign.
 */
export async function runJobSpec(specPath: string, deps: JobSpecDeps): Promise<void> {
  const campaign = deps.campaign ?? []
  const { readFileSync, readdirSync } = await import('fs')
  const { createJob, listJobs } = await import('../../jobs/jobs')
  const { reviveFailedChunks } = await import('../../jobs/revive')
  const { registerAddon } = await import('../../addons/addons')
  const { getSettings } = await import('../../settings')

  const spec = JSON.parse(readFileSync(specPath, 'utf-8'))

  const base = deps.cwd ?? process.cwd()
  const applied =
    deps.settingsMode === 'handoff'
      ? applyHandoffSettings(spec, getSettings, deps.openWork ?? (() => 0), deps.overlay)
      : applySpecSettings(spec, getSettings, deps.overlay)
  if (deps.applied) Object.assign(deps.applied, applied)

  // Register each zip fresh: the registry keys on the manifest id and re-hashes the
  // file, so re-running after an extension rebuild replaces the stale entry even
  // when the version string is unchanged.
  const addonIds: string[] = []
  for (const zip of spec.addonZips ?? []) {
    const info = registerAddon(resolve(base, zip))
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
    const dir = resolve(base, spec.blendDir)
    blends = readdirSync(dir)
      .filter((f: string) => f.toLowerCase().endsWith('.blend'))
      .sort()
      .map((f: string): BlendEntry => ({ path: join(dir, f) }))
  }
  // A spec may name its scenes relative to where the run was started, as it
  // always could. A job's scene must be a full path now (validateSubmission),
  // so each is made full from there; a network path is left as it is, for
  // createJob to refuse. `named` keeps the spec's own spelling, which is what
  // a job an earlier run made from a relative name has as its blendPath.
  const named = new Map<BlendEntry, string>()
  blends = blends.map((b) => {
    if (typeof b.path !== 'string' || b.path === '' || /^[\\/]{2}/.test(b.path)) return b
    const full = { ...b, path: resolve(base, b.path) }
    named.set(full, b.path)
    return full
  })
  const isBlend = (j: { blendPath: string }, b: BlendEntry): boolean =>
    j.blendPath === b.path || j.blendPath === named.get(b)
  if (!blends.length) {
    console.error('[spec] no blends resolved — nothing submitted')
    deps.unsubmitted.push(`${specPath}: no blends resolved`)
    return
  }

  // 'partial' included: resubmitting a spec HEALS a half-done job
  // (its missing frames queued again below) instead of duplicating it.
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
        isBlend(j, blend) &&
        j.frameStart === wantStart &&
        j.frameEnd === wantEnd
    )
    if (satisfied) {
      console.log(`[spec] skip (already complete): ${blend.path}`)
      continue
    }
    const existing = active.find((j) => isBlend(j, blend))
    if (existing) {
      campaign.push(existing.id)
      // Revive permanently-failed chunks (retry budget exhausted, e.g.
      // by a since-fixed dispatch bug), narrowed to the frames still
      // missing, so the scheduler re-runs only the missing work
      // (jobs/revive.ts). A job whose rows it cannot narrow is part of the
      // campaign that will not finish, and the exit status says so.
      try {
        const revived = reviveFailedChunks(existing.id)
        const released = deps.resume?.job(existing.id) === true
        console.log(
          `[spec] skip (already active): ${blend.path}` +
            (revived.frames
              ? ` — ${revived.frames} missing frame(s) queued again in ${revived.chunks} chunk(s)`
              : '') +
            (released ? ' — its hold released' : '')
        )
      } catch (e) {
        console.error(
          `[spec] could not revive ${existing.id} (${(e as Error).message}): ${blend.path}`
        )
        deps.unsubmitted.push(`${blend.path}: revive failed: ${(e as Error).message}`)
      }
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
    campaign.push(jobId)
    console.log(`[spec] job ${created}/${blends.length} ${jobId} ${blend.path}`)
  }
  console.log(`[spec] submitted ${created} job(s)`)
  deps.resume?.recovery(campaign)
  deps.kick()
}
