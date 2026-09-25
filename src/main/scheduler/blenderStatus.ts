/**
 * What Blender says it is doing, read from one line of its output: the
 * status line it prints as a frame renders, which the agent keeps as its
 * state's `lastLine`. Pure.
 *
 * The lines look like (Cycles, 4.x and 5.x):
 *
 *   Fra:12 Mem:1234.56M (Peak 1400.00M) | Time:00:05.12 | Remaining:00:31.44 | Mem:800.12M, Peak:812.00M | Scene, ViewLayer | Sample 32/256
 *   Fra:1 Mem:245.12M (Peak 245.12M) | Time:00:00.60 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Synchronizing object | Cube
 *
 * and (EEVEE):
 *
 *   Fra:1 Mem:98.22M (Peak 110.56M) | Time:00:00.87 | Rendering 12 / 64 samples
 *
 * Anything else, the agent's and the render driver's own VR_* marker lines
 * included, is not a status line: null.
 */

import type { RenderStatus } from '../../shared/models'

/** A marker line of the agent or the render driver (noderunner.py, render_driver.py). */
export function isMarkerLine(line: string): boolean {
  return /^\s*VR_[A-Z_]+\b/.test(line)
}

/** "1234.56M" or "1.2G" → MB. */
function mb(v: string | undefined): number | null {
  if (!v) return null
  const m = /^([\d.]+)\s*([KMG])?/i.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? 'M').toUpperCase()
  return unit === 'G' ? n * 1024 : unit === 'K' ? n / 1024 : n
}

/** "00:05.12", "01:02:03.45" or "5.12" → seconds. */
function seconds(v: string | undefined): number | null {
  if (!v) return null
  const parts = v.trim().split(':').map(Number)
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return null
  return parts.reduce((a, p) => a * 60 + p, 0)
}

export function parseStatusLine(line: string | null | undefined): RenderStatus | null {
  if (!line || isMarkerLine(line)) return null
  const head = /^\s*Fra:\s*(-?\d+)\b(.*)$/.exec(line)
  if (!head) return null
  const out: RenderStatus = {
    frame: Number(head[1]),
    memMb: null,
    peakMemMb: null,
    elapsedS: null,
    remainingS: null,
    deviceMemMb: null,
    devicePeakMemMb: null,
    sample: null,
    samples: null,
    phase: null
  }
  const segments = line.split('|').map((s) => s.trim())
  // The first segment: "Fra:12 Mem:1234.56M (Peak 1400.00M)".
  const host = /Mem:\s*([\d.]+[KMG]?)(?:\s*\(Peak\s*([\d.]+[KMG]?)\))?/i.exec(segments[0])
  if (host) {
    out.memMb = mb(host[1])
    out.peakMemMb = mb(host[2])
  }
  const text: string[] = []
  for (const seg of segments.slice(1)) {
    let m: RegExpExecArray | null
    if ((m = /^Time:\s*([\d:.]+)$/i.exec(seg))) out.elapsedS = seconds(m[1])
    else if ((m = /^Remaining:\s*([\d:.]+)$/i.exec(seg))) out.remainingS = seconds(m[1])
    else if ((m = /^Mem:\s*([\d.]+[KMG]?),\s*Peak:\s*([\d.]+[KMG]?)$/i.exec(seg))) {
      // Cycles: the render device's memory.
      out.deviceMemMb = mb(m[1])
      out.devicePeakMemMb = mb(m[2])
    } else text.push(seg)
  }
  // Samples: Cycles "Sample 32/256" (also "Rendered 4/4 Tiles, Sample 32/256"),
  // EEVEE "Rendering 12 / 64 samples".
  for (const seg of text) {
    const m =
      /\bSample\s+(\d+)\s*\/\s*(\d+)/i.exec(seg) ??
      /\bRendering\s+(\d+)\s*\/\s*(\d+)\s+samples/i.exec(seg)
    if (m) {
      out.sample = Number(m[1])
      out.samples = Number(m[2])
    }
  }
  // What it is doing: the last segment that is not the "Scene, ViewLayer"
  // name pair Cycles prints, joined with an object name after it.
  const words = text.filter((seg) => !/^[^,]+,\s*[^,]+$/.test(seg) || /\d+\s*\/\s*\d+/.test(seg))
  if (words.length > 0) {
    const last = words[words.length - 1]
    // "Synchronizing object | Cube": the object follows the phase.
    const phaseAt =
      words.length >= 2 && !/\d+\s*\/\s*\d+/.test(last) ? words.length - 2 : words.length - 1
    out.phase = words.slice(phaseAt).join(' · ')
  }
  return out
}
