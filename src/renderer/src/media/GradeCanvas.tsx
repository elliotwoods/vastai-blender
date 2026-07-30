import { useEffect, useRef } from 'react'
import { GradeRenderer, type SourceTransfer } from './GradeRenderer'
import type { Grade } from './grade'

/**
 * Mounts a GradeRenderer over a <video> and keeps it fed. Display-only: the
 * <video> underneath stays the element ClipSyncController registers and seeks,
 * so transport, sync and HDR remount logic are untouched by grading.
 *
 * The video is OCCLUDED, never hidden. `display:none` is not a documented
 * guarantee that a media element keeps presenting frames, and
 * requestVideoFrameCallback — the renderer's clock — only fires for presented
 * frames. Occlusion also makes the fallback free: drop the canvas, restore the
 * CSS filter, nothing else moves.
 */
export function GradeCanvas({
  videoRef,
  videoKey,
  grade,
  transfer,
  onUnavailable,
  onHistogram
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** The <video>'s React key — a change means it remounted, so re-attach. */
  videoKey: string
  grade: Grade
  transfer: SourceTransfer
  onUnavailable: (reason: string) => void
  /** Periodic luma histogram of the graded output, when someone is watching. */
  onHistogram?: (bins: Float32Array | null) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<GradeRenderer | null>(null)
  // Held in a ref so a changing callback identity can't tear down the GL
  // context. Seeded at mount and synced in an effect — never during render.
  const unavailableRef = useRef(onUnavailable)
  useEffect(() => {
    unavailableRef.current = onUnavailable
  }, [onUnavailable])

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const renderer = new GradeRenderer(canvas, (reason) => unavailableRef.current(reason))
    rendererRef.current = renderer
    if (!renderer.alive) {
      renderer.destroy()
      rendererRef.current = null
      return
    }
    renderer.attach(video)
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
    // videoKey: the HDR toggle remounts the <video>, so the ref points at a new
    // element and the renderer must re-bind to it.
  }, [videoRef, videoKey])

  useEffect(() => {
    rendererRef.current?.setParams({ grade, transfer })
  }, [grade, transfer])

  // Sampling reads back the drawing buffer, so it only runs while something is
  // actually displaying a histogram, and on a timer rather than per frame.
  useEffect(() => {
    if (!onHistogram) return
    const sample = (): void => onHistogram(rendererRef.current?.histogram() ?? null)
    const id = setInterval(sample, 400)
    const first = setTimeout(sample, 120)
    return () => {
      clearInterval(id)
      clearTimeout(first)
    }
  }, [onHistogram, grade, transfer])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // inset:-1 — sub-pixel layout rounding must never leave a sliver of the
      // ungraded (and, on an HDR display, HDR-composited) video at the edge.
      // The parent tile clips with overflow:hidden, so the bleed is invisible.
      style={{ position: 'absolute', inset: -1, display: 'block' }}
    />
  )
}
