/**
 * The job's picture, large, at the top of the job screen: a click (or P)
 * opens the preview overlay to watch the whole thing. It shows the job's
 * stitched clip when there is one, else the clip of the chunk the Preview
 * button would open, else the newest thumbnail. Held on its first frame (or
 * the frame picked in the filmstrip); hovering plays it, muted, so the card
 * says what the render looks like in motion without costing a decoder while
 * nobody is looking at it.
 */

import { useEffect, useRef } from 'react'
import { Icon } from '../../components/Icon'
import { mono } from '../../lib/controls'
import { useAssetIndex } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { segmentIndexOf } from '../../media/frame-domain'
import type { ChunkSnapshot, JobDetail } from '../../../../shared/models'
import { cardClip } from './jobDetailModel'

export function JobPreviewCard({
  job,
  startChunk,
  frame,
  canPreview,
  onOpen,
  maxHeight
}: {
  job: JobDetail
  /** the chunk the Preview button opens at (previewChunk) */
  startChunk: ChunkSnapshot | null
  /** the frame picked in the filmstrip, to hold the card on */
  frame?: number
  canPreview: boolean
  onOpen: () => void
  /** px cap on the card's height; its width follows the clip's aspect */
  maxHeight?: number
}): React.JSX.Element {
  const { data: assets } = useAssetIndex(job.id)
  const clip = cardClip(assets?.clips ?? [], startChunk)
  const videoRef = useRef<HTMLVideoElement>(null)

  // The clip's index for the picked frame, when the clip holds it.
  const holdIndex = (() => {
    if (!clip || frame == null) return 0
    if (clip.scope === 'job') return segmentIndexOf(clip.segments ?? [], job.frameStep, frame) ?? 0
    const at = startChunk ? Math.round((frame - startChunk.frameStart) / job.frameStep) : 0
    return at >= 0 && at < clip.frames ? at : 0
  })()

  // Hold on the picked frame while not hovered. A hair past the frame's start,
  // or Chromium shows the frame before it.
  const holdAt = clip ? (holdIndex + 0.5) / (clip.fps || 25) : 0
  useEffect(() => {
    const v = videoRef.current
    if (!v || !v.paused) return
    v.currentTime = holdAt
  }, [holdAt, clip?.mediaUrl])

  const aspect = clip && clip.width > 0 && clip.height > 0 ? clip.width / clip.height : 16 / 9
  const caption = clip
    ? clip.scope === 'job'
      ? `whole job · ${clip.frames} frames`
      : `${startChunk ? `frames ${startChunk.frameStart}–${startChunk.frameEnd}` : 'chunk'}${
          clip.kind === 'live' ? ' · live' : ''
        }`
    : job.thumbUrl
      ? 'latest frame'
      : null

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!canPreview}
      aria-label="Open the preview"
      title={canPreview ? 'Open the preview (P)' : 'Nothing rendered yet'}
      onMouseEnter={() => void videoRef.current?.play().catch(() => undefined)}
      onMouseLeave={() => {
        const v = videoRef.current
        if (!v) return
        v.pause()
        v.currentTime = holdAt
      }}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        // The clip's own shape, as wide as the column allows under the cap.
        aspectRatio: String(aspect),
        maxHeight,
        padding: 0,
        border: `1px solid ${TOKENS.border}`,
        borderRadius: SCALE.radiusMd,
        overflow: 'hidden',
        background: '#000',
        cursor: canPreview ? 'pointer' : 'default'
      }}
    >
      {clip ? (
        <video
          ref={videoRef}
          src={clip.mediaUrl}
          poster={job.thumbUrl ?? undefined}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = holdAt
          }}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      ) : job.thumbUrl ? (
        <img
          src={job.thumbUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            fontSize: SCALE.textXs,
            color: TOKENS.textFaint
          }}
        >
          Nothing rendered yet.
        </span>
      )}
      {canPreview ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 52,
            height: 52,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.35)',
            color: '#fff'
          }}
        >
          <Icon name="play" size={22} />
        </span>
      ) : null}
      {caption ? (
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            justifyContent: 'space-between',
            gap: SCALE.space2,
            padding: '14px 10px 6px',
            background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
            ...mono,
            fontSize: 'var(--text-2xs)',
            color: 'rgba(255,255,255,0.85)',
            textAlign: 'left'
          }}
        >
          <span>{caption}</span>
          {frame != null ? <span>frame {frame}</span> : null}
        </span>
      ) : null}
    </button>
  )
}
