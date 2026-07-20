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

/** Split [start..end] (with step) into contiguous chunk ranges. */
export function splitFrames(
  start: number,
  end: number,
  step: number,
  chunkSize: number
): FrameRange[] {
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
 */
export function missingRanges(
  range: FrameRange,
  step: number,
  downloaded: Set<number>
): FrameRange[] {
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

/** Frames in a range (inclusive, honouring step). */
export function framesIn(range: FrameRange, step: number): number[] {
  const frames: number[] = []
  for (let f = range.start; f <= range.end; f += step) frames.push(f)
  return frames
}
