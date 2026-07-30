/**
 * Luma histogram of the graded image with the tone curve drawn over it.
 *
 * The two together answer the question the sliders raise: the histogram says
 * where the image sits, the curve says what the grade is doing to it — so
 * crushed blacks or clipped highlights are visible as the curve flattening
 * against an edge with signal piled up under it.
 *
 * Canvas, not SVG: 256 bars redrawn on every slider move.
 */

import { useEffect, useRef } from 'react'
import { toneCurve, type Grade } from './grade'
import { TOKENS } from '../lib/theme'

const H = 74

export function Histogram({
  bins,
  grade,
  width = 214
}: {
  /** 256 buckets, 0..1, from GradeRenderer.histogram(); null = not sampled yet. */
  bins: Float32Array | null
  grade: Grade
  width?: number
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, H)

    // Backing grid at quarter stops — reading a histogram without reference
    // marks is guesswork.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    for (let q = 1; q < 4; q++) {
      const x = Math.round((width * q) / 4) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }

    if (bins) {
      // Square-root scaling: a linear histogram of a render is one spike at
      // the background value and nothing else legible.
      ctx.fillStyle = 'rgba(255,255,255,0.30)'
      for (let i = 0; i < 256; i++) {
        const v = Math.sqrt(bins[i])
        if (v <= 0) continue
        const x = (i / 255) * width
        const h = v * (H - 2)
        ctx.fillRect(x, H - h, Math.max(1, width / 256), h)
      }
    }

    // Identity reference, so a bent curve is obviously bent.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(0, H)
    ctx.lineTo(width, 0)
    ctx.stroke()
    ctx.setLineDash([])

    // The actual transfer this grade applies.
    const curve = toneCurve(grade, 256)
    ctx.strokeStyle = TOKENS.accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * width
      const y = H - curve[i] * H
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [bins, grade, width])

  return (
    <canvas
      ref={ref}
      aria-label="Luma histogram with tone curve"
      style={{
        width,
        height: H,
        display: 'block',
        background: TOKENS.surface,
        border: `1px solid ${TOKENS.border}`,
        borderRadius: 4
      }}
    />
  )
}
