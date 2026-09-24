/**
 * The page bar: the app's top-level modes, selected from the bottom of the
 * window. The shape is DaVinci Resolve's page row (and av-frameworks'
 * `PageBar`) — each mode an icon over a short label, centred, the current one
 * lit with an accent rule along its top edge.
 *
 * A tablist: one tab stop, Left/Right (and Home/End) move and select.
 */

import { useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { SCALE, TOKENS } from '../lib/theme'
import { useNav, type Route } from '../lib/nav'
import { Icon, type IconName } from './Icon'

interface Item {
  key: Route['screen']
  title: string
  icon: IconName
  route: Route
}

const ITEMS: Item[] = [
  { key: 'fleet', title: 'Fleet', icon: 'server', route: { screen: 'fleet' } },
  { key: 'jobs', title: 'Jobs', icon: 'list', route: { screen: 'jobs' } },
  { key: 'gallery', title: 'Gallery', icon: 'grid', route: { screen: 'gallery' } },
  { key: 'history', title: 'History', icon: 'activity', route: { screen: 'history' } },
  { key: 'settings', title: 'Settings', icon: 'settings', route: { screen: 'settings' } }
]

// Three columns, `1fr auto 1fr`, so the tabs centre on the window whatever the
// corners come to hold.
const bar: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr',
  alignItems: 'stretch',
  height: 52,
  flexShrink: 0,
  borderTop: `1px solid ${TOKENS.border}`,
  background: TOKENS.surfaceRaised
}

const list: CSSProperties = {
  gridColumn: 2,
  display: 'flex',
  minWidth: 0,
  overflowX: 'auto',
  scrollbarWidth: 'none'
}

const tab: CSSProperties = {
  flex: '0 0 auto',
  display: 'grid',
  gridTemplateRows: 'auto auto',
  justifyItems: 'center',
  alignContent: 'center',
  gap: 4,
  minWidth: 72,
  padding: `0 ${SCALE.space3}`,
  whiteSpace: 'nowrap',
  cursor: 'pointer'
}

const label: CSSProperties = {
  fontSize: SCALE.text2xs,
  fontWeight: SCALE.weightSemibold,
  letterSpacing: '0.12em',
  textTransform: 'uppercase'
}

export function PageBar(): React.JSX.Element {
  const { route, navigate } = useNav()
  const listRef = useRef<HTMLDivElement>(null)
  // 'job' detail lives under the Jobs page for highlighting purposes.
  const activeKey = route.screen === 'job' ? 'jobs' : route.screen

  const onKeyDown = (e: KeyboardEvent, index: number): void => {
    const last = ITEMS.length - 1
    const next =
      e.key === 'ArrowRight'
        ? Math.min(index + 1, last)
        : e.key === 'ArrowLeft'
          ? Math.max(index - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next === null) return
    e.preventDefault()
    navigate(ITEMS[next].route)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  // With no page lit (the dev-only grade lab), the first tab takes the tab stop.
  const stop = Math.max(
    0,
    ITEMS.findIndex((item) => item.key === activeKey)
  )

  return (
    <div style={bar}>
      <div style={list} role="tablist" aria-label="Pages" ref={listRef}>
        {ITEMS.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            className="vr-pagebar-tab"
            aria-selected={item.key === activeKey}
            tabIndex={index === stop ? 0 : -1}
            style={tab}
            onClick={() => navigate(item.route)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            <span className="vr-pagebar-icon" style={{ display: 'grid', placeItems: 'center' }}>
              <Icon name={item.icon} size={20} />
            </span>
            <span style={label}>{item.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
