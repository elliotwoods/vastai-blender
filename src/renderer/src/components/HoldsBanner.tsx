/**
 * Why the fleet is not renting: one row per hold in force (FleetHolds), each
 * with its reason and the one action that lifts it. A spent Vast balance
 * says so with a Top up link (plan 1.20's credit banner), a disk that
 * refuses frames says so, scale-up backing off says when it tries again,
 * and work recovered from the last session asks before it rents (#203:
 * this used to be RecoveryBanner, which never refreshed, and the only hold
 * shown at all).
 *
 * App-wide, above the screen and under AlertBanner: every hold stops
 * renting whatever screen is open, and an alert about an instance billing
 * unmanaged still outranks it. Only scale-UP is held: nodes already up
 * still take work, and idle ones still scale down.
 */

import type { CSSProperties } from 'react'
import { btn, mono } from '../lib/controls'
import { ipc } from '../lib/ipc'
import { useNav } from '../lib/nav'
import { useFleetHolds, useReleaseHold } from '../lib/queries'
import { ipcErrorText } from '../lib/recovery'
import { SCALE, TOKENS } from '../lib/theme'
import type { FleetHoldKind } from '../../../shared/models'
import { holdRows, type HoldRow } from './holds'
import { Icon } from './Icon'

const VAST_BILLING = 'https://cloud.vast.ai/billing/'

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function rowStyle(tone: HoldRow['tone']): CSSProperties {
  return tone === 'danger'
    ? {
        background: TOKENS.dangerBg,
        borderBottom: `1px solid ${TOKENS.dangerBorder}`,
        color: TOKENS.text
      }
    : {
        background: TOKENS.warnSoftBg,
        borderBottom: `1px solid ${TOKENS.warnSoftBorder}`,
        color: TOKENS.warnSoftText
      }
}

export function HoldsBanner(): React.JSX.Element | null {
  const { data: holds } = useFleetHolds()
  const release = useReleaseHold()
  const navigate = useNav((s) => s.navigate)
  const rows = holdRows(holds)
  if (rows.length === 0) return null

  return (
    <div role="status" style={{ flexShrink: 0 }}>
      {rows.map((row) => {
        const busy = release.isPending && release.variables === row.kind
        const failed = release.isError && release.variables === row.kind
        return (
          <div
            key={row.kind}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: SCALE.space3,
              padding: `${SCALE.space2} ${SCALE.space3} ${SCALE.space2} ${SCALE.space4}`,
              fontSize: SCALE.textSm,
              ...rowStyle(row.tone)
            }}
          >
            <Icon
              name={row.kind === 'account' ? 'dollar' : 'alert'}
              size={14}
              style={{ color: row.tone === 'danger' ? TOKENS.danger : TOKENS.warn }}
            />
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word', userSelect: 'text' }}>
              {row.text}
              {failed ? (
                <span style={{ marginLeft: SCALE.space2, color: TOKENS.danger }}>
                  {ipcErrorText(release.error)}
                </span>
              ) : null}
            </span>
            {row.since != null ? (
              <span
                title={`since ${new Date(row.since).toLocaleString()}`}
                style={{ ...mono, fontSize: SCALE.textXs, whiteSpace: 'nowrap', opacity: 0.8 }}
              >
                since {clock(row.since)}
              </span>
            ) : null}
            {row.topUp ? (
              <button
                style={btn({ size: 'sm', variant: 'primary' })}
                title="Add credit on Vast.ai's billing page"
                onClick={() => void ipc.invoke('shell:openExternal', VAST_BILLING)}
              >
                Top up
                <Icon name="external" size={11} />
              </button>
            ) : null}
            {row.apiKey ? (
              <button
                style={btn({ size: 'sm', variant: 'primary' })}
                onClick={() => navigate({ screen: 'settings', section: 'api' })}
              >
                API key
              </button>
            ) : null}
            {row.release ? (
              <button
                style={btn({
                  size: 'sm',
                  variant: row.release.primary ? 'primary' : 'default',
                  disabled: busy
                })}
                disabled={busy}
                title={row.release.title}
                // The kind is main's own key, so a hold this build has no
                // name for is released under the name main gave it.
                onClick={() => release.mutate(row.kind as FleetHoldKind)}
              >
                {busy ? 'working…' : row.release.label}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
