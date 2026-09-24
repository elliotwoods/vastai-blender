/**
 * Full-window render preview. Mounted once in App, opened from anywhere via
 * lib/preview.ts.
 *
 * An overlay rather than a screen: it has to open from Fleet, Jobs, JobDetail
 * and Gallery and then hand you back an *intact* screen — scroll position,
 * expanded node rows, the gallery wall's playback. A route would unmount
 * whatever was behind it.
 *
 * Degrades all the way down. With no clip yet it shows the newest thumbnail as
 * a still and disables the transport, so opening a chunk that started
 * rendering ten seconds ago still shows you something.
 *
 * Two modes, derived from the target rather than stored:
 * - JOB mode: the target frame is in the job's stitched clip (see
 *   main/transfer/jobClip.ts). One transport spans every complete chunk, so
 *   a job cut into 2-frame chunks still plays as one clip; `[`/`]` and the
 *   filmstrip seek within it instead of remounting.
 * - CHUNK mode: anything else — a chunk still rendering (live clip, still),
 *   or a job with no stitched clip yet. Exactly the per-chunk view.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { btn, iconBtn, mono, panel, sectionLabel, segmented } from '../lib/controls'
import { basename } from '../lib/format'
import { ipc } from '../lib/ipc'
import { useNav } from '../lib/nav'
import { usePreview, type PreviewTarget } from '../lib/preview'
import { useAssetIndex, useJob, useThumbWindow } from '../lib/queries'
import { SCALE, TOKENS } from '../lib/theme'
import { ClipSyncController } from './ClipSyncController'
import { Filmstrip } from './Filmstrip'
import { domainOf, frameAt, indexOf, segmentFrameAt, segmentIndexOf } from './frame-domain'
import { GradePanel } from './GradePanel'
import { pickClip } from './renditions'
import { TransportBar } from './TransportBar'
import { useGrade } from './useGrade'
import { useHdrCapability } from './useHdrCapability'
import { VideoTile } from './VideoTile'

export function PreviewOverlay(): React.JSX.Element | null {
  const target = usePreview((s) => s.target)
  if (!target) return null
  return <ModeSwitch target={target} />
}

/**
 * Decide the mode, and key the overlay on it. Chunk mode keys on the chunk so
 * switching chunks rebuilds the transport cleanly rather than migrating a
 * controller between clips of different lengths; job mode keys on the job, so
 * moving around inside the stitched clip never remounts anything.
 */
function ModeSwitch({ target }: { target: PreviewTarget }): React.JSX.Element {
  const { data: job } = useJob(target.jobId)
  const { data: assets } = useAssetIndex(target.jobId)
  const chunk = job?.chunks.find((c) => c.id === target.chunkId) ?? null
  const hasJobClip = (assets?.clips ?? []).some((c) => c.scope === 'job' && c.segments?.length)
  const focus = target.frame ?? chunk?.frameStart
  const jobSegments = (assets?.clips ?? []).find((c) => c.scope === 'job')?.segments ?? []
  const jobMode =
    hasJobClip && focus != null && segmentIndexOf(jobSegments, job?.frameStep ?? 1, focus) != null
  return (
    <Overlay
      key={jobMode ? `job:${target.jobId}` : `chunk:${target.chunkId}`}
      target={target}
      jobMode={jobMode}
    />
  )
}

