/**
 * Themed hover/focus tooltip, plus the `InfoHint` ⓘ affordance that marks a
 * label as having an explanation.
 *
 * Rendered through a portal on `document.body` with `position: fixed`: the
 * fleet/job lists live inside `overflow: auto` panels, so a tooltip positioned
 * inside the flow would be clipped by its scroll container.
 *
 * Usage:
 *   <Tooltip text="…"><span>rate</span></Tooltip>
 *   <span style={sectionLabel()}>rate</span> <InfoHint text="…" />
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { SCALE, TOKENS } from '../lib/theme'

/** Hover dwell before opening — long enough that scrubbing across a row is quiet. */
const OPEN_DELAY_MS = 120
/** Breathing room between the trigger and the panel, and from the viewport edge. */
const GAP = 8
/** Above SubmitJobDialog's overlay (zIndex 1000) — the only other layer. */
const Z_INDEX = 2000

const panelStyle: CSSProperties = {
  position: 'fixed',
  zIndex: Z_INDEX,
  maxWidth: 260,
  background: TOKENS.surfaceOverlay,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: SCALE.radiusSm,
  boxShadow: TOKENS.shadowPopover,
  padding: '6px 9px',
  fontSize: SCALE.textXs,
  lineHeight: SCALE.leadingNormal,
  color: TOKENS.textSecondary,
  // Hint copy that carries a computed figure (energy → CO2, say) separates it
  // from the explanation with a blank line; without this they run together.
  whiteSpace: 'pre-line',
  // Never let the panel swallow the pointer — it would flicker against the
  // trigger's own pointerleave.
  pointerEvents: 'none'
}

export function Tooltip({
  text,
  children,
  style
}: {
  text: string
  children: ReactNode
  style?: CSSProperties
}): React.JSX.Element {
  // `rect` is the trigger's box, captured when the tooltip opens; null = closed.
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)

  const clearTimer = useCallback((): void => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const open = useCallback((): void => {
    clearTimer()
    const el = triggerRef.current
    if (el) setRect(el.getBoundingClientRect())
  }, [clearTimer])

  const openSoon = useCallback((): void => {
    clearTimer()
    timer.current = window.setTimeout(open, OPEN_DELAY_MS)
  }, [clearTimer, open])

  const close = useCallback((): void => {
    clearTimer()
    setRect(null)
    setPos(null)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  // A fixed-position panel would detach from its trigger on scroll/resize, so
  // dismiss instead of chasing it.
  useEffect(() => {
    if (!rect) return
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [rect, close])

  // Place it once the panel has a measurable size: centred below the trigger,
  // flipped above when it would run off the bottom, clamped horizontally.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!rect || !panel) return
    const { width, height } = panel.getBoundingClientRect()
    const fitsBelow = rect.bottom + GAP + height <= window.innerHeight
    const fitsAbove = rect.top - GAP - height >= 0
    const below = fitsBelow || !fitsAbove
    setPos({
      left: Math.min(
        Math.max(GAP, rect.left + rect.width / 2 - width / 2),
        Math.max(GAP, window.innerWidth - width - GAP)
      ),
      top: below ? rect.bottom + GAP : rect.top - GAP - height
    })
  }, [rect])

  return (
    <>
      <span
        ref={triggerRef}
        onPointerEnter={openSoon}
        onPointerLeave={close}
        // Focus/blur bubble in React, so a focusable child (InfoHint's button)
        // opens the tooltip for keyboard users.
        onFocus={open}
        onBlur={close}
        style={{ display: 'inline-flex', alignItems: 'center', ...style }}
      >
        {children}
      </span>
      {rect
        ? createPortal(
            <div
              ref={panelRef}
              role="tooltip"
              style={{
                ...panelStyle,
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                // First paint is the measuring pass — hide it until placed.
                opacity: pos ? 1 : 0
              }}
            >
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/**
 * The ⓘ glyph with NO interaction of its own — decoration that says "there is
 * an explanation here", for triggers that are already interactive.
 *
 * Exists because `InfoHint` renders a <button>, and a <button> inside a
 * <button> is invalid HTML (React warns, and the nested control is
 * unreachable). Where the surrounding element is itself clickable, wrap THAT
 * in a <Tooltip> and use this for the glyph: the whole control becomes the
 * hover target, which is a bigger and more predictable one anyway.
 */
export function InfoDot({ size = 11 }: { size?: number }): React.JSX.Element {
  return (
    <span aria-hidden style={{ display: 'inline-flex', color: TOKENS.textFaint }}>
      <Icon name="info" size={size} />
    </span>
  )
}

/** The ⓘ marker: a focusable dot that reveals `text` on hover or focus. */
export function InfoHint({ text, size = 11 }: { text: string; size?: number }): React.JSX.Element {
  const [hot, setHot] = useState(false)
  return (
    <Tooltip text={text}>
      <button
        type="button"
        aria-label={text}
        // These sit inside click-to-expand rows — never toggle the row.
        onClick={(e) => e.stopPropagation()}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => setHot(false)}
        onFocus={() => setHot(true)}
        onBlur={() => setHot(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: 0,
          cursor: 'help',
          color: hot ? TOKENS.textSecondary : TOKENS.textFaint,
          transition: 'color 120ms'
        }}
      >
        <Icon name="info" size={size} />
      </button>
    </Tooltip>
  )
}
