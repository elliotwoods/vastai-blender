import { TOKENS } from '../lib/theme'
import { Icon } from './Icon'

/**
 * The small × inside a removable `chip()` (GPU allowlist, picked scenes). An
 * SVG cross rather than the × glyph, so it sits centred on the chip's text
 * line in every font; `label` names the thing removed for screen readers.
 */
export function ChipRemoveButton({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      title={`Remove ${label}`}
      aria-label={`Remove ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: 2,
        marginLeft: 2,
        cursor: 'pointer',
        color: TOKENS.textMuted
      }}
      onClick={onClick}
    >
      <Icon name="cross" size={10} />
    </button>
  )
}
