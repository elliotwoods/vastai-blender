import { useEffect, useMemo, useState } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { btn, mono, panel, sectionLabel } from '../../lib/controls'
import { useNav } from '../../lib/nav'
import { usePreview } from '../../lib/preview'
import { useAssetIndex, useJobs } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { chunkIdsOf, pickClip } from '../../media/renditions'
import { useGrade } from '../../media/useGrade'
import { useHdrCapability } from '../../media/useHdrCapability'
import { VideoTile } from '../../media/VideoTile'
import type { ClipAsset } from '../../../../shared/models'

/** Cap simultaneous playing tiles to keep GPU decode load sane. */
const MAX_PLAYING = 12

/**
 * Lazy play/pause for the wall, suspended while the preview overlay is open.
 *
 * `suspended` gates the OBSERVER, not the elements. The playing set is closure
 * state mutated only from observer callbacks, so pausing elements directly
 * would leave all 12 slots marked occupied for as long as the overlay is up,
 * and nothing would resume on close because no intersection change fires.
 */
function useLazyPlayObserver(suspended: boolean): IntersectionObserver {
  const observer = useMemo(() => {
    // Closure-local state (not a ref): only touched from observer callbacks.
    const playing = new Set<HTMLVideoElement>()
    return new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement
          if (e.isIntersecting && playing.size < MAX_PLAYING) {
            playing.add(v)
            void v.play().catch(() => {})
          } else {
            playing.delete(v)
            v.pause()
          }
        }
      },
      { threshold: 0.25 }
    )
  }, [])

  useEffect(() => {
    if (!suspended) return
    // Disconnecting drops every observation, so the set empties as the
    // elements stop being watched; re-observing happens through VideoTile's
    // effect when the overlay closes and the tiles re-register.
    const observed = document.querySelectorAll<HTMLVideoElement>('.vr-tile video')
    observed.forEach((v) => v.pause())
    observer.disconnect()
    return () => {
      observed.forEach((v) => observer.observe(v))
    }
  }, [observer, suspended])

  useEffect(() => () => observer.disconnect(), [observer])
  return observer
}

export function GalleryScreen({
  jobId,
  chunkId
}: {
  jobId?: string
  chunkId?: string
}): React.JSX.Element {
  const { data: jobs } = useJobs()
  const { navigate } = useNav()
  const activeJobId = jobId ?? (jobs ?? []).find((j) => j.framesDone > 0)?.id
  const { data: index } = useAssetIndex(activeJobId)
  const hdrCapable = useHdrCapability()
  const [hdrWall, setHdrWall] = useState(false)
  const grade = useGrade()
  const previewOpen = usePreview((s) => s.target != null)
  const openPreview = usePreview((s) => s.open)
  const observer = useLazyPlayObserver(previewOpen)

  // One clip per chunk for the wall, using the cheap-decode ordering.
  const clips = useMemo(() => {
    const all = (index?.clips ?? []).filter((c) => !chunkId || c.chunkId === chunkId)
    const byChunk = new Map<string, ClipAsset>()
    for (const id of chunkIdsOf(all)) {
      const pick = pickClip(all, { chunkId: id, preferHdr: hdrWall, wall: true })
      if (pick) byChunk.set(id, pick)
    }
    return [...byChunk.values()]
  }, [index, chunkId, hdrWall])

  const jobOptions = (jobs ?? []).filter((j) => j.framesDone > 0 || j.state === 'complete')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar
        left={
          <>
            <span style={sectionLabel()}>gallery</span>
            {jobOptions.map((j) => (
              <button
                key={j.id}
                style={btn({ size: 'sm', active: j.id === activeJobId })}
                onClick={() => navigate({ screen: 'gallery', jobId: j.id })}
              >
                {j.name}
              </button>
            ))}
          </>
        }
        right={
          hdrCapable ? (
            <button
              title="Prefer HDR renditions"
              style={btn({ size: 'sm', active: hdrWall })}
              onClick={() => setHdrWall(!hdrWall)}
            >
              HDR
            </button>
          ) : undefined
        }
        subRow={
          chunkId ? (
            <>
              <button
                style={btn({ variant: 'ghost', size: 'sm' })}
                onClick={() => navigate({ screen: 'gallery', jobId: activeJobId })}
              >
                all chunks
              </button>
              <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
                {chunkId}
              </span>
            </>
          ) : undefined
        }
      />
      <div style={{ flex: 1, overflow: 'auto', padding: SCALE.space4, minHeight: 0 }}>
        {clips.length === 0 ? (
          <div style={{ ...panel(), padding: SCALE.space6, textAlign: 'center' }}>
            <span style={{ color: TOKENS.textFaint }}>
              {activeJobId
                ? 'No preview clips downloaded yet — they appear as chunks finish encoding.'
                : 'No renders yet. The gallery fills as preview clips arrive.'}
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: SCALE.space3
            }}
          >
            {clips.map((c) => (
              <VideoTile
                // Keyed by chunk, not by path: there is exactly one tile per
                // chunk, and the picked rendition's path CHANGES when the HDR
                // wall is toggled — keying on it would remount every tile
                // (tearing down its video element) instead of re-rendering.
                key={c.chunkId}
                clip={c}
                hdrMode={hdrWall && hdrCapable && c.hdr}
                grade={grade}
                observer={observer}
                onExpand={() => openPreview({ jobId: activeJobId as string, chunkId: c.chunkId })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
