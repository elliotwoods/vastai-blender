import { useLayoutEffect, useSyncExternalStore } from 'react'
import { mono, segmented } from '../lib/controls'
import type { ClipSyncController } from './ClipSyncController'
import { SPEED_PRESETS, applySpeed, readStoredSpeed, speedLabel } from './speed'

/**
 * Playback speed presets for the transport bar (0.25×–4×). The choice is
 * remembered in localStorage and re-applied to each new controller.
 */
export function SpeedControl({
  controller
}: {
  controller: ClipSyncController
}): React.JSX.Element {
  // Layout effect so a new controller has its remembered speed before the
  // first paint (and before anyone can press play).
  useLayoutEffect(() => {
    controller.setRate(readStoredSpeed())
  }, [controller])

  const rate = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.rate
  )

  return (
    <span style={{ display: 'inline-flex' }} title="Playback speed (< / >)">
      {SPEED_PRESETS.map((p, i) => (
        <button
          key={p}
          style={{
            ...segmented({
              active: p === rate,
              position: i === 0 ? 'first' : i === SPEED_PRESETS.length - 1 ? 'last' : 'middle'
            }),
            ...mono
          }}
          onClick={() => applySpeed(controller, p)}
        >
          {speedLabel(p)}
        </button>
      ))}
    </span>
  )
}
