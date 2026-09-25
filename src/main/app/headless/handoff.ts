/**
 * VR_JOB_SPEC hand-off: a campaign launched while the app is already running
 * on the profile is submitted by that app, instead of being refused.
 *
 * One app per profile stands (index.ts's single-instance lock: a second main
 * process on the same SQLite state re-provisions live nodes and resets
 * in-flight chunks). So the second launch never boots. It passes the spec's
 * full path, its own working directory and a request id to the running app as
 * the lock's additionalData, and waits for the answer; the running app
 * (second-instance) submits the spec through runJobSpec and writes the answer
 * to <userData>/handoff/<requestId>.json. The launch prints it and exits 0 when
 * the whole campaign was submitted, else 1, as a headless run would.
 *
 * Settings: the running app's fleet is shared by everything it renders, so a
 * handed-off spec's fleet settings only go in force when the app has no other
 * open work, and are released again when the campaign is done; with other work
 * open they must already be in force, else nothing is submitted
 * (jobSpec.applyHandoffSettings). settings.json is never written.
 *
 * The running app's window, quit policy and lifecycle are its person's: a
 * hand-off neither shows the window nor ends the app when its campaign is done
 * (nodes then idle out as for any finished job).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { OverlayFields, SettingsOverlay } from '../settingsOverlay'
import { sessionOverlay } from '../settingsOverlay'
import { SpecSettingsRefused, runJobSpec, type HeadlessResume } from './jobSpec'

/** What a VR_JOB_SPEC launch refused by the lock passes to the running app. */
export interface HandoffRequest {
  scripted: true
  jobSpec: string
  requestId: string
  cwd: string
}

/** What the running app answers. */
export interface HandoffResult {
  requestId: string
  /** The whole campaign was submitted (or already complete / active). */
  ok: boolean
  /** The campaign's jobs: submitted, or open ones it named again. */
  jobs: string[]
  /** Each part not submitted, and why. */
  unsubmitted: string[]
  /** Why nothing was submitted, when the spec's settings were refused. */
  refused?: string
  /** The settings put in force for this campaign (released when it is done). */
  settings: OverlayFields
}

export function isHandoffRequest(data: unknown): data is HandoffRequest {
  const d = data as Partial<HandoffRequest> | null
  return (
    !!d &&
    d.scripted === true &&
    typeof d.jobSpec === 'string' &&
    typeof d.requestId === 'string' &&
    /^[A-Za-z0-9-]{8,64}$/.test(d.requestId) &&
    typeof d.cwd === 'string'
  )
}

export function handoffResultPath(userData: string, requestId: string): string {
  return join(userData, 'handoff', `${requestId}.json`)
}

export interface HandoffDeps {
  userData: string
  /** scheduler.kick */
  kick(): void
  resume?: HeadlessResume
  /** Open jobs: of `ids` when given, else all (drivers.openJobs). */
  openJobs(ids?: readonly string[]): number
  overlay?: SettingsOverlay
  /** How often to check whether the campaign is done, to release its settings. */
  pollMs?: number
}

/** Submit a handed-off spec in this (the running) app and write the answer for the launch. */
export async function acceptHandoff(
  req: HandoffRequest,
  deps: HandoffDeps
): Promise<HandoffResult> {
  const overlay = deps.overlay ?? sessionOverlay
  const unsubmitted: string[] = []
  const campaign: string[] = []
  const applied: OverlayFields = {}
  let refused: string | undefined
  console.log(`[handoff] spec ${req.jobSpec} (request ${req.requestId}, from ${req.cwd})`)
  try {
    await runJobSpec(req.jobSpec, {
      kick: deps.kick,
      unsubmitted,
      resume: deps.resume,
      campaign,
      cwd: req.cwd,
      settingsMode: 'handoff',
      openWork: () => deps.openJobs(),
      applied,
      overlay
    })
  } catch (e) {
    if (e instanceof SpecSettingsRefused) refused = e.message
    else unsubmitted.push(`${req.jobSpec}: ${(e as Error)?.message ?? e}`)
    console.error(`[handoff] ${refused ?? unsubmitted[unsubmitted.length - 1]}`)
  }
  const result: HandoffResult = {
    requestId: req.requestId,
    ok: !refused && unsubmitted.length === 0,
    jobs: campaign,
    unsubmitted,
    ...(refused ? { refused } : {}),
    settings: applied
  }
  writeResult(handoffResultPath(deps.userData, req.requestId), result)
  if (Object.keys(applied).length > 0) releaseWhenDone(campaign, applied, overlay, deps)
  return result
}

/** Written whole (tmp + rename): the waiting launch never reads half a file. */
function writeResult(path: string, result: HandoffResult): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(result, null, 1))
  renameSync(tmp, path)
}

/** The campaign's settings were the app's for its sake only: give them back when it is done. */
function releaseWhenDone(
  campaign: readonly string[],
  applied: OverlayFields,
  overlay: SettingsOverlay,
  deps: HandoffDeps
): void {
  const timer = setInterval(() => {
    let open: number
    try {
      open = deps.openJobs(campaign)
    } catch {
      return
    }
    if (open > 0) return
    clearInterval(timer)
    const released = overlay.release(applied)
    console.log(`[handoff] campaign done; its settings released: ${released.join(', ') || 'none'}`)
  }, deps.pollMs ?? 30_000)
  timer.unref?.()
}

/**
 * In the refused launch: wait for the running app's answer. Synchronous (the
 * launch has nothing else to do and must not boot). null when none came in
 * time, e.g. the running app predates hand-off and only logged a refusal.
 */
export function awaitHandoffResult(
  path: string,
  timeoutMs: number,
  stepMs = 250
): HandoffResult | null {
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as HandoffResult
    } catch {
      // not there (yet)
    }
    if (Date.now() >= end) return null
    Atomics.wait(sleeper, 0, 0, stepMs)
  }
}

/** The lines the refused launch prints, and its exit status. */
export function describeHandoff(
  result: HandoffResult | null,
  userData: string
): { text: string; status: number } {
  if (!result) {
    return {
      text:
        `[vast-render] handed the spec to the app already running on ${userData}, but it did not ` +
        'answer (a build without spec hand-off?); nothing is known to be submitted.\n',
      status: 1
    }
  }
  const lines = [
    `[vast-render] spec handed to the app already running on ${userData}: ` +
      (result.refused
        ? 'nothing submitted.'
        : `${result.jobs.length} job(s): ${result.jobs.join(', ') || 'none'}.`)
  ]
  if (result.refused) lines.push(`  refused: ${result.refused}`)
  for (const u of result.unsubmitted) lines.push(`  not submitted: ${u}`)
  if (Object.keys(result.settings).length) {
    lines.push(`  settings for this campaign only: ${JSON.stringify(result.settings)}`)
  }
  return { text: lines.join('\n') + '\n', status: result.ok ? 0 : 1 }
}
