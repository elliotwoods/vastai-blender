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

/**
 * Blender's highest frame number (MAXFRAME). `-e` clamps anything above it,
 * so frames past it would never render and their chunk could never verify.
 * It also bounds the frame rows one submission can insert.
 */
export const MAX_FRAME = 1_048_574

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

  if (!Number.isInteger(o.frameStep) || (o.frameStep as number) < 1) {
    problems.push(`frame step must be a whole number of at least 1 (got ${String(o.frameStep)})`)
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
 */
export function validateSubmission(sub: JobSubmission): string[] {
  if (typeof sub !== 'object' || sub === null) return ['job submission is missing']
  const s = sub as Unchecked<JobSubmission>
  const problems: string[] = []
  if (typeof s.blendPath !== 'string' || s.blendPath.trim() === '') {
    problems.push('no scene file chosen')
  }
  if (s.name != null && typeof s.name !== 'string') {
    problems.push(`job name must be text (got ${String(s.name)})`)
  }
  return [...problems, ...validateRenderOptions(sub)]
}
