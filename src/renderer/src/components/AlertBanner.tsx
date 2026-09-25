/**
 * Sticky alerts: every error, and anything saying an instance may be billing
 * with nothing in the app managing it (a failed destroy, an orphan, "check the
 * Vast.ai console"). Each stays until dismissed. A billing risk also gets a
 * link to the Vast.ai instances page, the one place such an instance can be
 * checked and killed by hand, and is listed above every plain error.
 *
 * Above the screen and above HoldsBanner, for the reason that one sits
 * there: it is app-wide, and money leaking outranks paused work.
 */

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { bannerOrder, OnScreen, useAlertStore, type AlertItem } from '../lib/alertStore'
import { btn, mono } from '../lib/controls'
import { ipc } from '../lib/ipc'
import { SCALE, TOKENS } from '../lib/theme'
import { Icon } from './Icon'

const VAST_CONSOLE = 'https://cloud.vast.ai/instances/'
/** Rows shown before "show all": a burst of failures should not eat the screen. */
const MAX_ROWS = 3

/**
 * Dismiss here and in main. Main's copy is what a window replays when it
 * mounts, and without it every error already dealt with would be back each
 * time a macOS window reopened.
 */
function useDismiss(): (keys: string[]) => void {
  const dismiss = useAlertStore((s) => s.dismiss)
  return (keys) => {
    dismiss(keys)
    ipc
      .invoke('alerts:dismiss', keys)
      .catch((e: unknown) => console.error('alerts:dismiss failed', e))
  }
}

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
  // running"): HoldsBanner's colours for a hold.
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

function Row({ item, onDismiss }: { item: AlertItem; onDismiss: () => void }): React.JSX.Element {
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
      <button className="vr-alert-close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <Icon name="cross" size={12} />
      </button>
    </div>
  )
}

export function AlertBanner(): React.JSX.Element | null {
  const items = useAlertStore((s) => s.items)
  const dismiss = useDismiss()
  const [expanded, setExpanded] = useState(false)
  const open = useMemo(() => bannerOrder(items), [items])
  const shown = expanded ? open : open.slice(0, MAX_ROWS)
  const onScreen = useRef(new OnScreen())
  // After every render, once the rows are drawn: which ones, and since when.
  useLayoutEffect(() => {
    onScreen.current.drawn(shown.map((a) => a.key))
  })
  // Only rows on screen long enough to have been read (SETTLE_MS). A row
  // that has just slid under the pointer stays, for the next click.
  const dismissRead = (keys: string[]): void => {
    const read = onScreen.current.settled(keys)
    if (read.length > 0) dismiss(read)
  }
  if (open.length === 0) return null

  const hidden = open.length - shown.length
  return (
    <div role="alert" style={{ flexShrink: 0, maxHeight: '40vh', overflowY: 'auto' }}>
      {shown.map((a) => (
        <Row key={a.key} item={a} onDismiss={() => dismissRead([a.key])} />
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
          {/* Only the rows on screen, and only those that have been there a
              moment: nothing is dismissed unread. The next ones move up in
              their place. */}
          <button
            style={btn({ variant: 'ghost', size: 'sm' })}
            onClick={() => dismissRead(shown.map((a) => a.key))}
          >
            {hidden > 0 ? `Dismiss these ${shown.length}` : 'Dismiss all'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
