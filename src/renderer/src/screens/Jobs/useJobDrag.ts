/**
 * Dragging a job to a new place in the queue, with pointer events rather
 * than HTML5 drag and drop (whose ghost image and drop effects the app can't
 * style, and which Electron draws inconsistently across platforms).
 *
 *  - A drag starts only from a row's grip, and only once the pointer has
 *    moved DRAG_THRESHOLD_PX, so a click on the grip stays a click.
 *  - Hit testing runs at most once a frame (rAF): the row under the pointer
 *    (`data-job-row`) and where on it (dropIntent; blockIntent inside a
 *    group, from `data-block-index` / `data-block-size`).
 *  - Esc drops nothing. So does letting go where dropAction says null.
 *
 * The screen draws the result: the lifted row, the ghost at `ghost`, and the
 * target row's .vr-drop-* class (dropClass).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { blockIntent, dropIntent, type DropIntent } from './jobOrder'

export const DRAG_THRESHOLD_PX = 4

export interface JobDragState {
  jobId: string
  /** the pointer, in viewport px */
  x: number
  y: number
  /** the row under the pointer and where on it; null over nothing droppable */
  target: { jobId: string; intent: DropIntent } | null
}

export interface UseJobDrag {
  drag: JobDragState | null
  /** spread onto a grip: starts a drag of `jobId` */
  gripProps: (jobId: string) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  }
}

/** The .vr-drop-* class for a row, while a drag hovers it. */
export function dropClass(drag: JobDragState | null, jobId: string): string | undefined {
  if (!drag?.target || drag.target.jobId !== jobId || drag.jobId === jobId) return undefined
  return `vr-drop-${drag.target.intent}`
}

/** The row under a point and where on it, from the DOM. */
function hitTest(x: number, y: number): { jobId: string; intent: DropIntent } | null {
  const el = document.elementFromPoint(x, y)
  const row = el instanceof Element ? el.closest<HTMLElement>('[data-job-row]') : null
  const jobId = row?.dataset.jobRow
  if (!row || !jobId) return null
  const r = row.getBoundingClientRect()
  let intent = dropIntent(y - r.top, r.height)
  const index = Number(row.dataset.blockIndex)
  const size = Number(row.dataset.blockSize)
  if (Number.isFinite(index) && Number.isFinite(size)) intent = blockIntent(intent, index, size)
  return { jobId, intent }
}

export function useJobDrag(opts: {
  /** a drag let go over `target`; the caller decides whether it does anything */
  onDrop: (jobId: string, target: { jobId: string; intent: DropIntent }) => void
}): UseJobDrag {
  const [drag, setDrag] = useState<JobDragState | null>(null)
  const onDropRef = useRef(opts.onDrop)
  useEffect(() => {
    onDropRef.current = opts.onDrop
  })
  // The listeners of the gesture under way, to remove on unmount.
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanupRef.current?.(), [])

  const start = useCallback((jobId: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    // No text selection, no focus shuffle; the grip's click still fires.
    e.preventDefault()
    cleanupRef.current?.()
    const grip = e.currentTarget
    const pointerId = e.pointerId
    try {
      grip.setPointerCapture(pointerId)
    } catch {
      // not capturable (a synthetic event): the window listeners still work
    }
    const x0 = e.clientX
    const y0 = e.clientY
    let started = false
    let x = x0
    let y = y0
    let frame = 0
    let target: JobDragState['target'] = null

    const body = document.body.style
    const prevCursor = body.cursor
    const prevSelect = body.userSelect

    const tick = (): void => {
      frame = 0
      target = hitTest(x, y)
      setDrag({ jobId, x, y, target })
    }
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      x = ev.clientX
      y = ev.clientY
      if (!started) {
        if (Math.hypot(x - x0, y - y0) < DRAG_THRESHOLD_PX) return
        started = true
        body.cursor = 'grabbing'
        body.userSelect = 'none'
      }
      if (!frame) frame = requestAnimationFrame(tick)
    }
    const end = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      try {
        if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId)
      } catch {
        // gone with its row
      }
      body.cursor = prevCursor
      body.userSelect = prevSelect
      cleanupRef.current = null
      setDrag(null)
    }
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const wasStarted = started
      // Where it was let go, not where the last frame looked.
      const at = wasStarted ? hitTest(ev.clientX, ev.clientY) : null
      end()
      if (at) onDropRef.current(jobId, at)
    }
    const cancel = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) end()
    }
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      end()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
    cleanupRef.current = end
  }, [])

  const gripProps = useCallback(
    (jobId: string) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(jobId, e)
    }),
    [start]
  )

  return { drag, gripProps }
}