function Overlay({
  target,
  jobMode
}: {
  target: PreviewTarget
  jobMode: boolean
}): React.JSX.Element {
  const close = usePreview((s) => s.close)
  const retarget = usePreview((s) => s.retarget)
  const opener = usePreview((s) => s.opener)
  const { navigate } = useNav()
  const { data: job } = useJob(target.jobId)
  const { data: assets } = useAssetIndex(target.jobId)
  const hdrCapable = useHdrCapability()
  const grade = useGrade()
  const [hdrMode, setHdrMode] = useState(false)
  // `&grade=1` opens the drawer on load, matching the other dev URL aids —
  // otherwise the panel is unreachable in a scripted VR_SHOT capture.
  const [showGrade, setShowGrade] = useState(
    () => new URLSearchParams(window.location.search).get('grade') === '1'
  )
  const [histogram, setHistogram] = useState<Float32Array | null>(null)
  /** Requested frame already applied, so it is honoured once and not re-imposed. */
  const appliedFrame = useRef<number | null>(null)

  const clips = useMemo(
    () =>
      (assets?.clips ?? []).filter((c) =>
        jobMode ? c.scope === 'job' : c.scope === 'chunk' && c.chunkId === target.chunkId
      ),
    [assets, target.chunkId, jobMode]
  )
  const step = job?.frameStep ?? 1
  const chunk = job?.chunks.find((c) => c.id === target.chunkId) ?? null
  // Job mode only ever holds complete chunks, so nothing in it is "rendering".
  const rendering = !jobMode && !!chunk && !['complete', 'failed'].includes(chunk.state)
  // Frames the job and this chunk cover. Declared up here because the transport
  // needs `chunkFrames` to convert `target.frame` (a job frame number) into a
  // clip-relative index; the still fallback below uses them too.
  const domain = job ? domainOf(job.frameStart, job.frameEnd, job.frameStep) : domainOf(1, 1, 1)
  const chunkFrames = chunk ? domainOf(chunk.frameStart, chunk.frameEnd, job?.frameStep ?? 1) : null
  const clip = useMemo(
    () =>
      pickClip(clips, {
        scope: jobMode ? 'job' : 'chunk',
        preferHdr: hdrMode && hdrCapable,
        preferLive: rendering
      }),
    [clips, hdrMode, hdrCapable, rendering, jobMode]
  )
  const segments = useMemo(() => (jobMode ? (clip?.segments ?? []) : []), [jobMode, clip])

  /**
   * Clip index ↔ job frame for whichever clip is showing. A chunk clip starts
   * at its chunk's first frame; the job clip skips over incomplete chunks, so
   * it goes through its segments. `toIndex` is null for a frame the clip
   * doesn't hold.
   */
  const toFrame = (index: number): number | undefined =>
    jobMode
      ? segmentFrameAt(segments, step, index)
      : chunkFrames
        ? frameAt(chunkFrames, index)
        : undefined
  const toIndex = (frame: number): number | null => {
    if (jobMode) return segmentIndexOf(segments, step, frame)
    if (!chunkFrames || frame < chunkFrames.start || frame > chunkFrames.end) return null
    return indexOf(chunkFrames, frame)
  }
  /**
   * Whether an HDR rendition EXISTS — not whether one is currently showing.
   * Gating the toggle on `clip.hdr` made it unreachable in the normal case:
   * with hdrMode off, pickClip deliberately ranks previewHdr last, so the
   * picked clip is the SDR one and the only control that could turn HDR on
   * never rendered.
   */
  const hdrAvailable = useMemo(() => clips.some((c) => c.hdr), [clips])

  // Chunk stepping with [ and ], in frame order.
  const siblings = useMemo(
    () => (job?.chunks ?? []).slice().sort((a, b) => a.frameStart - b.frameStart),
    [job]
  )

  const controller = useMemo(
    () =>
      new ClipSyncController({
        fps: clip?.fps || 25,
        totalFrames: clip?.frames || 1
      }),
    // One transport per CHUNK (or per job, in job mode — ModeSwitch keys the
    // whole overlay on that, so the chunk id doesn't need to be a dep). Neither the clip's length nor its KIND rebuilds
    // it: length goes through setMeta, and nothing in the controller is
    // clip-specific (`videos` holds elements, which a kind change only re-srcs,
    // never remounts). Keying on kind meant a chunk finishing — live clip
    // replaced by previewSdr — built a fresh controller at frame -1 and threw
    // the viewer back to the start mid-watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clip?.chunkId]
  )

  useEffect(() => () => controller.destroy(), [controller])

  // Same reasoning as TransportBar: an external store rather than state synced by
  // an effect, so a position set before this subscribes is not missed.
  const currentFrame = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.lastKnownFrame
  )

  const frameNumber = clip ? toFrame(currentFrame) : undefined
  // The chunk under the playhead. In job mode that moves as it plays; in chunk
  // mode it is always the target.
  const current =
    jobMode && frameNumber != null
      ? (siblings.find((c) => frameNumber >= c.frameStart && frameNumber <= c.frameEnd) ?? chunk)
      : chunk
  const at = siblings.findIndex((c) => c.id === current?.id)

  /** Go to a job frame: seek if this clip holds it, else retarget to its chunk. */
  const goToFrame = (frame: number): void => {
    const index = toIndex(frame)
    if (index != null && clip) {
      controller.seekFrame(index)
      return
    }
    const owner = siblings.find((c) => frame >= c.frameStart && frame <= c.frameEnd)
    // Carrying the frame lets ModeSwitch land in job mode when it is covered.
    if (owner) retarget({ jobId: target.jobId, chunkId: owner.id, frame })
  }
  const stepChunk = (delta: number): void => {
    const next = siblings[at + delta]
    if (next) goToFrame(next.frameStart)
  }

  /**
   * The job clip is rebuilt as chunks complete, and a filled gap shifts every
   * index after it. Remember the segments the transport's position was
   * measured against, so a rebuilt clip can put the playhead back on the same
   * JOB frame instead of the same (now different) index.
   */
  const measuredAgainst = useRef<{ path: string; segments: typeof segments } | null>(null)

  /**
   * Retarget the transport at the current clip, then place the playhead.
   *
   * A live clip grows, and a finished chunk swaps rendition — both are handled
   * by `setMeta` rather than by remounting the transport.
   *
   * A LAYOUT effect, and both steps belong in it together. VideoTile's
   * registration is a child PASSIVE effect, so it runs after this one: it
   * captures `lastKnownFrame` and re-applies it once the element has metadata.
   * Setting `meta` first means the frame is clamped against the real clip
   * length instead of the {25, 1} placeholder, and SEEDING the transport here
   * rather than seeking means that restore lands on the requested frame — a
   * seek from here would simply be overwritten by it.
   */
  useLayoutEffect(() => {
    if (clip) controller.setMeta({ fps: clip.fps || 25, totalFrames: clip.frames || 1 })
    if (jobMode && clip) {
      const prev = measuredAgainst.current
      measuredAgainst.current = { path: clip.absPath, segments }
      if (prev && prev.path !== clip.absPath && appliedFrame.current != null) {
        const frame = segmentFrameAt(prev.segments, step, controller.lastKnownFrame)
        const index = segmentIndexOf(segments, step, frame)
        if (index != null) {
          controller.setKnownFrame(index)
          controller.seekFrame(index)
        }
        return
      }
    }
    // Job mode opened from a chunk with no explicit frame: start at the chunk.
    const requested = target.frame ?? (jobMode ? chunk?.frameStart : undefined)
    if (requested == null || (!jobMode && !chunkFrames)) return
    // ONE-SHOT per requested frame. This effect also re-runs when the clip
    // changes (a live clip rolling over, or a finished chunk swapping in its
    // definitive rendition), and re-seeking then would yank the viewer back to
    // where they opened from — undoing their own scrubbing.
    if (appliedFrame.current === requested) return
    // Job mode can't place anything until the job clip (and so its segments)
    // is known; leave the one-shot unspent until then.
    if (jobMode && !clip) return
    appliedFrame.current = requested
    // `requested` is a JOB frame number (a filmstrip click carries one); the
    // clip starts at its chunk's first frame, or skips gaps in job mode, so it
    // has to be converted to a clip-relative index.
    const index = toIndex(requested) ?? 0
    controller.setKnownFrame(index)
    // Seed AND seek: seeking covers an element that is already loaded, while the
    // seed is what a not-yet-loaded one picks up when its metadata arrives.
    controller.seekFrame(index)
    // toIndex/segments/step/chunk derive from clip + job, already deps via clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, clip, chunkFrames, target.frame, jobMode])

  // Escape closes. Bubble phase, with the same input guard the transport uses:
  // a capture listener would eat the Escape that cancels a frame-number edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        e.preventDefault()
        close()
      } else if (e.key === '[') {
        stepChunk(-1)
      } else if (e.key === ']') {
        stepChunk(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Return focus where it came from, so closing doesn't dump you at the top of
  // the document.
  useEffect(() => () => opener?.focus?.(), [opener])

  // Ask the node to build a rolling clip only while this chunk is actually
  // being watched, and stop on close / retarget / unmount. Without the
  // teardown the node keeps encoding previews nobody is looking at.
  useEffect(() => {
    if (!rendering) return
    const chunkId = target.chunkId
    void ipc.invoke('preview:subscribe', { chunkId, on: true })
    return () => {
      void ipc.invoke('preview:subscribe', { chunkId, on: false })
    }
  }, [target.chunkId, rendering])

  const stillThumbs = useThumbWindow(
    job && !clip ? target.jobId : undefined,
    chunkFrames?.start ?? 0,
    chunkFrames?.end ?? 0
  )
  const newestThumb = useMemo(() => {
    if (!chunkFrames) return null
    let found: string | null = null
    for (let i = 0; i < chunkFrames.count; i++) {
      const url = stillThumbs.get(frameAt(chunkFrames, i))
      if (url) found = url
    }
    return found
  }, [chunkFrames, stillThumbs])

  // Name the rendition: a 960px live clip and a native-resolution previewSdr
  // look very different at full size, and without this the difference reads as
  // "the preview is broken" rather than "this is the in-progress one".
  const quality = clip
    ? `${clip.kind === 'live' ? 'live · ' : ''}${clip.width}×${clip.height} · ${clip.codec} · ${
        hdrMode && clip.hdr ? 'HDR HLG' : 'SDR'
      }`
    : 'no clip yet'

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Render preview"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(6,7,9,0.94)',
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3,
        padding: SCALE.space4
      }}
      onClick={(e) => {
        // Click the backdrop to close; clicks inside the panels stop there.
        if (e.target === e.currentTarget) close()
      }}
    >
      {/* -- header ---------------------------------------------------------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2 }}>
        <span style={sectionLabel()}>preview</span>
        <button
          style={{ ...btn({ variant: 'ghost', size: 'sm' }), color: TOKENS.accent }}
          onClick={() => {
            close()
            navigate({ screen: 'job', jobId: target.jobId })
          }}
        >
          {job ? job.name || basename(job.blendPath) : target.jobId.slice(0, 8)}
        </button>
        <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          {current?.id ?? target.chunkId}
        </span>
        {jobMode && clip ? (
          <span
            title="The job's finished chunks stitched into one clip. Chunks still rendering are skipped; click one in the strip to watch it live."
            style={{ ...mono, fontSize: 'var(--text-2xs)', color: TOKENS.textFaint }}
          >
            whole job · {clip.frames} frames
          </span>
        ) : null}
        {rendering ? (
          <span
            title="This chunk is still rendering — the preview grows as frames land"
            style={{
              ...mono,
              fontSize: 'var(--text-2xs)',
              padding: '2px 7px',
              borderRadius: 999,
              background: 'var(--status-running-fill)',
              border: '1px solid var(--status-running-border)',
              color: 'var(--status-running-text)'
            }}
          >
            LIVE
          </span>
        ) : null}

        <span style={{ flex: 1 }} />

        <span style={{ display: 'inline-flex' }}>
          <button
            style={segmented({ active: false, position: 'first' })}
            disabled={at <= 0}
            title="Previous chunk ( [ )"
            onClick={() => stepChunk(-1)}
          >
            [
          </button>
          <button
            style={segmented({ active: false, position: 'last' })}
            disabled={at < 0 || at >= siblings.length - 1}
            title="Next chunk ( ] )"
            onClick={() => stepChunk(1)}
          >
            ]
          </button>
        </span>
        {hdrCapable && hdrAvailable ? (
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
        {clip ? (
          <button
            style={btn({ size: 'sm' })}
            onClick={() => void ipc.invoke('shell:showItemInFolder', clip.absPath)}
          >
            reveal
          </button>
        ) : null}
        <button title="Close (Esc)" style={iconBtn({ size: 'sm' })} onClick={close}>
          ✕
        </button>
      </div>

      {/* -- stage ----------------------------------------------------------- */}
      <div style={{ flex: 1, display: 'flex', gap: SCALE.space3, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {clip ? (
            <div
              style={{
                width: '100%',
                height: '100%',
                minHeight: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <VideoTile
                clip={clip}
                hdrMode={hdrMode && hdrCapable}
                grade={grade}
                graded
                fit="contain"
                controller={controller}
                onHistogram={showGrade ? setHistogram : undefined}
              />
            </div>
          ) : (
            <Still url={newestThumb} rendering={rendering} />
          )}
        </div>
        {showGrade ? (
          <GradePanel
            hdrMode={hdrMode && hdrCapable}
            capability={clip ? 'gl' : 'css'}
            histogram={histogram}
          />
        ) : null}
      </div>

      {/* -- transport + strip ------------------------------------------------ */}
      {clip ? (
        <TransportBar controller={controller} quality={quality} keysEnabled />
      ) : (
        <div style={{ ...panel(), padding: `6px ${SCALE.space3}` }}>
          <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            Transport waits for the first encoded clip.
          </span>
        </div>
      )}

      {job ? (
        <Filmstrip
          jobId={target.jobId}
          frameStart={job.frameStart}
          frameEnd={job.frameEnd}
          frameStep={job.frameStep}
          chunks={job.chunks}
          currentFrame={frameNumber}
          onSelect={(frame) => {
            // Seek when the showing clip holds the frame; otherwise retarget
            // to the chunk that owns it, so the strip navigates the whole job.
            goToFrame(frame)
          }}
          onOpen={(frame) => {
            const asset = assets?.frames.find((f) => f.frame === frame)
            if (asset) void ipc.invoke('shell:openPath', asset.absPath)
          }}
        />
      ) : null}
      <span style={{ fontSize: 'var(--text-2xs)', color: TOKENS.textFaint }}>
        {domain.count} frames · space play/pause · ←/→ step · [ ] chunk · double-click a frame to
        open the original · Esc close
      </span>
    </div>
  )
}

function Still({ url, rendering }: { url: string | null; rendering: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        ...panel(),
        // No forced 16/9: renders are frequently square or portrait, and
        // boxing a square frame into a landscape panel reads as a crop.
        maxWidth: '100%',
        maxHeight: '100%',
        minWidth: 240,
        minHeight: 160,
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        background: '#000'
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          {rendering ? 'Rendering — the first frames appear here as they land.' : 'No preview.'}
        </span>
      )}
    </div>
  )
}
