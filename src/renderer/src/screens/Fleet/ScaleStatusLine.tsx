/**
 * One line on the Fleet: why scale-up is or is not renting, as the
 * scheduler last decided (scaleStatus.ts). Quiet when all is as it should
 * be; amber, with a way to the setting, when the user's own limit stops it.
 */

import { btn } from '../../lib/controls'
import { useNav } from '../../lib/nav'
import { useScaleStatus } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { Icon } from '../../components/Icon'
import { scaleLine } from './scaleStatus'

export function ScaleStatusLine(): React.JSX.Element | null {
  const { data } = useScaleStatus()
  const navigate = useNav((s) => s.navigate)
  const line = scaleLine(data)
  if (!line) return null
  const warn = line.tone === 'warn'
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space2,
        fontSize: SCALE.textXs,
        color: warn ? TOKENS.warnSoftText : TOKENS.textMuted
      }}
    >
      <Icon name="activity" size={12} style={{ color: warn ? TOKENS.warn : TOKENS.textFaint }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.text}</span>
      {line.spendCap ? (
        <button
          style={{ ...btn({ variant: 'ghost', size: 'sm' }), padding: '1px 6px' }}
          onClick={() => navigate({ screen: 'settings', section: 'api' })}
        >
          spend cap settings
        </button>
      ) : null}
    </div>
  )
}
