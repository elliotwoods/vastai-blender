import { useEffect, useRef } from 'react'

/**
 * Canvas-drawn frame ruler with a lime playhead. Pointer drag follows the
 * ClipSyncController drag protocol via the callbacks: onPreview per rAF-
 * coalesced move (leader-only seek), onCommit at pointer-up (fan-out).
 */
export function FrameRuler({
  frame,
  totalFrames,
  fps,
  onPreview,
  onCommit
}: {
  frame: number
  totalFrames: number
  fps: number
  onPreview: (frame: number) => void
  onCommit: (frame: number) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pending: number | null; raf: number | null; active: boolean }>({
    pending: null,
    raf: null,
    active: false
  })

  // Redraw on frame / size changes.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = wrap.clientWidth
      const h = 28
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      const style = getComputedStyle(document.documentElement)
      const tickColor = style.getPropertyValue('--ruler-tick').trim() || '#3a3e46'
      const labelColor = style.getPropertyValue('--ruler-label').trim() || '#6f757e'
      const playheadColor = style.getPropertyValue('--playhead').trim() || '#a3e635'

      const xOf = (f: number): number => (f / Math.max(1, totalFrames - 1)) * (w - 1)

      // Second ticks (major) with labels; frame ticks (minor) when zoomed in.
      const fpsInt = Math.max(1, Math.round(fps))
      const pxPerFrame = w / Math.max(1, totalFrames)
      ctx.font = '9px var(--font-mono), monospace'
      ctx.fillStyle = labelColor
      ctx.strokeStyle = tickColor
      ctx.lineWidth = 1

      for (let f = 0; f < totalFrames; f += fpsInt) {
        const x = Math.round(xOf(f)) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, h - 12)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.fillText(`${Math.round(f / fpsInt)}s`, x + 3, h - 14)
      }
      if (pxPerFrame > 4) {
        for (let f = 0; f < totalFrames; f++) {
          const x = Math.round(xOf(f)) + 0.5
          ctx.beginPath()
          ctx.moveTo(x, h - 5)
          ctx.lineTo(x, h)
          ctx.stroke()
        }
      }

      // Playhead: line + grab handle.
      const px = Math.round(xOf(frame)) + 0.5
      ctx.strokeStyle = playheadColor
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, h)
      ctx.stroke()
      ctx.fillStyle = playheadColor
      ctx.fillRect(px - 2.5, 0, 5, 5)
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [frame, totalFrames, fps])

  const frameAt = (clientX: number): number => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const t = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.min(totalFrames - 1, Math.max(0, Math.round(t * (totalFrames - 1))))
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current.active = true
    onPreview(frameAt(e.clientX))
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d.active) return
    // rAF-coalesced: store the latest x, seek once per frame.
    d.pending = frameAt(e.clientX)
    if (d.raf == null) {
      d.raf = requestAnimationFrame(() => {
        d.raf = null
        if (d.pending != null && d.active) onPreview(d.pending)
      })
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d.active) return
    d.active = false
    if (d.raf != null) cancelAnimationFrame(d.raf)
    d.raf = null
    onCommit(frameAt(e.clientX))
  }

  return (
    <div
      ref={wrapRef}
      style={{ flex: 1, minWidth: 120, cursor: 'ew-resize', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}
