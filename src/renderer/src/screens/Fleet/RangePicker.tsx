/**
 * The window a Fleet usage graph covers: 15m / 1h / 6h / 24h, as segmented
 * buttons like History's. useStoredRange keeps the choice.
 */

import { segmented } from '../../lib/controls'
import { USAGE_RANGES, type UsageRange } from '../../lib/usageRange'

export function RangePicker({
  value,
  onChange,
  label
}: {
  value: UsageRange
  onChange: (r: UsageRange) => void
  /** what the buttons set the window of, for screen readers */
  label: string
}): React.JSX.Element {
  return (
    <span role="group" aria-label={label} style={{ display: 'flex' }}>
      {USAGE_RANGES.map((r, i) => (
        <button
          key={r.key}
          type="button"
          aria-pressed={r.key === value}
          style={segmented({
            active: r.key === value,
            position: i === 0 ? 'first' : i === USAGE_RANGES.length - 1 ? 'last' : 'middle'
          })}
          // Inside a click-to-expand row in NodeDetail: never toggle the row.
          onClick={(e) => {
            e.stopPropagation()
            onChange(r.key)
          }}
        >
          {r.label}
        </button>
      ))}
    </span>
  )
}
