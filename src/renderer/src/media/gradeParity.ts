/**
 * Core-tier parity check: does the WebGL shader reproduce the CSS filter?
 *
 * The wall grades with a CSS filter and the previewer grades with a shader,
 * from one shared Grade. If the two disagree, the same clip looks different
 * depending on which surface you opened it from — so the agreement needs to be
 * measured, not assumed.
 *
 * THE ORACLE. You cannot read back a CSS-filtered <video>: drawImage does not
 * apply the element's CSS `filter`. But `CanvasRenderingContext2D.filter`
 * accepts the same syntax and runs the same Skia filter chain, and ITS result
 * is readable. That is the reference this compares against. If the oracle
 * itself ever diverges from real CSS `filter`, this whole check is measuring
 * the wrong thing — cross-check once against a window capture before trusting
 * a surprising result.
 *
 * Only the CORE tier is comparable. Exposure/gamma/temperature are
 * shader-only, and HLG is a documented difference (graded mode deliberately
 * replaces Chromium's HLG→SDR conversion), so both are excluded here.
 */

import { gradeToFilter, IDENTITY_GRADE, type Grade } from './grade'

export interface ParityResult {
  grade: Grade
  /** Largest per-channel absolute difference, in 8-bit code values. */
  maxDelta: number
  /** 99th-percentile difference — a few outlier texels shouldn't fail a run. */
  p99Delta: number
  pass: boolean
}

/**
 * Measured, not aspirational.
 *
 * Every single-parameter grade agrees to ≤1 LSB. Combined
 * contrast+brightness+saturate chains land at 2-3 LSB — under 1.2% on an
 * 8-bit channel, and invisible, but real. Two things were tried and rejected
 * for it: dropping the per-stage clamp (far worse — 11, 26, 35 LSB) and
 * rounding to 8 bits between primitives (no better on the combined grades and
 * worse on the simple ones). Skia's residual chain arithmetic was not isolated
 * further.
 *
 * So the bar is 3, which is what the implementation actually achieves — a
 * genuine shader regression moves the numbers far more than that, and a bar of
 * 1 would mean two permanent FAILs that everyone learns to ignore.
 */
export const PARITY_TOLERANCE = 3

/** Grades to sweep. Deliberately includes intermediates that exceed 1.0. */
export const PARITY_SWEEP: Grade[] = [
  IDENTITY_GRADE,
  { ...IDENTITY_GRADE, contrast: 1.35, brightness: 0.96, saturate: 1.1 },
  { ...IDENTITY_GRADE, contrast: 1.6, brightness: 0.9, saturate: 1.25 },
  { ...IDENTITY_GRADE, contrast: 0.6 },
  { ...IDENTITY_GRADE, contrast: 2 },
  { ...IDENTITY_GRADE, brightness: 1.5 },
  { ...IDENTITY_GRADE, brightness: 0.5 },
  { ...IDENTITY_GRADE, saturate: 0 },
  { ...IDENTITY_GRADE, saturate: 2 },
  { ...IDENTITY_GRADE, lift: 0.2 },
  { ...IDENTITY_GRADE, lift: -0.2 },
  { ...IDENTITY_GRADE, contrast: 1.35, brightness: 0.98, saturate: 0, lift: 0.02 }
]

/** Readable reference for the CSS path, at the source's native size. */
export function cssReference(
  video: HTMLVideoElement,
  grade: Grade
): { width: number; height: number; data: Uint8ClampedArray } | null {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.filter = gradeToFilter(grade)
  ctx.drawImage(video, 0, 0)
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data }
}

/**
 * Compare two RGBA buffers, ignoring alpha (the shader always writes 1.0 and
 * the 2D context carries the source's, which for video is also opaque).
 */
export function compare(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray
): { maxDelta: number; p99Delta: number } {
  const histogram = new Uint32Array(256)
  let maxDelta = 0
  let count = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c])
      histogram[d]++
      count++
      if (d > maxDelta) maxDelta = d
    }
  }
  // p99 from the histogram — cheaper than sorting millions of samples.
  const target = count * 0.99
  let running = 0
  let p99Delta = 0
  for (let d = 0; d < 256; d++) {
    running += histogram[d]
    if (running >= target) {
      p99Delta = d
      break
    }
  }
  return { maxDelta, p99Delta }
}

export function formatResult(r: ParityResult): string {
  const g = r.grade
  return (
    `[gradelab] con=${g.contrast.toFixed(2)} bri=${g.brightness.toFixed(2)} ` +
    `sat=${g.saturate.toFixed(2)} lift=${g.lift.toFixed(3)} ` +
    `maxΔ=${r.maxDelta} p99Δ=${r.p99Delta} ${r.pass ? 'PASS' : 'FAIL'}`
  )
}
