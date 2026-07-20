import { btn, mono, panel, sectionLabel, segmented } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import { DEFAULT_GRADE, GRADE_PRESETS, type Grade } from './grade'
import { applyGradePreset, setGrade, useGrade } from './useGrade'

const SLIDERS: Array<{ key: keyof Grade; label: string; min: number; max: number; step: number }> =
  [
    { key: 'contrast', label: 'contrast', min: 0.5, max: 2, step: 0.01 },
    { key: 'brightness', label: 'brightness', min: 0.5, max: 1.5, step: 0.01 },
    { key: 'saturate', label: 'saturation', min: 0, max: 2, step: 0.01 },
    { key: 'lift', label: 'lift', min: -0.2, max: 0.2, step: 0.005 }
  ]

const PRESET_KEYS = Object.keys(GRADE_PRESETS).filter((k) => k !== 'neutral')

/** Right-drawer grade controls. Disabled during HDR passthrough. */
export function GradePanel({ hdrMode }: { hdrMode: boolean }): React.JSX.Element {
  const grade = useGrade()
  return (
    <div
      style={{
        ...panel({ elevated: true }),
        width: 240,
        padding: SCALE.space3,
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3,
        opacity: hdrMode ? 0.55 : 1
      }}
    >
      <span style={sectionLabel()}>grade</span>
      {hdrMode ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          grading bypassed — HDR passthrough
        </span>
      ) : null}
      <div style={{ display: 'flex' }}>
        {PRESET_KEYS.map((k, i) => (
          <button
            key={k}
            disabled={hdrMode}
            style={segmented({
              active: JSON.stringify(GRADE_PRESETS[k]) === JSON.stringify(grade),
              position: i === 0 ? 'first' : i === PRESET_KEYS.length - 1 ? 'last' : 'middle'
            })}
            onClick={() => applyGradePreset(k)}
          >
            {k}
          </button>
        ))}
      </div>
      {SLIDERS.map((s) => (
        <label key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: SCALE.textXs,
              color: TOKENS.textMuted
            }}
          >
            {s.label}
            <span style={mono}>{grade[s.key].toFixed(2)}</span>
          </span>
          <input
            type="range"
            disabled={hdrMode}
            min={s.min}
            max={s.max}
            step={s.step}
            value={grade[s.key]}
            onChange={(e) => setGrade({ [s.key]: Number(e.target.value) })}
            style={{ accentColor: 'var(--accent)' }}
          />
        </label>
      ))}
      <button
        style={btn({ variant: 'ghost', size: 'sm', disabled: hdrMode })}
        disabled={hdrMode}
        onClick={() => setGrade(DEFAULT_GRADE)}
      >
        reset
      </button>
    </div>
  )
}
