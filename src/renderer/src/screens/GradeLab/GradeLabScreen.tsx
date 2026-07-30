/**
 * Grade parity harness. Reachable only via `?screen=gradelab` — deliberately
 * not in the sidebar; it is a measuring instrument, not a feature.
 *
 * Proves (or disproves) that the WebGL grader and the CSS filter produce the
 * same picture for the core tier, which is what lets the Gallery wall and the
 * previewer grade the same clip by different means without disagreeing.
 *
 * Prints one `[gradelab]` line per grade plus a SUMMARY, so a scripted
 * `VR_SHOT` run can grep the terminal instead of anyone eyeballing it (main
 * forwards renderer console to stdout whenever VR_SHOT is set).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { btn, mono, panel, sectionLabel } from '../../lib/controls'
import { SCALE, TOKENS } from '../../lib/theme'
import { GradeRenderer } from '../../media/GradeRenderer'
import {
  compare,
  cssReference,
  formatResult,
  PARITY_SWEEP,
  PARITY_TOLERANCE,
  type ParityResult
} from '../../media/gradeParity'
import type { SourceTransfer } from '../../media/GradeRenderer'

/** Static charts: bars for known code values, a ramp for banding/clamping. */
const SOURCES: Array<{ label: string; url: string; transfer: SourceTransfer }> = [
  { label: 'SDR BT.709', url: 'media://fixtures/grade_chart_sdr.mp4', transfer: 'srgb' },
  { label: 'HLG BT.2020', url: 'media://fixtures/grade_chart_hlg.mp4', transfer: 'hlg' }
]

export function GradeLabScreen(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<GradeRenderer | null>(null)
  const [sourceIndex, setSourceIndex] = useState(0)
  const [results, setResults] = useState<ParityResult[]>([])
  const [status, setStatus] = useState('idle')
  // `&clamp=0` lets a scripted run measure both settings without a click.
  const [clampPerStage, setClampPerStage] = useState(
    new URLSearchParams(window.location.search).get('clamp') !== '0' &&
      GradeRenderer.cssClampPerStage
  )
  const source = SOURCES[sourceIndex]

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const r = new GradeRenderer(canvas, (reason) => setStatus(`GL unavailable: ${reason}`))
    if (!r.alive) {
      r.destroy()
      setStatus('GL unavailable')
      return
    }
    rendererRef.current = r
    r.attach(video)
    return () => {
      r.destroy()
      rendererRef.current = null
    }
  }, [sourceIndex])

  const run = useCallback(async () => {
    const video = videoRef.current
    const renderer = rendererRef.current
    if (!video || !renderer) return
    // Paused on a settled frame: both paths must read the SAME frame, and a
    // playing video would advance between the two reads.
    video.pause()
    video.currentTime = 0.5
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2 && Math.abs(video.currentTime - 0.5) < 0.05) return resolve()
      video.addEventListener('seeked', () => resolve(), { once: true })
    })

    GradeRenderer.cssClampPerStage = clampPerStage
    setStatus('running…')
    const out: ParityResult[] = []
    for (const grade of PARITY_SWEEP) {
      renderer.setParams({ grade, transfer: source.transfer })
      const shader = renderer.probe()
      const reference = cssReference(video, grade)
      if (!shader || !reference) {
        setStatus('could not read back a frame')
        return
      }
      const { maxDelta, p99Delta } = compare(shader.data, reference.data)
      const result: ParityResult = {
        grade,
        maxDelta,
        p99Delta,
        pass: maxDelta <= PARITY_TOLERANCE
      }
      out.push(result)
      console.log(`${formatResult(result)} [${source.label}, clampPerStage=${clampPerStage}]`)
    }
    const passed = out.filter((r) => r.pass).length
    setResults(out)
    const summary = `[gradelab] SUMMARY ${passed}/${out.length} PASS — ${source.label}, clampPerStage=${clampPerStage}`
    console.log(summary)
    setStatus(summary)
  }, [clampPerStage, source])

  // Auto-run for scripted captures: ?screen=gradelab&run=1
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('run')) return
    const t = setTimeout(() => void run(), 2500)
    return () => clearTimeout(t)
  }, [run])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar
        left={
          <>
            <span style={sectionLabel()}>grade lab</span>
            {SOURCES.map((s, i) => (
              <button
                key={s.url}
                style={btn({ size: 'sm', active: i === sourceIndex })}
                onClick={() => setSourceIndex(i)}
              >
                {s.label}
              </button>
            ))}
            <button
              style={btn({ size: 'sm', active: clampPerStage })}
              title="Clamp to [0,1] between filter primitives, as the CSS spec does"
              onClick={() => setClampPerStage(!clampPerStage)}
            >
              clamp per stage
            </button>
            <button style={btn({ variant: 'primary', size: 'sm' })} onClick={() => void run()}>
              run sweep
            </button>
          </>
        }
      />
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: SCALE.space4,
          display: 'flex',
          flexDirection: 'column',
          gap: SCALE.space3,
          minHeight: 0
        }}
      >
        <span style={{ ...mono, fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
          {status}
        </span>

        <div style={{ display: 'flex', gap: SCALE.space3, flexWrap: 'wrap' }}>
          <div>
            <span style={sectionLabel()}>source (ungraded)</span>
            <video
              ref={videoRef}
              key={source.url}
              src={source.url}
              crossOrigin="anonymous"
              muted
              playsInline
              preload="auto"
              style={{ width: 320, display: 'block', background: '#000' }}
            />
          </div>
          <div>
            <span style={sectionLabel()}>shader</span>
            {/* Sized by probe() to the video's native resolution; shown small. */}
            <canvas ref={canvasRef} style={{ width: 320, display: 'block', background: '#000' }} />
          </div>
        </div>

        <div style={{ ...panel(), padding: SCALE.space3 }}>
          {results.length === 0 ? (
            <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
              Run the sweep. HLG is expected to FAIL: graded mode deliberately replaces
              Chromium&apos;s HLG→SDR conversion, so it is a documented-difference check, not a
              parity check.
            </span>
          ) : (
            results.map((r, i) => (
              <div
                key={i}
                style={{
                  ...mono,
                  fontSize: SCALE.textXs,
                  color: r.pass ? TOKENS.text : TOKENS.warn
                }}
              >
                {formatResult(r)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
