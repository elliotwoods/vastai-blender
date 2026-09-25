/**
 * Transient toasts for info and warn alerts, bottom right above the page bar.
 *
 * Errors and billing risks are not toasts: they belong to AlertBanner, which
 * keeps them until dismissed. A toast that would say an instance may still be
 * billing must not time out on its own.
 */

import { useEffect, useMemo, type CSSProperties } from 'react'
import { useAlertStore, toastMs, type AlertItem } from '../lib/alertStore'
import { mono, panel } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import { Icon } from './Icon'

/** Newest first; older ones still time out, they are just not drawn. */
const MAX_VISIBLE = 4

const stack: CSSProperties = {
  position: 'fixed',
  right: SCALE.space4,
  // Clear of the 52px page bar.
  bottom: 52 + 12,
  // Above the preview overlay (40), below dialogs (1000) and tooltips.
  zIndex: 50,
  display: 'flex',
  flexDirection: 'column-reverse',
  gap: SCALE.space2,
  width: 360,
  maxWidth: `calc(100vw - 2 * ${SCALE.space4})`,
  pointerEvents: 'none'
}

function Toast({ item }: { item: AlertItem }): React.JSX.Element {
  const dismiss = useAlertStore((s) => s.dismiss)
  const warn = item.level === 'warn'
  return (
    <div
      role="status"
      className="vr-toast"
      style={{
        ...panel({ elevated: true }),
        display: 'flex',
        alignItems: 'flex-start',
        gap: SCALE.space2,
        padding: `${SCALE.space2} ${SCALE.space2} ${SCALE.space2} ${SCALE.space3}`,
        borderLeft: `3px solid ${warn ? TOKENS.warn : TOKENS.accent}`,
        fontSize: SCALE.textSm,
        lineHeight: SCALE.leadingNormal,
        color: TOKENS.text,
        pointerEvents: 'auto'
      }}
    >
      <Icon
        name={warn ? 'alert' : 'info'}
        size={14}
        style={{ marginTop: 2, color: warn ? TOKENS.warn : TOKENS.textMuted }}
      />
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
        {item.message}
        {item.count > 1 ? (
          <span style={{ ...mono, marginLeft: SCALE.space2, color: TOKENS.textFaint }}>
            ×{item.count}
          </span>
        ) : null}
      </span>
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

export function AlertToasts(): React.JSX.Element | null {
  const items = useAlertStore((s) => s.items)
  const expireToasts = useAlertStore((s) => s.expireToasts)
  const live = useMemo(() => items.filter((a) => !a.sticky && a.dismissedAt === null), [items])

  // One timer, for whichever toast runs out first. Each expiry changes
  // `items`, which re-arms it for the next. The slack makes sure the first
  // is really due when it fires: a timer that expired nothing would change
  // nothing, and so never be re-armed.
  useEffect(() => {
    if (live.length === 0) return
    const due = Math.min(...live.map((a) => a.surfacedAt + toastMs(a.level)))
    const timer = setTimeout(() => expireToasts(), Math.max(0, due - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [live, expireToasts])

  if (live.length === 0) return null
  // `items` is least recently seen first, and the stack lays out bottom-up,
  // so the newest sits nearest the corner.
  const shown = live.slice(-MAX_VISIBLE).reverse()
  return (
    <div style={stack}>
      {shown.map((a) => (
        <Toast key={a.key} item={a} />
      ))}
    </div>
  )
}
