import type { CSSProperties, ReactNode } from 'react'
import { SCALE, TOKENS } from '../lib/theme'
import { mono, readout } from '../lib/controls'
import { compareCo2 } from '../lib/co2'
import { fmtCo2, fmtEnergy, fmtRate, fmtWatts } from '../lib/format'
import { HINTS } from '../lib/hints'
import { Icon } from './Icon'
import { InfoDot, Tooltip } from './Tooltip'
import { ipc } from '../lib/ipc'
import { useNarrow } from '../lib/layout'
import { useNav } from '../lib/nav'
import { useFleetCost, useNodes, useSettings, useUnclaimed } from '../lib/queries'
import {
  RUNWAY_HOLD_MIN,
  accountPerHour,
  fmtRunway,
  runwayMinutes,
  runwayTone
} from '../lib/runway'
import { capUsage } from '../../../shared/nodeState'
import type { HistoryMetric } from '../../../shared/models'

// Wraps rather than overlaps: each cluster is sized to its content, so one
// that no longer fits drops to a row of its own instead of shrinking to
// nothing under its neighbour.
const bar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: SCALE.space3,
  rowGap: 6,
  minHeight: 46,
  padding: `6px ${SCALE.space4}`,
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

function Brand({ compact }: { compact: boolean }): React.JSX.Element {
  // Compact: the square alone — the window's own title bar already says it.
  if (compact) return <span style={brandSquare} title="Vast Render" />
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

/**
 * Compact drops the labels for icons, the rate's watts and the session total
 * (all still a click away in History), leaving what a glance needs.
 */
function FleetReadouts({ compact }: { compact: boolean }): React.JSX.Element {
  const { data: cost } = useFleetCost()
  const { data: nodes } = useNodes()
  const { data: settings } = useSettings()
  const { data: unclaimed } = useUnclaimed()
  const navigate = useNav((s) => s.navigate)
  // The caps' own count and rate (nodeState.capUsage), the ones main's
  // maxActiveNodes and spend cap use: a failed node whose destroy Vast has
  // not confirmed counts, since it may still be billing (#64, #120). Read
  // from the nodes, which node:changed keeps live, so the rate is right at
  // launch rather than $0.000/hr until the first fleet:cost a minute in (#96).
  const usage = nodes ? capUsage(nodes) : null
  const perHour = usage?.perHour ?? cost?.perHour ?? null
  // How long the balance lasts at what the whole account bills, other
  // instances on it included, as main's credit guard reckons it (plan 1.20).
  const runway =
    cost?.balance != null
      ? runwayMinutes(cost.balance, accountPerHour(nodes ?? [], unclaimed ?? []).total)
      : null
  const runwayWarn = runway != null ? runwayTone(runway) : null
  // Summed from each running node's latest sample; 0 until a node reports a draw.
  const powerW = (nodes ?? [])
    .filter((n) => !['destroyed', 'failed', 'destroying'].includes(n.state))
    .reduce((sum, n) => sum + (n.metrics?.powerW ?? 0), 0)
  // Every readout is a live number with a past — clicking one opens its series.
  const toHistory = (metric: HistoryMetric) => () => navigate({ screen: 'history', metric })
  const pill: CSSProperties = compact ? { ...readout(), padding: '4px 8px' } : readout()
  const linked: CSSProperties = { ...pill, cursor: 'pointer' }
  const label = (text: string, icon: 'server' | 'battery'): React.JSX.Element =>
    compact ? (
      <span style={{ color: TOKENS.textFaint, display: 'inline-flex' }}>
        <Icon name={icon} size={12} />
      </span>
    ) : (
      <span style={{ color: TOKENS.textFaint }}>{text}</span>
    )
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: compact ? 6 : SCALE.space2
      }}
    >
      <span style={pill} title={compact ? 'nodes active / max' : undefined}>
        {label('nodes', 'server')}
        <span style={mono}>
          {usage?.nodes ?? '—'} / {settings?.maxActiveNodes ?? '—'}
        </span>
      </span>
      {/* Tooltip wraps the pill rather than nesting an InfoHint inside it:
          these pills are buttons, and a <button> inside a <button> is invalid
          HTML. Same shape as the balance pill below. */}
      <Tooltip text={HINTS.fleetRate}>
        <button style={linked} onClick={toHistory('spend')}>
          {compact ? null : <span style={{ color: TOKENS.textFaint }}>rate</span>}
          <span style={mono}>{perHour != null ? fmtRate(perHour) : '—'}</span>
          {compact ? null : (
            <>
              <span style={{ color: TOKENS.border }}>|</span>
              <span
                style={{
                  ...mono,
                  color: powerW > 0 ? TOKENS.textMuted : TOKENS.textDisabled,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3
                }}
              >
                <Icon name="power" size={11} />
                {powerW > 0 ? fmtWatts(powerW) : '— W'}
              </span>
              <InfoDot size={10} />
            </>
          )}
        </button>
      </Tooltip>
      {compact ? null : (
        <Tooltip
          text={
            cost && cost.sessionCo2g > 0
              ? `${HINTS.fleetSession}\n\n${fmtCo2(cost.sessionCo2g)} — ${compareCo2(cost.sessionCo2g)}`
              : HINTS.fleetSession
          }
        >
          <button style={linked} onClick={toHistory('spend')}>
            <span style={{ color: TOKENS.textFaint }}>total</span>
            {/* Unknown until main's first fleet:cost, not $0.00. */}
            <span style={mono}>{cost ? `$${cost.sessionTotal.toFixed(2)}` : '—'}</span>
            <span style={{ color: TOKENS.border }}>|</span>
            <span
              style={{
                ...mono,
                color: TOKENS.textMuted,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3
              }}
            >
              <Icon name="power" size={11} />
              {cost ? fmtEnergy(cost.sessionWh) : '—'}
            </span>
            <InfoDot size={10} />
          </button>
        </Tooltip>
      )}
      {/* The `+` already reads as an action, so this pill gets the tooltip
          without a second glyph competing with it. The pill itself opens the
          balance history; only the `+` leaves the app for the billing page. */}
      <Tooltip
        text={
          runway != null && Number.isFinite(runway)
            ? `${HINTS.balance}\n\nLasts ${fmtRunway(runway)} at what the account bills now.` +
              (runwayWarn ? ` Renting pauses under ${RUNWAY_HOLD_MIN} minutes.` : '')
            : HINTS.balance
        }
      >
        <button style={linked} onClick={toHistory('balance')}>
          {label('balance', 'battery')}
          <span
            style={{
              ...mono,
              color:
                runwayWarn === 'danger'
                  ? TOKENS.danger
                  : runwayWarn === 'warn'
                    ? TOKENS.warn
                    : TOKENS.text
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

const cluster: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: SCALE.space2,
  minWidth: 0
}

export function AppToolbar({ left, right, subRow }: AppToolbarProps): React.JSX.Element {
  const compact = useNarrow()
  const actions = left != null || right != null
  return (
    <header style={{ flexShrink: 0 }}>
      {compact ? (
        // Brand and readouts on top; the screen's own controls get a full-width
        // row beneath, where none of them has to fight the readouts for room.
        <div style={bar}>
          <Brand compact />
          <div style={{ ...cluster, flex: '1 1 0', justifyContent: 'flex-end' }}>
            <FleetReadouts compact />
          </div>
          {actions ? (
            <div style={{ ...cluster, flexBasis: '100%' }}>
              {left}
              {right ? <div style={{ ...cluster, marginLeft: 'auto' }}>{right}</div> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div style={bar}>
          <Brand compact={false} />
          <span style={divider} />
          {/* Basis is the content's width, so on a tight bar the whole cluster
              moves down a row rather than being squeezed under the readouts. */}
          <div style={{ ...cluster, flex: '1 1 auto' }}>{left}</div>
          <div style={{ ...cluster, marginLeft: 'auto', justifyContent: 'flex-end' }}>
            {right}
            <FleetReadouts compact={false} />
          </div>
        </div>
      )}
      {subRow ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            minWidth: 0,
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
