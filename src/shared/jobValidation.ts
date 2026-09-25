/**
 * Job submission checks, shared by main and the renderer.
 *
 * createJob runs validateSubmission before it touches the disk or the DB, so
 * both ways in — the New render dialog over IPC, and a VR_JOB_SPEC campaign
 * file at boot — meet the same rules. The dialog runs the same checks as the
 * user types, so a bad field is explained next to the button it disables
 * instead of being refused after the click.
 *
 * Each field is checked as if its type were unknown: IPC arguments and JSON
 * spec files are only typed on paper, and a chunk size of 0 that slips through
 * spins splitFrames forever with the main process dead and the fleet billing.
 */

import type { EngineId, JobSubmission } from './models'
import { localPathProblem, type PathFlavour } from './settingsSanitize'

/**
 * Blender's highest frame number (MAXFRAME). `-e` clamps anything above it,
 * so frames past it would never render and their chunk could never verify.
 * It also bounds the frame rows one submission can insert.
 */
export const MAX_FRAME = 1_048_574

/**
 * Most frames one job may render. createJob inserts a row per frame, and a
 * chunk row per chunk, in one transaction on the main thread: a typo such as
 * 0-1000000 held IPC and the scheduler's ticks for seconds, and every job:get
 * after it carried a million frames. An hour of animation at 24 fps is 86,400.
 */
export const MAX_JOB_FRAMES = 100_000

/** A Record, so adding an EngineId without listing it here fails to compile. */
const ENGINE_IDS: Record<EngineId, true> = { eevee: true, cycles: true, octane: true }

/**
 * Everything a submission says about how to render, without which scene. The
 * New render dialog applies one set of these to every scene it submits.
 */
export type RenderOptions = Omit<JobSubmission, 'blendPath' | 'name'>

type Unchecked<T> = { [K in keyof T]?: unknown }

/**
 * Frames must be whole and within what Blender accepts. The floor is 0, not
 * Blender's negative animation frames: the node agent hands `-s` to Blender,
 * which reads a leading '-' as "relative to the scene's start", and it only
 * recognises `NNNN.ext` output names, so a negative frame could never verify.
 */
function frameProblem(what: string, value: unknown): string | null {
  if (!Number.isInteger(value)) return `${what} must be a whole number (got ${String(value)})`
  const frame = value as number
  if (frame < 0 || frame > MAX_FRAME) {
    return `${what} must be between 0 and ${MAX_FRAME} (got ${frame})`
  }
  return null
}

/** Problems with the render options alone; empty = ok. */
export function validateRenderOptions(options: RenderOptions): string[] {
  const o = options as Unchecked<RenderOptions>
  const problems: string[] = []

  if (typeof o.engine !== 'string' || !Object.keys(ENGINE_IDS).includes(o.engine)) {
    problems.push(
      `engine must be one of ${Object.keys(ENGINE_IDS).join(', ')} (got ${String(o.engine)})`
    )
  }

  const startProblem = frameProblem('start frame', o.frameStart)
  const endProblem = frameProblem('end frame', o.frameEnd)
  if (startProblem) problems.push(startProblem)
  if (endProblem) problems.push(endProblem)
  if (!startProblem && !endProblem) {
    const start = o.frameStart as number
    const end = o.frameEnd as number
    if (end < start) problems.push(`end frame ${end} is before start frame ${start}`)
  }

  const stepOk = Number.isInteger(o.frameStep) && (o.frameStep as number) >= 1
  if (!stepOk) {
    problems.push(`frame step must be a whole number of at least 1 (got ${String(o.frameStep)})`)
  }
  if (!startProblem && !endProblem && stepOk) {
    const start = o.frameStart as number
    const end = o.frameEnd as number
    const frames = Math.floor((end - start) / (o.frameStep as number)) + 1
    if (frames > MAX_JOB_FRAMES) {
      problems.push(
        `${frames} frames is more than one job may render (${MAX_JOB_FRAMES}): split the range into several jobs`
      )
    }
  }

  // null = auto. undefined too: createJob's `??` has always read it that way.
  if (o.chunkSize != null && (!Number.isInteger(o.chunkSize) || (o.chunkSize as number) < 1)) {
    problems.push(
      `chunk size must be a whole number of at least 1, or auto (got ${String(o.chunkSize)})`
    )
  }

  // Stored as JSON and iterated at dispatch: a bare string would iterate as
  // one "extension id" per character.
  if (!Array.isArray(o.addonIds) || !o.addonIds.every((a) => typeof a === 'string' && a)) {
    problems.push('extensions must be a list of extension ids')
  }

  if (o.shareNode != null && typeof o.shareNode !== 'boolean') {
    problems.push(`share node must be true or false (got ${String(o.shareNode)})`)
  }

  return problems
}

/**
 * Every problem with a submission, as messages fit to show the user; empty =
 * ok. Main adds one check of its own on top: that the scene file exists,
 * which the renderer cannot see.
 *
 * The scene must be a file on this computer, named by a full path
 * (localPathProblem): every job's scene is somewhere Explorer or Finder may
 * reveal (shell:showItemInFolder), and on Windows revealing a network path
 * hands the user's NTLM hash to whoever serves it; a render must not hang on
 * a share that has gone away either. Main passes its own `pathFlavour`;
 * without one both path forms pass, good enough for a hint as the user types.
 */
export function validateSubmission(
  sub: JobSubmission,
  opts: { pathFlavour?: PathFlavour } = {}
): string[] {
  if (typeof sub !== 'object' || sub === null) return ['job submission is missing']
  const s = sub as Unchecked<JobSubmission>
  const problems: string[] = []
  if (typeof s.blendPath !== 'string' || s.blendPath.trim() === '') {
    problems.push('no scene file chosen')
  } else {
    const where = localPathProblem(s.blendPath, opts.pathFlavour)
    if (where) problems.push(`scene file ${where} (got ${JSON.stringify(s.blendPath)})`)
  }
  if (s.name != null && typeof s.name !== 'string') {
    problems.push(`job name must be text (got ${String(s.name)})`)
  }
  return [...problems, ...validateRenderOptions(sub)]
}
