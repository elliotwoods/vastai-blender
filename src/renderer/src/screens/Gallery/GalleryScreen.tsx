import { useEffect, useMemo, useRef, useState } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { btn, iconBtn, mono, panel, sectionLabel } from '../../lib/controls'
import { fmtBytes } from '../../lib/format'
import { ipc } from '../../lib/ipc'
import { useNav } from '../../lib/nav'
import { useAssetIndex, useJobs } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import { ClipSyncController } from '../../media/ClipSyncController'
import { gradeToFilter } from '../../media/grade'
import { GradePanel } from '../../media/GradePanel'
import { TransportBar } from '../../media/TransportBar'
import { useGrade } from '../../media/useGrade'
import { useHdrCapability } from '../../media/useHdrCapability'
import { VideoTile } from '../../media/VideoTile'
import type { ClipAsset } from '../../../../shared/models'

/** Cap simultaneous playing tiles to keep GPU decode load sane. */
const MAX_PLAYING = 12

function useLazyPlayObserver(): IntersectionObserver {
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
  useEffect(() => () => observer.disconnect(), [observer])
  return observer
}

function Inspector({
  clip,
  frames,
  onClose
}: {
  clip: ClipAsset
  frames: Array<{ frame: number; absPath: string; sizeBytes: number }>
  onClose: () => void
}): React.JSX.Element {
  const hdrCapable = useHdrCapability()
  const [hdrMode, setHdrMode] = useState(false)
  const [showGrade, setShowGrade] = useState(false)
  const grade = useGrade()
  const [currentFrame, setCurrentFrame] = useState(0)

  const controller = useMemo(
    () => new ClipSyncController({ fps: clip.fps, totalFrames: clip.frames }),
    [clip.fps, clip.frames]
  )
  useEffect(() => {
    const off = controller.subscribe((f) => setCurrentFrame(f))
    return () => {
      off()
      controller.destroy()
    }
  }, [controller])

  const effectiveHdr = hdrMode && hdrCapable
  const quality = `${clip.width}×${clip.height} · ${clip.codec} · ${effectiveHdr ? 'HDR HLG' : 'SDR'}`
  const frameStripRef = useRef<HTMLDivElement>(null)

  // Keep the current frame's strip entry in view.
  useEffect(() => {
    const el = frameStripRef.current?.querySelector<HTMLElement>(`[data-frame="${currentFrame}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [currentFrame])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3,
        height: '100%',
        minHeight: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2 }}>
        <button style={btn({ variant: 'ghost', size: 'sm' })} onClick={onClose}>
          ← wall
        </button>
        <span style={{ ...mono, fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
          {clip.label}
        </span>
        <span style={{ flex: 1 }} />
        {hdrCapable && clip.hdr ? (
          <button
            title="HDR passthrough (disables grading)"
            style={btn({ size: 'sm', active: hdrMode })}
            onClick={() => setHdrMode(!hdrMode)}
          >
            HDR
          </button>
        ) : null}
        <button
          title="Grade panel"
          style={iconBtn({ size: 'sm', active: showGrade })}
          onClick={() => setShowGrade(!showGrade)}
        >
          ◑
        </button>
      </div>

      <div style={{ display: 'flex', gap: SCALE.space3, flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center'
          }}
        >
          <div style={{ maxWidth: 'min(100%, 78vh)', width: '100%' }}>
            <VideoTile
              clip={clip}
              hdrMode={effectiveHdr}
              gradeFilter={gradeToFilter(grade)}
              controller={controller}
            />
          </div>
        </div>
        {showGrade ? <GradePanel hdrMode={effectiveHdr} /> : null}
      </div>

      <TransportBar controller={controller} quality={quality} />

      {frames.length > 0 ? (
        <div
          ref={frameStripRef}
          style={{
            ...panel(),
            display: 'flex',
            gap: 2,
            padding: SCALE.space2,
            overflowX: 'auto',
            flexShrink: 0
          }}
        >
          {frames.map((f, i) => (
            <button
              key={f.frame}
              data-frame={i}
              title={`${f.absPath} (${fmtBytes(f.sizeBytes)}) — click to seek, double-click to open`}
              onClick={() => controller.seekFrame(i)}
              onDoubleClick={() => void ipc.invoke('shell:openPath', f.absPath)}
              style={{
                ...mono,
                fontSize: 'var(--text-2xs)',
                padding: '3px 6px',
                borderRadius: 4,
                cursor: 'pointer',
                background: i === currentFrame ? TOKENS.accent : TOKENS.surface,
                color: i === currentFrame ? TOKENS.accentFg : TOKENS.textMuted,
                border: `1px solid ${i === currentFrame ? TOKENS.accent : TOKENS.border}`,
                flexShrink: 0
              }}
            >
              {f.frame}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
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
  const [expanded, setExpanded] = useState<string | null>(null)
  const observer = useLazyPlayObserver()

  const clips = useMemo(() => {
    let all = index?.clips ?? []
    if (chunkId) all = all.filter((c) => c.chunkId === chunkId)
    // Wall shows the small proxies; HDR wall shows HDR clips when present.
    const kind = hdrWall ? 'previewHdr' : 'proxy'
    const preferred = all.filter((c) => c.kind === kind)
    return preferred.length > 0 ? preferred : all.filter((c) => c.kind === 'previewSdr')
  }, [index, chunkId, hdrWall])

  const expandedClip = useMemo(() => {
    if (!expanded || !index) return null
    // Inspect the best rendition of the expanded chunk: HDR > SDR > proxy.
    const of = index.clips.filter((c) => c.chunkId === expanded)
    return (
      of.find((c) => c.kind === (hdrWall ? 'previewHdr' : 'previewSdr')) ??
      of.find((c) => c.kind === 'previewSdr') ??
      of[0] ??
      null
    )
  }, [expanded, index, hdrWall])

  const expandedFrames = useMemo(() => {
    if (!expandedClip || !index) return []
    return index.frames
      .filter((f) => f.chunkId === expandedClip.chunkId)
      .sort((a, b) => a.frame - b.frame)
  }, [expandedClip, index])

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
        {expandedClip ? (
          <Inspector
            clip={expandedClip}
            frames={expandedFrames}
            onClose={() => setExpanded(null)}
          />
        ) : clips.length === 0 ? (
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
                key={c.absPath}
                clip={c}
                hdrMode={hdrWall && hdrCapable && c.hdr}
                gradeFilter={gradeToFilter(grade)}
                observer={observer}
                onExpand={() => setExpanded(c.chunkId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
