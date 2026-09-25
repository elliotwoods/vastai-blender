import { mono, panel, sectionLabel } from '../../lib/controls'
import { SCALE, TOKENS } from '../../lib/theme'
import type { SceneRenderTimes } from '../../../../shared/models'
import { fmtSeconds, summariseTimes, type TimeSegment } from './timesSummary'

// Sampling is the one phase that keeps the GPU busy; the rest is it waiting.
const SEGMENT_COLOR: Record<TimeSegment['key'], string> = {
  load: TOKENS.textFaint,
  eval: TOKENS.textMuted,
  sync: TOKENS.warn,
  sample: TOKENS.accent,
  save: TOKENS.textDisabled
}

function TimesRow({ times }: { times: SceneRenderTimes }): React.JSX.Element | null {
  const summary = summariseTimes(times)
  if (!summary) return null
  const { segments, perFrameS, gpuBusy } = summary
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: SCALE.space2, fontSize: SCALE.textXs }}>
        <span style={{ color: TOKENS.textSecondary }}>{times.gpuName}</span>
        <span style={{ color: TOKENS.textFaint }}>
          {times.frames} frames · {fmtSeconds(perFrameS)} a frame
        </span>
        <span style={{ flex: 1 }} />
        {gpuBusy != null ? (
          <span
            style={{ ...mono, color: TOKENS.textMuted }}
            title="Share of each frame's time the GPU spends sampling"
          >
            GPU busy {Math.round(gpuBusy * 100)}%
          </span>
        ) : null}
        {times.peakVramMb != null ? (
          <span
            style={{ ...mono, color: TOKENS.textMuted }}
            title="The most GPU memory one render of this scene used"
          >
            VRAM {(times.peakVramMb / 1024).toFixed(1)} GB
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden' }}>
        {segments.map((s) =>
          s.seconds > 0 ? (
            <div
              key={s.key}
              title={`${s.label}: ${fmtSeconds(s.seconds)} a frame`}
              style={{ flex: s.seconds, background: SEGMENT_COLOR[s.key] }}
            />
          ) : null
        )}
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: SCALE.space3,
          fontSize: 'var(--text-2xs)'
        }}
      >
        {segments.map((s) => (
          <span key={s.key} style={{ color: TOKENS.textFaint }}>
            <span
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: 1,
                marginRight: 4,
                background: SEGMENT_COLOR[s.key]
              }}
            />
            {s.label} <span style={mono}>{fmtSeconds(s.seconds)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Where a frame's time goes, per GPU model the scene rendered on: the load
 * (spread over each chunk's frames), evaluation, Cycles' sync, sampling and
 * the save. Nothing until the render driver timed a frame.
 */
export function RenderTimes({ times }: { times: SceneRenderTimes[] }): React.JSX.Element | null {
  const rows = times.filter((t) => t.frames > 0)
  if (rows.length === 0) return null
  return (
    <>
      <span style={sectionLabel()}>where the time goes</span>
      <div
        style={{
          ...panel(),
          padding: SCALE.space3,
          display: 'flex',
          flexDirection: 'column',
          gap: SCALE.space3
        }}
      >
        {rows.map((t) => (
          <TimesRow key={t.gpuName} times={t} />
        ))}
      </div>
    </>
  )
}
