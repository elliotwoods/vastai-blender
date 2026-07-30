import { Icon, type IconName } from '../components/Icon'
import { btn, mono, panel, sectionLabel, segmented } from '../lib/controls'
import { SCALE, TOKENS } from '../lib/theme'
import { Histogram } from './Histogram'
import { DEFAULT_GRADE, GRADE_PRESETS, gradesEqual, resolvePreset, type Grade } from './grade'
import { applyGradePreset, setGrade, useGrade } from './useGrade'

interface Slider {
  key: keyof Grade
  label: string
  icon: IconName
  min: number
  max: number
  step: number
  /** Value at which the control is doing nothing — the double-click target. */
  neutral: number
  /** Suffix for the readout (stops, ×, …). */
  unit?: string
}

/**
 * Exposure leads. It is the control people reach for first on a render, it is
 * the only one that operates in linear light on the signal's real range, and
 * putting it under three display-space knobs buried the thing the HDR headroom
 * exists for.
 */
const PRIMARY: Slider = {
  key: 'exposure',
  label: 'exposure',
  icon: 'exposure',
  min: -3,
  max: 3,
  step: 0.01,
  neutral: 0,
  unit: ' EV'
}

/** Applied in display space; reproducible by the CSS filter path. */
const CORE_SLIDERS: Slider[] = [
  {
    key: 'contrast',
    label: 'contrast',
    icon: 'contrast',
    min: 0.5,
    max: 2,
    step: 0.01,
    neutral: 1
  },
  {
    key: 'brightness',
    label: 'brightness',
    icon: 'brightness',
    min: 0.5,
    max: 1.5,
    step: 0.01,
    neutral: 1
  },
  {
    key: 'saturate',
    label: 'saturation',
    icon: 'saturation',
    min: 0,
    max: 2,
    step: 0.01,
    neutral: 1
  },
  { key: 'lift', label: 'lift', icon: 'lift', min: -0.2, max: 0.2, step: 0.005, neutral: 0 }
]

/** Linear-light, like exposure — no CSS equivalent. */
const SHADER_SLIDERS: Slider[] = [
  { key: 'gamma', label: 'gamma', icon: 'gamma', min: 0.5, max: 2, step: 0.01, neutral: 1 },
  {
    key: 'temperature',
    label: 'white bal',
    icon: 'whitebalance',
    min: -1,
    max: 1,
    step: 0.01,
    neutral: 0
  }
]

const PRESET_KEYS = Object.keys(GRADE_PRESETS).filter((k) => k !== 'neutral')

function SliderRow({
  s,
  disabled,
  primary = false
}: {
  s: Slider
  disabled: boolean
  primary?: boolean
}): React.JSX.Element {
  const grade = useGrade()
  const value = grade[s.key]
  const modified = value !== s.neutral
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        opacity: disabled ? 0.5 : 1
      }}
      title={`${s.label} — double-click to reset`}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: primary ? SCALE.textSm : SCALE.textXs,
          color: modified ? TOKENS.text : TOKENS.textMuted
        }}
      >
        <span style={{ display: 'flex', color: modified ? TOKENS.accent : TOKENS.textFaint }}>
          <Icon name={s.icon} size={primary ? 14 : 12} />
        </span>
        {s.label}
        <span style={{ flex: 1 }} />
        <span style={{ ...mono, color: modified ? TOKENS.accent : TOKENS.textMuted }}>
          {value > 0 && s.neutral === 0 ? '+' : ''}
          {value.toFixed(2)}
          {s.unit ?? ''}
        </span>
      </span>
      <input
        type="range"
        disabled={disabled}
        min={s.min}
        max={s.max}
        step={s.step}
        value={value}
        onChange={(e) => setGrade({ [s.key]: Number(e.target.value) })}
        // Double-click to neutral: the standard gesture for a grading slider,
        // and the only way back to exactly neutral with a fine step.
        onDoubleClick={() => setGrade({ [s.key]: s.neutral })}
        style={{ accentColor: 'var(--accent)', height: primary ? 18 : 14 }}
      />
    </label>
  )
}

/**
 * Right-drawer grade controls. Disabled during HDR passthrough (nothing grades
 * an HDR element without collapsing it to SDR), and the linear-light tier is
 * disabled on surfaces that grade with a CSS filter, which cannot express it.
 */
export function GradePanel({
  hdrMode,
  capability = 'gl',
  histogram
}: {
  hdrMode: boolean
  /** Which grader the surface this panel drives is using. */
  capability?: 'css' | 'gl'
  /** Luma histogram of the graded output; null when unavailable. */
  histogram?: Float32Array | null
}): React.JSX.Element {
  const grade = useGrade()
  const shaderDisabled = hdrMode || capability === 'css'
  return (
    <div
      style={{
        ...panel({ elevated: true }),
        width: 240,
        padding: SCALE.space3,
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space3,
        overflowY: 'auto',
        opacity: hdrMode ? 0.55 : 1
      }}
    >
      <span style={{ ...sectionLabel(), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Icon name="histogram" size={11} />
        grade
      </span>

      <Histogram bins={histogram ?? null} grade={grade} />

      {hdrMode ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          grading bypassed — HDR passthrough
        </span>
      ) : null}

      <SliderRow s={PRIMARY} disabled={shaderDisabled} primary />

      <div style={{ display: 'flex' }}>
        {PRESET_KEYS.map((k, i) => (
          <button
            key={k}
            disabled={hdrMode}
            style={segmented({
              active: gradesEqual(resolvePreset(k), grade),
              position: i === 0 ? 'first' : i === PRESET_KEYS.length - 1 ? 'last' : 'middle'
            })}
            onClick={() => applyGradePreset(k)}
          >
            {k}
          </button>
        ))}
      </div>

      {CORE_SLIDERS.map((s) => (
        <SliderRow key={s.key} s={s} disabled={hdrMode} />
      ))}

      {capability === 'css' && !hdrMode ? (
        <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
          exposure, gamma and white balance need the shader — open the preview to use them
        </span>
      ) : null}
      {SHADER_SLIDERS.map((s) => (
        <SliderRow key={s.key} s={s} disabled={shaderDisabled} />
      ))}

      <button
        style={btn({ variant: 'ghost', size: 'sm', disabled: hdrMode })}
        disabled={hdrMode}
        onClick={() => setGrade(DEFAULT_GRADE)}
      >
        reset all
      </button>
    </div>
  )
}
