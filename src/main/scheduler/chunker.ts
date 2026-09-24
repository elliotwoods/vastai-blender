/** Frame-range chunking: split, and re-split around already-downloaded frames. */

export interface FrameRange {
  start: number
  end: number
}

/**
 * chunkSize = clamp(ceil(totalFrames / (maxNodes * 3)), 5, 50) — ~3 chunks in
 * flight per node gives render/encode/download pipelining and cheap
 * rebalancing without job-spec spam.
 */
export function autoChunkSize(totalFrames: number, maxNodes: number): number {
  const ideal = Math.ceil(totalFrames / (Math.max(1, maxNodes) * 3))
  return Math.max(5, Math.min(50, ideal))
}

/**
 * Refuse a step or chunk size the loops below cannot use. Both must be whole
 * numbers of at least 1. Zero never advances (`s = e + step` lands back on
 * `s`) and a negative value walks away from `end`: either way the loop spins,
 * pushing ranges until the heap runs out, and the main process is dead while
 * the fleet keeps billing. A fraction does advance, but it invents frames like
 * 3.5 that Blender never renders, so the chunk can never verify.
 */
function assertWholeAtLeastOne(what: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${what} must be a whole number of at least 1 (got ${value})`)
  }
}

/** Whole frame numbers, in order. An inverted range would chunk to nothing. */
function assertFrameRange(start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error(`frame range must be whole frame numbers (got ${start}–${end})`)
  }
  if (end < start) throw new Error(`frame range ends before it starts (${start}–${end})`)
}

/**
 * Split [start..end] (with step) into contiguous chunk ranges.
 *
 * Throws on a step or chunk size below 1 or not whole, and on an inverted or
 * fractional range. createJob validates the submission before it gets here;
 * this is the backstop that turns a missed case into an error instead of a
 * hung main process.
 */
export function splitFrames(
  start: number,
  end: number,
  step: number,
  chunkSize: number
): FrameRange[] {
  assertFrameRange(start, end)
  assertWholeAtLeastOne('frame step', step)
  assertWholeAtLeastOne('chunk size', chunkSize)
  const ranges: FrameRange[] = []
  let s = start
  while (s <= end) {
    const framesInChunk = chunkSize
    // advance by chunkSize steps
    const e = Math.min(end, s + (framesInChunk - 1) * step)
    ranges.push({ start: s, end: e })
    s = e + step
  }
  return ranges
}

/**
 * Given a failed chunk's range and the set of frames already safely
 * downloaded, produce the minimal set of contiguous ranges still needing
 * rendering (so requeues never redo verified work).
 *
 * Throws on a step that would never advance (zero, negative, missing) and on
 * an inverted range. No writer produces an inverted range; one would come back
 * empty here, and requeue would mark the chunk complete.
 *
 * The step check is deliberately looser than splitFrames'. This runs on rows
 * already in the database, from inside the scheduler's requeue, where a throw
 * escapes before the run is dropped or its node set back to idle — leaving a
 * billing node that never scales down. Jobs created before submissions were
 * validated can carry a fractional frame_step (the dialog accepted 2.5); those
 * requeue harmlessly and run out their retries, so only what would spin
 * forever is refused here.
 */
export function missingRanges(
  range: FrameRange,
  step: number,
  downloaded: Set<number>
): FrameRange[] {
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`frame step must be a positive number (got ${step})`)
  }
  if (range.end < range.start) {
    throw new Error(`frame range ends before it starts (${range.start}–${range.end})`)
  }
  const ranges: FrameRange[] = []
  let runStart: number | null = null
  for (let f = range.start; f <= range.end; f += step) {
    const missing = !downloaded.has(f)
    if (missing && runStart === null) runStart = f
    if (!missing && runStart !== null) {
      ranges.push({ start: runStart, end: f - step })
      runStart = null
    }
  }
  if (runStart !== null)
    ranges.push({ start: runStart, end: range.end - ((range.end - runStart) % step) })
  return ranges
}

/**
 * Frames in a range (inclusive, honouring step). Held to splitFrames' rules:
 * its only caller turns a fresh submission into frame rows, and a step of 0
 * here would push the same frame forever.
 */
export function framesIn(range: FrameRange, step: number): number[] {
  assertFrameRange(range.start, range.end)
  assertWholeAtLeastOne('frame step', step)
  const frames: number[] = []
  for (let f = range.start; f <= range.end; f += step) frames.push(f)
  return frames
}
