import type { CSSProperties, ReactNode } from 'react'
import { SCALE, TOKENS } from '../lib/theme'
import { mono, readout } from '../lib/controls'
import { compareCo2 } from '../lib/co2'
import { fmtCo2, fmtEnergy, fmtRate } from '../lib/format'
import { HINTS } from '../lib/hints'
import { InfoDot, Tooltip } from './Tooltip'
import { ipc } from '../lib/ipc'
import { useNav } from '../lib/nav'
import { useFleetCost, useNodes, useSettings } from '../lib/queries'
import type { HistoryMetric } from '../../../shared/models'

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: SCALE.space3,
  height: 46,
  padding: `0 ${SCALE.space4}`,
  borderBottom: `1px solid ${TOKENS.border}`,
  background: TOKENS.surfaceRaised,
  flexShrink: 0
}

const brandSquare: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: 2,
  background: TOKENS.accent,
  boxShadow: '0 0 12px rgba(163, 230, 53, 0.5)',
  flexShrink: 0
}

const divider: CSSProperties = {
  width: 1,
  height: 20,
  background: TOKENS.border,
  flexShrink: 0
}

function Brand(): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <span style={brandSquare} />
      <span
        style={{
          fontSize: SCALE.textSm,
          fontWeight: SCALE.weightBold,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: TOKENS.text
        }}
      >
        Vast Render
      </span>
      <span style={{ fontSize: SCALE.text2xs, color: TOKENS.textFaint }}>blender fleet</span>
    </div>
  )
}

function FleetReadouts(): React.JSX.Element {
  const { data: cost } = useFleetCost()
  const { data: nodes } = useNodes()
  const { data: settings } = useSettings()
  const navigate = useNav((s) => s.navigate)
  const active = (nodes ?? []).filter(
    (n) => !['destroyed', 'failed', 'destroying'].includes(n.state)
  ).length
  // Every readout is a live number with a past — clicking one opens its series.
  const toHistory = (metric: HistoryMetric) => () => navigate({ screen: 'history', metric })
  const linked: CSSProperties = { ...readout(), cursor: 'pointer' }
  return (
    <div style={{ display: 'flex', gap: SCALE.space2 }}>
      <span style={readout()}>
        <span style={{ color: TOKENS.textFaint }}>nodes</span>
        <span style={mono}>
          {active} / {settings?.maxActiveNodes ?? '—'}
        </span>
      </span>
      {/* Tooltip wraps the pill rather than nesting an InfoHint inside it:
          these pills are buttons, and a <button> inside a <button> is invalid
          HTML. Same shape as the balance pill below. */}
      <Tooltip text={HINTS.fleetRate}>
        <button style={linked} onClick={toHistory('spend')}>
          <span style={{ color: TOKENS.textFaint }}>rate</span>
          <span style={mono}>{cost ? fmtRate(cost.perHour) : '$0.000/hr'}</span>
          <InfoDot size={10} />
        </button>
      </Tooltip>
      <Tooltip
        text={
          cost && cost.sessionCo2g > 0
            ? `${HINTS.fleetSession}\n\n${fmtCo2(cost.sessionCo2g)} — ${compareCo2(cost.sessionCo2g)}`
            : HINTS.fleetSession
        }
      >
        <button style={linked} onClick={toHistory('spend')}>
          <span style={{ color: TOKENS.textFaint }}>session</span>
          <span style={mono}>${(cost?.sessionTotal ?? 0).toFixed(2)}</span>
          <span style={{ color: TOKENS.border }}>|</span>
          <span style={{ ...mono, color: TOKENS.textMuted }}>
            {fmtEnergy(cost?.sessionWh ?? 0)}
          </span>
          <InfoDot size={10} />
        </button>
      </Tooltip>
      {/* The `+` already reads as an action, so this pill gets the tooltip
          without a second glyph competing with it. The pill itself opens the
          balance history; only the `+` leaves the app for the billing page. */}
      <Tooltip text={HINTS.balance}>
        <button style={linked} onClick={toHistory('balance')}>
          <span style={{ color: TOKENS.textFaint }}>balance</span>
          <span
            style={{
              ...mono,
              color: cost?.balance != null && cost.balance < 5 ? TOKENS.warn : TOKENS.text
            }}
          >
            {cost?.balance != null ? `$${cost.balance.toFixed(2)}` : '—'}
          </span>
          <span
            role="button"
            tabIndex={0}
            title="Add funds"
            style={{ color: TOKENS.accent, fontSize: SCALE.text2xs, cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation()
              void ipc.invoke('shell:openExternal', 'https://cloud.vast.ai/billing/')
            }}
          >
            +
          </span>
        </button>
      </Tooltip>
    </div>
  )
}

export interface AppToolbarProps {
  /** Contextual actions for the current screen. */
  left?: ReactNode
  /** Extra right-cluster content (rendered before the fleet readouts). */
  right?: ReactNode
  /** Optional breadcrumb / sub-row below the main bar. */
  subRow?: ReactNode
}

export function AppToolbar({ left, right, subRow }: AppToolbarProps): React.JSX.Element {
  return (
    <header style={{ flexShrink: 0 }}>
      <div style={bar}>
        <Brand />
        <span style={divider} />
        <div
          style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2, flex: 1, minWidth: 0 }}
        >
          {left}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2, flexShrink: 0 }}>
          {right}
          <FleetReadouts />
        </div>
      </div>
      {subRow ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: SCALE.space2,
            padding: `6px ${SCALE.space4}`,
            borderBottom: `1px solid ${TOKENS.border}`,
            background: TOKENS.surface
          }}
        >
          {subRow}
        </div>
      ) : null}
    </header>
  )
}
