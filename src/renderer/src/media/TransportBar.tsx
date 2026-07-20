import { useEffect, useState } from 'react'
import { iconBtn, mono, panel, quietField } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import type { ClipSyncController } from './ClipSyncController'
import { formatTimecode } from './frame-math'
import { FrameRuler } from './FrameRuler'

/**
 * The docked transport bar:
 * ⏮ ⏪ ▶/⏸ ⏩ ⏭ │ MM:SS:FF │ [frame]/total │ ═ FrameRuler ═ │ quality readout
 * Keyboard (bound while mounted): Space, ←/→, Shift±10, Home/End.
 */
export function TransportBar({
  controller,
  quality
}: {
  controller: ClipSyncController
  quality: string
}): React.JSX.Element {
  const [frame, setFrame] = useState(controller.currentFrame)
  const [playing, setPlaying] = useState(controller.playing)
  const [frameInput, setFrameInput] = useState<string | null>(null)
  const { fps, totalFrames } = controller.meta

  useEffect(() => {
    const off = controller.subscribe((f, p) => {
      setFrame(f)
      setPlaying(p)
    })
    return off
  }, [controller])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          controller.toggle()
          break
        case 'ArrowLeft':
          e.preventDefault()
          controller.step(e.shiftKey ? -10 : -1)
          break
        case 'ArrowRight':
          e.preventDefault()
          controller.step(e.shiftKey ? 10 : 1)
          break
        case 'Home':
          e.preventDefault()
          controller.first()
          break
        case 'End':
          e.preventDefault()
          controller.last()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller])

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
    </div>
  )
}
