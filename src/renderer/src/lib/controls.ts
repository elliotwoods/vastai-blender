/**
 * Shared control style factories — pure functions returning `CSSProperties`
 * built from TOKENS/SCALE, so every button / input / panel / chip is
 * consistent and re-themes from one place. Ported from the studio's shared
 * design system, extended with app-specific factories (sectionLabel, tableRow,
 * statusDot, logLine).
 *
 * Callers spread + extend: `style={{ ...btn({ variant: "primary" }), marginLeft: 6 }}`.
 */

import type { CSSProperties } from 'react'
import { SCALE, STATUS_VARS, TOKENS, type StatusTone } from './theme'

export type ControlSize = 'sm' | 'md'
export type BtnVariant = 'primary' | 'default' | 'ghost' | 'danger'

const SIZE_PAD: Record<ControlSize, CSSProperties> = {
  sm: { padding: '3px 8px', fontSize: SCALE.textSm },
  md: { padding: '6px 12px', fontSize: SCALE.textMd }
}

const BASE_BTN: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: SCALE.space2,
  fontFamily: SCALE.fontSans,
  fontWeight: SCALE.weightSemibold,
  lineHeight: SCALE.leadingTight,
  borderRadius: SCALE.radiusSm,
  border: '1px solid transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 120ms, border-color 120ms, color 120ms'
}

/** Monospace, tabular numerics — for frames, costs, counts, clocks. */
export const mono: CSSProperties = {
  fontFamily: SCALE.fontMono,
  fontVariantNumeric: 'tabular-nums'
}

/**
 * Button surface. `primary` and `active:true` both render the lime accent fill
 * (a pressed toggle reads as primary). `disabled` overrides every variant.
 */
export function btn(
  opts: { variant?: BtnVariant; size?: ControlSize; active?: boolean; disabled?: boolean } = {}
): CSSProperties {
  const { variant = 'default', size = 'md', active = false, disabled = false } = opts
  const base: CSSProperties = { ...BASE_BTN, ...SIZE_PAD[size] }

  if (disabled) {
    return {
      ...base,
      background: TOKENS.surfaceDisabled,
      borderColor: TOKENS.border,
      color: TOKENS.textDisabled,
      cursor: 'default'
    }
  }
  if (variant === 'primary' || active) {
    return {
      ...base,
      background: TOKENS.accent,
      borderColor: TOKENS.accent,
      color: TOKENS.accentFg
    }
  }
  if (variant === 'ghost') {
    return {
      ...base,
      background: 'transparent',
      borderColor: 'transparent',
      color: TOKENS.textMuted
    }
  }
  if (variant === 'danger') {
    return {
      ...base,
      background: TOKENS.surfaceRaised,
      borderColor: TOKENS.dangerBorder,
      color: TOKENS.danger
    }
  }
  return {
    ...base,
    background: TOKENS.surfaceRaised,
    borderColor: TOKENS.borderStrong,
    color: TOKENS.text
  }
}

/** Square icon button (a `btn` with equal width/height and no text padding). */
export function iconBtn(
  opts: { size?: ControlSize; active?: boolean; disabled?: boolean } = {}
): CSSProperties {
  const { size = 'md', active = false, disabled = false } = opts
  const dim = size === 'sm' ? 26 : 30
  return {
    ...btn({ variant: active ? 'primary' : 'default', size, disabled }),
    width: dim,
    height: dim,
    padding: 0
  }
}

/** One segment of a joined button group (borders collapse between segments). */
export function segmented(opts: {
  active: boolean
  position?: 'first' | 'middle' | 'last' | 'only'
}): CSSProperties {
  const { active, position = 'middle' } = opts
  const r = SCALE.radiusSm
  const radius =
    position === 'only'
      ? r
      : position === 'first'
        ? `${r} 0 0 ${r}`
        : position === 'last'
          ? `0 ${r} ${r} 0`
          : '0'
  return {
    ...btn({ variant: active ? 'primary' : 'default', size: 'sm' }),
    borderRadius: radius,
    marginLeft: position === 'first' || position === 'only' ? 0 : -1
  }
}

/** Card / panel surface (popovers, sheets, inspector). */
export function panel(opts: { elevated?: boolean } = {}): CSSProperties {
  const { elevated = false } = opts
  return {
    background: TOKENS.surfaceRaised,
    border: `1px solid ${TOKENS.border}`,
    borderRadius: SCALE.radiusMd,
    ...(elevated ? { boxShadow: TOKENS.shadowPopover } : {})
  }
}

/** Compact read-only info pill (toolbar readouts, cost/status summaries). */
export function readout(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: SCALE.space2,
    background: TOKENS.surfaceOverlay,
    border: `1px solid ${TOKENS.border}`,
    borderRadius: SCALE.radiusSm,
    padding: '5px 10px',
    fontSize: SCALE.textSm,
    color: TOKENS.text,
    whiteSpace: 'nowrap'
  }
}

