import { iconBtn } from '../lib/controls'
import { openFolderLabel, revealLabel } from '../lib/platform'
import { Icon } from './Icon'
import { ipc } from '../lib/ipc'

/**
 * The shared click-to-open affordance. `reveal` selects the item in the file
 * manager ("Show in Finder" / "Show in Explorer"); `open` opens the file or
 * folder with its default handler. `title` overrides the tooltip and label.
 */
export function OpenInExplorerButton({
  path,
  mode = 'reveal',
  title
}: {
  path: string
  mode?: 'reveal' | 'open'
  title?: string
}): React.JSX.Element {
  const label = title ?? (mode === 'reveal' ? revealLabel() : openFolderLabel())
  return (
    <button
      title={label}
      aria-label={label}
      style={iconBtn({ size: 'sm' })}
      onClick={(e) => {
        e.stopPropagation()
        void ipc.invoke(mode === 'reveal' ? 'shell:showItemInFolder' : 'shell:openPath', path)
      }}
    >
      {/* An SVG, not the 🗀 glyph, which the app's fonts lack: it drew as a bar. */}
      <Icon name="folder" size={13} />
    </button>
  )
}
