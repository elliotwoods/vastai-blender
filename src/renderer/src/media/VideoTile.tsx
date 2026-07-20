import { useEffect, useRef } from 'react'
import { mono } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import { OpenInExplorerButton } from '../components/OpenInExplorerButton'
import type { ClipAsset } from '../../../shared/models'
import type { ClipSyncController } from './ClipSyncController'
import { useVideoPresentation } from './useHdrCapability'

/**
 * One looping muted clip tile. Consumes the HDR presentation hook (the
 * remount-on-HDR rule) and registers itself with the shared sync controller
 * when one is provided (inspector mode).
 */
export function VideoTile({
  clip,
  hdrMode,
  gradeFilter,
  controller,
  observer,
  onExpand
}: {
  clip: ClipAsset
  hdrMode: boolean
  gradeFilter: string
  controller?: ClipSyncController
  /** Shared IntersectionObserver for lazy play/pause (wall mode). */
  observer?: IntersectionObserver
  onExpand?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const { key, filterStyle } = useVideoPresentation(hdrMode, gradeFilter)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let unregister: (() => void) | undefined
    if (controller) {
      unregister = controller.register(el)
      // Paused controller: align this late joiner to the current frame.
      if (!controller.playing) controller.seekFrame(controller.currentFrame)
      else void el.play().catch(() => {})
    } else if (observer) {
      observer.observe(el)
    } else {
      void el.play().catch(() => {})
    }
    return () => {
      unregister?.()
      if (observer) observer.unobserve(el)
    }
    // key in deps: remounting the <video> (HDR toggle) must re-register.
  }, [controller, observer, key])

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: SCALE.radiusMd,
        overflow: 'hidden',
        border: `1px solid ${TOKENS.border}`,
        background: '#000'
      }}
      className="vr-tile"
    >
      <video
        key={key}
        ref={ref}
        src={clip.mediaUrl}
        muted
        loop
        playsInline
        preload="metadata"
        data-fps={clip.fps}
        data-frames={clip.frames}
        data-quality={`${clip.width}×${clip.height} · ${clip.codec} · ${clip.hdr ? 'HDR HLG' : 'SDR'}`}
        style={{ width: '100%', display: 'block', filter: filterStyle }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space2,
          padding: '4px 8px',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.7))'
        }}
      >
        <span
          style={{ ...mono, fontSize: 'var(--text-2xs)', color: TOKENS.textSecondary, flex: 1 }}
        >
          {clip.label}
        </span>
        <OpenInExplorerButton path={clip.absPath} />
        {onExpand ? (
          <button
            title="Inspect"
            style={{ cursor: 'pointer', color: TOKENS.text, fontSize: 13 }}
            onClick={onExpand}
          >
            ⤢
          </button>
        ) : null}
      </div>
    </div>
  )
}
