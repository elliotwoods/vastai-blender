/**
 * Usage meters shared by the fleet table row and the expanded node panel, so
 * "82%" reads the same in both places. Tones and percentages come from
 * lib/usage.
 */

import type { CSSProperties } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { mono } from '../../lib/controls'
import { SCALE, TOKENS } from '../../lib/theme'
import { TONE_COLOR, type Tone } from '../../lib/usage'

/** Bare bar — the detail panel's gauges stack their own labels above it. */
export function Meter({
  pct,
  tone,
  height = 5
}: {
  pct: number | null
  tone: Tone
  height?: number
}): React.JSX.Element {
  return (
    <span style={{ display: 'block', height, background: TOKENS.border, borderRadius: height / 2 }}>
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%`,
          background: TONE_COLOR[tone],
          borderRadius: height / 2,
          transition: 'width 400ms, background 400ms'
        }}
      />
    </span>
  )
}

const labelStyle: CSSProperties = {
  ...mono,
  fontSize: SCALE.text2xs,
  minWidth: 30,
  textAlign: 'right'
}

/** One line of the table row's usage cluster: icon · bar · percentage. */
export function MiniMeter({
  icon,
  pct,
  tone,
  title
}: {
  icon: IconName
  pct: number | null
  tone: Tone
  title?: string
}): React.JSX.Element {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%' }} title={title}>
      <span
        style={{ display: 'flex', color: pct == null ? TOKENS.textDisabled : TOKENS.textFaint }}
      >
        <Icon name={icon} size={10} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <Meter pct={pct} tone={tone} height={4} />
      </span>
      <span style={{ ...labelStyle, color: pct == null ? TOKENS.textDisabled : TOKENS.textMuted }}>
        {pct == null ? '—' : `${pct.toFixed(0)}%`}
      </span>
    </span>
  )
}

/** Two stacked MiniMeters (compute over memory) inside one table column. */
export function MeterPair({
  width,
  top,
  bottom
}: {
  width: number
  top: React.JSX.Element
  bottom: React.JSX.Element
}): React.JSX.Element {
  return (
    <span style={{ width, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {top}
      {bottom}
    </span>
  )
}
