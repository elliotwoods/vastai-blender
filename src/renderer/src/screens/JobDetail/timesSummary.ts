import type { SceneRenderTimes } from '../../../../shared/models'

/** One phase of a frame's time, as the job screen draws it. */
export interface TimeSegment {
  key: 'load' | 'eval' | 'sync' | 'sample' | 'save'
  label: string
  /** mean seconds per frame; the load is its chunk's load over the chunk's frames */
  seconds: number
}

export interface TimesSummary {
  segments: TimeSegment[]
  /** mean seconds a frame costs, its share of the load included */
  perFrameS: number
  /** share of that time the GPU spends sampling, 0-1; null = sampling not timed */
  gpuBusy: number | null
}

/**
 * A frame's time split into its phases, the chunk's load spread over the
 * frames it rendered. Null when no frame was timed. Only the sampling keeps
 * the GPU busy: everything else is the paid GPU waiting.
 */
export function summariseTimes(t: SceneRenderTimes): TimesSummary | null {
  if (t.frames <= 0) return null
  const framesPerLoad = t.loads > 0 ? t.frames / t.loads : null
  const loadPerFrame = t.loadS != null && framesPerLoad ? t.loadS / framesPerLoad : 0
  const segments: TimeSegment[] = [
    { key: 'load', label: 'load', seconds: loadPerFrame },
    { key: 'eval', label: 'evaluate', seconds: t.evalS ?? 0 },
    { key: 'sync', label: 'sync / BVH', seconds: t.syncS ?? 0 },
    { key: 'sample', label: 'sample', seconds: t.sampleS ?? 0 },
    { key: 'save', label: 'save', seconds: t.saveS ?? 0 }
  ]
  const perFrameS = segments.reduce((sum, s) => sum + s.seconds, 0)
  const gpuBusy = t.sampleS != null && perFrameS > 0 ? t.sampleS / perFrameS : null
  return { segments, perFrameS, gpuBusy }
}

/** "0.4 s", "12 s", "3 min 20 s". */
export function fmtSeconds(s: number): string {
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 120) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - m * 60)} s`
}