/** Text input / select surface. */
export function input(opts: { size?: ControlSize; invalid?: boolean } = {}): CSSProperties {
  const { size = 'md', invalid = false } = opts
  return {
    ...SIZE_PAD[size],
    fontFamily: SCALE.fontSans,
    color: TOKENS.text,
    background: TOKENS.surface,
    border: `1px solid ${invalid ? TOKENS.danger : TOKENS.borderStrong}`,
    borderRadius: SCALE.radiusSm,
    boxSizing: 'border-box',
    outline: 'none'
  }
}

/**
 * Quiet inline-editable field: reads as text with a dashed underline instead
 * of a boxed form control.
 */
export function quietField(opts: { disabled?: boolean } = {}): CSSProperties {
  const { disabled = false } = opts
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: SCALE.space1,
    background: 'transparent',
    borderBottom: `1px dashed ${disabled ? TOKENS.border : TOKENS.borderStrong}`,
    padding: '1px 0',
    fontSize: SCALE.textSm,
    color: disabled ? TOKENS.textDisabled : TOKENS.text,
    cursor: disabled ? 'default' : 'pointer'
  }
}

/** Full-width, left-aligned dropdown option row (pickers, menus). */
export function menuItem(opts: { accent?: boolean } = {}): CSSProperties {
  const { accent = false } = opts
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SCALE.space2,
    width: '100%',
    textAlign: 'left',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: SCALE.radiusSm,
    padding: '5px 8px',
    fontSize: SCALE.textSm,
    fontFamily: SCALE.fontSans,
    color: accent ? TOKENS.accent : TOKENS.text,
    cursor: 'pointer'
  }
}

export type ChipTone = 'neutral' | 'accent' | 'warn' | 'danger'

/** Pill chip (engine badges, filter chips, statuses). */
export function chip(opts: { tone?: ChipTone } = {}): CSSProperties {
  const { tone = 'neutral' } = opts
  const tones: Record<ChipTone, CSSProperties> = {
    neutral: {
      background: TOKENS.surfaceRaised,
      borderColor: TOKENS.borderStrong,
      color: TOKENS.text
    },
    accent: {
      background: TOKENS.accentSoftBg,
      borderColor: TOKENS.accentSoftBorder,
      color: TOKENS.text
    },
    warn: {
      background: TOKENS.warnSoftBg,
      borderColor: TOKENS.warnSoftBorder,
      color: TOKENS.warnSoftText
    },
    danger: { background: TOKENS.dangerBg, borderColor: TOKENS.dangerBorder, color: TOKENS.text }
  }
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: SCALE.space1,
    padding: '3px 9px',
    fontSize: SCALE.textSm,
    fontFamily: SCALE.fontSans,
    borderRadius: SCALE.radiusPill,
    border: '1px solid transparent',
    ...tones[tone]
  }
}

// ---------------------------------------------------------------------------
// App-specific factories
// ---------------------------------------------------------------------------

/** 10px uppercase letter-spaced section label. */
export function sectionLabel(): CSSProperties {
  return {
    fontSize: SCALE.text2xs,
    fontWeight: SCALE.weightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: TOKENS.textFaint
  }
}

/**
 * Job / node table row. `expanded` hides the divider and darkens the row so it
 * reads as one block with the detail panel below it.
 */
export function tableRow(
  opts: { selected?: boolean; clickable?: boolean; expanded?: boolean } = {}
): CSSProperties {
  const { selected = false, clickable = false, expanded = false } = opts
  return {
    display: 'flex',
    alignItems: 'center',
    gap: SCALE.space3,
    padding: '8px 12px',
    // Always one shorthand carrying a colour — never let a caller layer the
    // `borderBottomColor` longhand on top. React's style diff clears the
    // longhand on the way back but skips the unchanged shorthand, leaving the
    // border to fall through to currentColor (a white line under the row).
    borderBottom: `1px solid ${expanded ? 'transparent' : TOKENS.border}`,
    background: expanded ? TOKENS.surface : selected ? TOKENS.accentSoftBg : 'transparent',
    cursor: clickable ? 'pointer' : 'default',
    transition: 'background 120ms'
  }
}

/** 8px status dot. */
export function statusDot(tone: StatusTone): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: STATUS_VARS[tone].fill,
    border: `1px solid ${STATUS_VARS[tone].border}`,
    flexShrink: 0
  }
}

/** One log line in a log panel. */
export function logLine(): CSSProperties {
  return {
    ...mono,
    fontSize: SCALE.textXs,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: TOKENS.textMuted
  }
}
