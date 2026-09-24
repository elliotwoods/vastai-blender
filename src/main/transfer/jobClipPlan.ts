/**
 * The pure half of job clip stitching (see jobClip.ts): which chunk clips go
 * in, in what order, and what the result is called. No SQLite, no ffmpeg, so
 * it is testable on its own.
 */

import type { FrameSegment } from '../../shared/models'

export interface PlanChunk {
  id: string
  frameStart: number
  frameEnd: number
}

export interface PlanClip {
  chunkId: string
  absPath: string
  fps: number | null
  frames: number | null
  width: number | null
  height: number | null
  codec: string | null
  hdr: number
}

export interface SegmentPlan {
  /** chunk clip paths in frame order */
  files: string[]
  /** job frames held, in clip order, adjacent runs merged */
  segments: FrameSegment[]
  frames: number
  fps: number
  width: number
  height: number
  codec: string
  hdr: boolean
}

/**
 * Which chunk clips go into a job clip, in what order, covering which frames.
 *
 * Pure. `chunks` are the job's COMPLETE chunks; `clips` their clips of ONE
 * kind. A clip is only usable when its frame count matches its chunk's range
 * (a requeue can narrow a chunk after an older clip of it landed), and all
 * clips must share one stream shape for `-c copy` to be valid — the majority
 * shape wins, and any odd one out becomes a gap rather than a broken file.
 */
export function planSegments(
  chunks: PlanChunk[],
  clips: PlanClip[],
  step: number
): SegmentPlan | null {
  const s = Math.max(1, step)
  const byChunk = new Map(clips.map((c) => [c.chunkId, c]))
  const usable: Array<{ chunk: PlanChunk; clip: PlanClip }> = []
  for (const chunk of [...chunks].sort((a, b) => a.frameStart - b.frameStart)) {
    const clip = byChunk.get(chunk.id)
    if (!clip) continue
    const expected = Math.floor((chunk.frameEnd - chunk.frameStart) / s) + 1
    if (clip.frames !== expected) continue
    usable.push({ chunk, clip })
  }
  if (usable.length === 0) return null

  const shape = (c: PlanClip): string =>
    [c.fps, c.width, c.height, c.codec ?? 'hevc', c.hdr ? 1 : 0].join('|')
  const tally = new Map<string, number>()
  for (const u of usable) tally.set(shape(u.clip), (tally.get(shape(u.clip)) ?? 0) + 1)
  // Ties go to the earliest shape seen (Map keeps insertion order).
  const winner = [...tally.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  const kept = usable.filter((u) => shape(u.clip) === winner)

  const segments: FrameSegment[] = []
  for (const { chunk } of kept) {
    const last = segments[segments.length - 1]
    if (last && chunk.frameStart === last.end + s) last.end = chunk.frameEnd
    else segments.push({ start: chunk.frameStart, end: chunk.frameEnd })
  }
  const ref = kept[0].clip
  return {
    files: kept.map((u) => u.clip.absPath),
    segments,
    frames: kept.reduce((a, u) => a + (u.clip.frames ?? 0), 0),
    fps: ref.fps ?? 25,
    width: ref.width ?? 0,
    height: ref.height ?? 0,
    codec: ref.codec ?? 'hevc',
    hdr: ref.hdr === 1
  }
}

/** Next versioned file name after `prev` (job_previewSdr.v3.mp4 → .v4). */
export function nextVersionName(kind: string, prev: string | null): string {
  const m = prev ? /\.v(\d+)\.mp4$/.exec(prev) : null
  const n = m ? parseInt(m[1], 10) + 1 : 1
  return `job_${kind}.v${n}.mp4`
}

/** ffmpeg concat-demuxer list; single quotes escaped the way it expects. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}
