/**
 * The one thumbnail primitive: a frame preview, or an honest placeholder
 * saying why there isn't one yet.
 *
 * Deliberately an `<img>`, never a `<video>` poster. A filmstrip window is
 * ~40 cells and the Fleet list a dozen rows; a video element per cell would
 * hold a decoder each, and GalleryScreen already caps concurrent playback at
 * 12 for exactly that reason.
 *
 * The absent state carries information: a gap tinted with its chunk's status
 * tone says *why* the frame isn't there (queued / rendering / failed), which
 * is the difference between "not yet" and "went wrong".
 */

import { CHUNK_TONE, SCALE, STATUS_VARS, TOKENS } from '../lib/theme'
import type { ChunkState } from '../../../shared/models'

/** States where a missing thumbnail means "in progress", not "never coming". */
const WORKING: ChunkState[] = ['rendering', 'encoding', 'downloading']

export function Thumb({
  url,
  width,
  height,
  state,
  label,
  title,
  onClick,
  onDoubleClick,
  selected = false
}: {
  url: string | null
  width: number
  height: number
  /** Owning chunk's state — drives the placeholder's vocabulary. */
  state?: ChunkState
  /** Small caption drawn over the bottom edge (frame number, usually). */
  label?: string
  title?: string
  onClick?: () => void
  onDoubleClick?: () => void
  selected?: boolean
}): React.JSX.Element {
  const tone = state ? STATUS_VARS[CHUNK_TONE[state]] : null
  const working = !!state && WORKING.includes(state)
  const failed = state === 'failed'

  return (
    <div
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        position: 'relative',
        width,
        height,
        flexShrink: 0,
        overflow: 'hidden',
        borderRadius: SCALE.radiusSm,
        background: '#000',
        border: `1px solid ${selected ? TOKENS.accent : failed ? STATUS_VARS.error.border : TOKENS.border}`,
        outline: selected ? `1px solid ${TOKENS.accent}` : undefined,
        cursor: onClick ? 'pointer' : 'default'
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div
          className={working ? 'vr-thumb-working' : undefined}
          style={{
            width: '100%',
            height: '100%',
            background: failed
              ? STATUS_VARS.error.fill
              : `repeating-linear-gradient(45deg, ${TOKENS.surface} 0 4px, ${TOKENS.surfaceRaised} 4px 8px)`,
            display: 'grid',
            placeItems: 'center',
            color: tone?.text ?? TOKENS.textFaint,
            fontSize: SCALE.text2xs
          }}
        >
          {failed ? '!' : null}
        </div>
      )}
      {label ? (
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '1px 3px',
            fontSize: 'var(--text-2xs)',
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
            color: selected ? TOKENS.accent : TOKENS.textSecondary,
            background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
            pointerEvents: 'none'
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  )
}
