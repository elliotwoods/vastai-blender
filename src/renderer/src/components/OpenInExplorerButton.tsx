import { iconBtn } from '../lib/controls'
import { ipc } from '../lib/ipc'

/**
 * The shared click-to-open affordance. `reveal` selects the item in Explorer;
 * `open` opens the file/folder with its default handler.
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
  return (
    <button
      title={title ?? (mode === 'reveal' ? 'Reveal in Explorer' : 'Open')}
      style={iconBtn({ size: 'sm' })}
      onClick={(e) => {
        e.stopPropagation()
        void ipc.invoke(mode === 'reveal' ? 'shell:showItemInFolder' : 'shell:openPath', path)
      }}
    >
      🗀
    </button>
  )
}
