/**
 * A job's frame domain: the ordered set of frame numbers it will produce.
 *
 * The filmstrip is indexed by THIS, not by the list of assets that happen to
 * exist. That inversion is what makes gaps free: a cell with no thumbnail *is*
 * the gap, so there is no sentinel row, no "which frames are missing" query,
 * and chunk membership is arithmetic rather than a lookup.
 *
 * Pure, and a sibling of frame-math.ts (which converts frames↔time within one
 * clip). This one converts frames↔position within one job.
 */

export interface FrameDomain {
  start: number
  end: number
  step: number
  /** Number of frames the job will produce. */
  count: number
}

export function domainOf(start: number, end: number, step: number): FrameDomain {
  const s = Math.max(1, Math.floor(step) || 1)
  const count = end >= start ? Math.floor((end - start) / s) + 1 : 0
  return { start, end, step: s, count }
}

/** Frame number at a strip index. */
export function frameAt(domain: FrameDomain, index: number): number {
  return domain.start + clampIndex(domain, index) * domain.step
}

/**
 * Strip index of a frame number. Frames that fall between steps snap DOWN to
 * the preceding rendered frame rather than reporting -1 — a scrub landing
 * mid-step should select the frame you can actually see.
 */
export function indexOf(domain: FrameDomain, frame: number): number {
  if (domain.count === 0) return 0
  return clampIndex(domain, Math.floor((frame - domain.start) / domain.step))
}

/** True when this frame number is one the job actually renders. */
export function containsFrame(domain: FrameDomain, frame: number): boolean {
  if (frame < domain.start || frame > domain.end) return false
  return (frame - domain.start) % domain.step === 0
}

function clampIndex(domain: FrameDomain, index: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(domain.count - 1, Math.round(index)))
}

/** Inclusive index range covering a chunk's frames, or null if disjoint. */
export function chunkRange(
  domain: FrameDomain,
  frameStart: number,
  frameEnd: number
): { from: number; to: number } | null {
  if (frameEnd < domain.start || frameStart > domain.end) return null
  return {
    from: indexOf(domain, Math.max(frameStart, domain.start)),
    to: indexOf(domain, Math.min(frameEnd, domain.end))
  }
}
