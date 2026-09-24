/**
 * Sticky alerts: every error, and anything saying an instance may be billing
 * with nothing in the app managing it (a failed destroy, an orphan, "check the
 * Vast.ai console"). Each stays until dismissed. A billing risk also gets a
 * link to the Vast.ai instances page, the one place such an instance can be
 * checked and killed by hand.
 *
 * Above the screen and above RecoveryBanner, for the reason that one sits
 * there: it is app-wide, and money leaking outranks paused work.
 */

import { useMemo, useState, type CSSProperties } from 'react'
import { useAlertStore, type AlertItem } from '../lib/alertStore'
import { btn, mono } from '../lib/controls'
import { ipc } from '../lib/ipc'
import { SCALE, TOKENS } from '../lib/theme'
import { Icon } from './Icon'

const VAST_CONSOLE = 'https://cloud.vast.ai/instances/'
/** Rows shown before "show all": a burst of failures should not eat the screen. */
const MAX_ROWS = 3

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function tone(item: AlertItem): { row: CSSProperties; meta: string; icon: string } {
  if (item.level === 'error') {
    return {
      row: {
        background: TOKENS.dangerBg,
        borderBottom: `1px solid ${TOKENS.dangerBorder}`,
        color: TOKENS.text
      },
      meta: TOKENS.textSecondary,
      icon: TOKENS.danger
    }
  }
  // A billing risk raised as a warning ("not rented by this profile — left
  // running"): RecoveryBanner's colours.
  return {
    row: {
      background: TOKENS.warnSoftBg,
      borderBottom: `1px solid ${TOKENS.warnSoftBorder}`,
      color: TOKENS.warnSoftText
    },
    meta: TOKENS.warnSoftText,
    icon: TOKENS.warn
  }
}

function Row({ item }: { item: AlertItem }): React.JSX.Element {
  const dismiss = useAlertStore((s) => s.dismiss)
  const t = tone(item)
  const repeated = item.count > 1
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space3,
        padding: `${SCALE.space2} ${SCALE.space3} ${SCALE.space2} ${SCALE.space4}`,
        fontSize: SCALE.textSm,
        ...t.row
      }}
    >
      <Icon name="alert" size={14} style={{ color: t.icon }} />
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word', userSelect: 'text' }}>
        {item.message}
      </span>
      <span
        title={
          repeated
            ? `${item.count} times, first at ${clock(item.firstSeen)}, last at ${clock(item.lastSeen)}`
            : undefined
        }
        style={{ ...mono, fontSize: SCALE.textXs, color: t.meta, whiteSpace: 'nowrap' }}
      >
        {repeated ? `×${item.count} · ` : ''}
        {clock(item.lastSeen)}
      </span>
      {item.billingRisk ? (
        <button
          style={btn({ size: 'sm' })}
          title="Check for instances still billing, and destroy them by hand"
          onClick={() => void ipc.invoke('shell:openExternal', VAST_CONSOLE)}
        >
          Open Vast console
          <Icon name="external" size={11} />
        </button>
      ) : null}
      <button
        className="vr-alert-close"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => dismiss([item.key])}
      >
        <Icon name="cross" size={12} />
      </button>
    </div>
  )
}

export function AlertBanner(): React.JSX.Element | null {
  const items = useAlertStore((s) => s.items)
  const dismiss = useAlertStore((s) => s.dismiss)
  const [expanded, setExpanded] = useState(false)
  // Newest first.
  const open = useMemo(
    () => items.filter((a) => a.sticky && a.dismissedAt === null).reverse(),
    [items]
  )
  if (open.length === 0) return null

  const shown = expanded ? open : open.slice(0, MAX_ROWS)
  const hidden = open.length - shown.length
  return (
    <div role="alert" style={{ flexShrink: 0, maxHeight: '40vh', overflowY: 'auto' }}>
      {shown.map((a) => (
        <Row key={a.key} item={a} />
      ))}
      {open.length > 1 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: SCALE.space2,
            padding: `${SCALE.space1} ${SCALE.space3}`,
            background: TOKENS.surfaceRaised,
            borderBottom: `1px solid ${TOKENS.border}`
          }}
        >
          {open.length > MAX_ROWS ? (
            <button
              style={btn({ variant: 'ghost', size: 'sm' })}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show fewer' : `${hidden} more`}
            </button>
          ) : null}
          <button
            style={btn({ variant: 'ghost', size: 'sm' })}
            onClick={() => dismiss(open.map((a) => a.key))}
          >
            Dismiss all
          </button>
        </div>
      ) : null}
    </div>
  )
}
