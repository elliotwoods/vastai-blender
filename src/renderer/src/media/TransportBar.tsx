import { useState, useSyncExternalStore } from 'react'
import { iconBtn, mono, panel, quietField } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import type { ClipSyncController } from './ClipSyncController'
import { formatTimecode } from './frame-math'
import { FrameRuler } from './FrameRuler'
import { useTransportKeys } from './useTransportKeys'

/**
 * The docked transport bar:
 * ⏮ ⏪ ▶/⏸ ⏩ ⏭ │ MM:SS:FF │ [frame]/total │ ═ FrameRuler ═ │ quality readout
 * Keyboard (bound while mounted): Space, ←/→, Shift±10, Home/End.
 */
export function TransportBar({
  controller,
  quality,
  keysEnabled = true,
  extras
}: {
  controller: ClipSyncController
  quality: string
  /** Bind the global transport keys. Off when another surface owns them. */
  keysEnabled?: boolean
  /** Extra controls rendered at the right-hand end (LIVE pill, HDR toggle…). */
  extras?: React.ReactNode
}): React.JSX.Element {
  const [frameInput, setFrameInput] = useState<string | null>(null)
  // An external store, not local state synced by an effect: notifications that
  // fire before this component subscribes are otherwise lost, and one does —
  // sibling effects run in tree order, so the seek that opens the overlay at a
  // requested frame happens in VideoTile's effect, above this one. Snapshotting
  // `lastKnownFrame` (the transport's own position, never read from an element)
  // means the first render is already correct however the ordering falls.
  const frame = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.lastKnownFrame
  )
  const playing = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.playing
  )
  // Subscribed, NOT destructured from controller.meta at mount: a live clip
  // grows, so its fps/totalFrames change under a mounted bar, and a once-only
  // read left the ruler scaled to whatever the first version was.
  // `meta` is a stable reference between setMeta() calls, so this is a valid
  // external-store snapshot.
  const { fps, totalFrames } = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.meta
  )

  useTransportKeys(controller, keysEnabled)

  const commitFrameInput = (): void => {
    if (frameInput != null) {
      const n = parseInt(frameInput, 10)
      if (Number.isFinite(n)) controller.seekFrame(n)
    }
    setFrameInput(null)
  }

  return (
    <div
      style={{
        ...panel(),
        display: 'flex',
        alignItems: 'center',
        gap: SCALE.space3,
        padding: `6px ${SCALE.space3}`
      }}
    >
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <button
          title="First (Home)"
          style={iconBtn({ size: 'sm' })}
          onClick={() => controller.first()}
        >
          ⏮
        </button>
        <button
          title="Back 10 (Shift+←)"
          style={iconBtn({ size: 'sm' })}
          onClick={() => controller.step(-10)}
        >
          ⏪
        </button>
        <button
          title="Play/Pause (Space)"
          style={iconBtn({ size: 'sm', active: playing })}
          onClick={() => controller.toggle()}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          title="Fwd 10 (Shift+→)"
          style={iconBtn({ size: 'sm' })}
          onClick={() => controller.step(10)}
        >
          ⏩
        </button>
        <button
          title="Last (End)"
          style={iconBtn({ size: 'sm' })}
          onClick={() => controller.last()}
        >
          ⏭
        </button>
      </span>

      <span style={{ ...mono, fontSize: SCALE.textSm, color: TOKENS.textSecondary, minWidth: 66 }}>
        {formatTimecode(frame, fps)}
      </span>

      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
        {frameInput != null ? (
          <input
            autoFocus
            value={frameInput}
            onChange={(e) => setFrameInput(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitFrameInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitFrameInput()
              if (e.key === 'Escape') setFrameInput(null)
            }}
            style={{
              ...mono,
              width: 52,
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${TOKENS.accent}`,
              color: TOKENS.text,
              fontSize: SCALE.textSm,
              outline: 'none',
              textAlign: 'right'
            }}
          />
        ) : (
          <button
            style={{ ...quietField(), ...mono, fontSize: SCALE.textSm }}
            onClick={() => setFrameInput(String(frame))}
            title="Click to type a frame number"
          >
            {frame}
          </button>
        )}
        <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          / {totalFrames}
        </span>
      </span>

      <FrameRuler
        frame={frame}
        totalFrames={totalFrames}
        fps={fps}
        onPreview={(f) => controller.dragPreview(f)}
        onCommit={(f) => controller.dragCommit(f)}
      />

      <span
        style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint, whiteSpace: 'nowrap' }}
      >
        {quality}
      </span>
      {extras}
    </div>
  )
}
