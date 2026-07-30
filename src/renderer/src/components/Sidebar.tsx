import type { CSSProperties } from 'react'
import { TOKENS } from '../lib/theme'
import { iconBtn } from '../lib/controls'
import { useNav, type Route } from '../lib/nav'

interface Item {
  key: Route['screen']
  title: string
  glyph: string
  route: Route
}

const ITEMS: Item[] = [
  { key: 'fleet', title: 'Fleet', glyph: '⬡', route: { screen: 'fleet' } },
  { key: 'jobs', title: 'Jobs', glyph: '☰', route: { screen: 'jobs' } },
  { key: 'gallery', title: 'Gallery', glyph: '▦', route: { screen: 'gallery' } },
  { key: 'history', title: 'History', glyph: '◷', route: { screen: 'history' } },
  { key: 'settings', title: 'Settings', glyph: '⚙', route: { screen: 'settings' } }
]

const rail: CSSProperties = {
  width: 48,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  padding: '10px 0',
  borderRight: `1px solid ${TOKENS.border}`,
  background: TOKENS.surface
}

export function Sidebar(): React.JSX.Element {
  const { route, navigate } = useNav()
  // 'job' detail lives under the Jobs section for highlighting purposes.
  const activeKey = route.screen === 'job' ? 'jobs' : route.screen
  return (
    <nav style={rail}>
      {ITEMS.map((item) => (
        <button
          key={item.key}
          title={item.title}
          style={{ ...iconBtn({ active: item.key === activeKey }), fontSize: 15 }}
          onClick={() => navigate(item.route)}
        >
          {item.glyph}
        </button>
      ))}
    </nav>
  )
}
