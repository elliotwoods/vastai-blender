import { useCallback, useEffect, useRef, useState } from 'react'
import { mono } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import { OpenInExplorerButton } from '../components/OpenInExplorerButton'
import type { ClipAsset } from '../../../shared/models'
import type { ClipSyncController } from './ClipSyncController'
import { GradeCanvas } from './GradeCanvas'
import { gradeToFilter, hasShaderOnly, type Grade } from './grade'
import { useClipPresentation } from './useHdrCapability'

/**
 * One looping muted clip tile. Consumes the presentation hook (which owns the
 * HDR remount rule and picks which of the three graders applies) and registers
 * itself with the shared sync controller when one is provided (inspector mode).
 */
export function VideoTile({
  clip,
  hdrMode,
  grade,
  graded = false,
  fit = 'width',
  onHistogram,
  controller,
  observer,
  onExpand
}: {
  clip: ClipAsset
  hdrMode: boolean
  grade: Grade
  /**
   * 'width' fills the column (wall tiles). 'contain' fits inside the available
   * box without overflowing it — the tile takes the CLIP's aspect ratio rather
   * than letterboxing inside a fixed box, so the grading canvas (which is an
   * absolute overlay on the tile) still lines up with the picture exactly.
   */
  fit?: 'width' | 'contain'
  /**
   * Opt in to the WebGL grading canvas. Wall tiles leave this false: their
   * source is the 8-bit proxy, so a shader buys no precision there, and a wall
   * of canvases would take every video off the compositor's overlay path and
   * burn through Chromium's ~16 live GL contexts.
   */
  graded?: boolean
  /** Forwarded to the grading canvas; only set when a histogram is shown. */
  onHistogram?: (bins: Float32Array | null) => void
  controller?: ClipSyncController
  /** Shared IntersectionObserver for lazy play/pause (wall mode). */
  observer?: IntersectionObserver
  onExpand?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  // Sticky. Once GL is known bad (no WebGL2, link failure, context lost) this
  // tile stays on the CSS filter for the session — flapping between graders
  // mid-scrub would be worse than either one.
  const [glFailed, setGlFailed] = useState(false)
  const onGlUnavailable = useCallback((reason: string) => {
    console.warn('[grade] falling back to CSS filter:', reason)
    setGlFailed(true)
  }, [])

  const { key, filterStyle, canvas } = useClipPresentation({
    hdrMode,
    graded: graded && !glFailed,
    filter: gradeToFilter(grade)
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let unregister: (() => void) | undefined
    let cancelled = false
    let restore: (() => void) | undefined
    if (controller) {
      unregister = controller.register(el)
      restore = (): void => {
        if (cancelled) return
        // Read `lastKnownFrame` HERE, at apply time, not when the effect ran.
        // It is the transport's own state and never derived from an element, so
        // it is right even when the frame to restore to was only resolved after
        // this effect — which is the normal case for "open at frame N", where
        // the clip index arrives before the job that defines the chunk's frame
        // range. (Reading `currentFrame` late would be wrong: that one does come
        // from the element, which sits at 0 until this seek.)
        if (!controller.playing) controller.seekFrame(controller.lastKnownFrame)
        else void el.play().catch(() => {})
      }
      // Changing `src` resets the element to paused at t=0 and discards
      // metadata, and seeking before the new file's duration is known is
      // dropped — so wait for it when it isn't there yet.
      if (el.readyState >= 1) restore()
      else el.addEventListener('loadedmetadata', restore, { once: true })
    } else if (observer) {
      observer.observe(el)
    } else {
      void el.play().catch(() => {})
    }
    return () => {
      cancelled = true
      if (restore) el.removeEventListener('loadedmetadata', restore)
      unregister?.()
      if (observer) observer.unobserve(el)
    }
    // key: remounting the <video> (HDR toggle) must re-register.
    // clip.mediaUrl: each rolling live-preview version arrives as a NEW file,
    // which only swaps `src` — no remount — so without this the element was
    // left paused at frame 0 while the controller still believed it was
    // playing, and playback never resumed.
  }, [controller, observer, key, clip.mediaUrl])

  // CSS path carrying a grade the CSS path cannot express — say so rather than
  // show a quietly different picture from the one the inspector shows.
  const approximated = !canvas && !hdrMode && hasShaderOnly(grade)

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: SCALE.radiusMd,
        overflow: 'hidden',
        border: `1px solid ${TOKENS.border}`,
        background: '#000',
        ...(fit === 'contain' && clip.width > 0 && clip.height > 0
          ? {
              aspectRatio: `${clip.width} / ${clip.height}`,
              maxWidth: '100%',
              maxHeight: '100%',
              margin: 'auto',
              minHeight: 0
            }
          : {})
      }}
      className="vr-tile"
    >
      <video
        key={key}
        ref={ref}
        src={clip.mediaUrl}
        // Required for the shader path: without it the element is
        // cross-origin-tainted (media:// is a different origin) and
        // texImage2D refuses it. The media: protocol answers with
        // Access-Control-Allow-Origin, so this succeeds. Set unconditionally
        // so toggling `graded` never has to reload the element.
        crossOrigin="anonymous"
        muted
        loop
        playsInline
        // The inspector buffers, the wall does not. A `preload="metadata"`
        // element stops at readyState 1, where Chromium knows the duration but
        // silently DROPS seeks — and it will not fetch more data unless asked, so
        // a paused seek can never land and `canplay` never fires. That is fine
        // for a dozen wall tiles you are only glancing at, but the overlay is a
        // clip you are about to scrub, and it is the surface where opening at a
        // frame and arrow-key stepping have to work. `controller` is only ever
        // passed by the overlay.
        preload={controller ? 'auto' : 'metadata'}
        data-fps={clip.fps}
        data-frames={clip.frames}
        data-quality={`${clip.width}×${clip.height} · ${clip.codec} · ${clip.hdr ? 'HDR HLG' : 'SDR'}`}
        style={{
          width: '100%',
          display: 'block',
          filter: filterStyle,
          ...(fit === 'contain' ? { height: '100%', objectFit: 'contain' as const } : {})
        }}
      />
      {canvas ? (
        <GradeCanvas
          videoRef={ref}
          videoKey={key}
          grade={grade}
          transfer={clip.hdr ? 'hlg' : 'srgb'}
          onUnavailable={onGlUnavailable}
          onHistogram={onHistogram}
        />
      ) : null}
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
        {approximated ? (
          <span
            title="Approximate — exposure, gamma and white balance are shader-only; open the inspector to see them applied"
            style={{ ...mono, fontSize: 'var(--text-2xs)', color: TOKENS.warn }}
          >
            ~
          </span>
        ) : null}
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
