/**
 * Exposure/grade model. Two tiers, and the split is load-bearing:
 *
 *  CORE (contrast/brightness/saturate/lift) must produce an IDENTICAL picture
 *  on both presentation paths, because the Gallery wall grades with a CSS
 *  filter while the inspector grades with a shader, from one shared Grade.
 *  `coreParams()` is the single source of truth: `gradeToFilter()` builds the
 *  CSS string from it and GradeRenderer uploads the same three numbers, so the
 *  two cannot drift — in particular `lift` folds into brightness in exactly one
 *  place, not once here and once in GLSL.
 *
 *  SHADER-ONLY (exposure/gamma/temperature) has no CSS equivalent and operates
 *  in LINEAR light, which is why it needs a shader at all. Every shader-only
 *  field MUST have an IDENTITY default: that is the whole localStorage
 *  migration, since useGrade's readInitial() already spreads the stored object
 *  over DEFAULT_GRADE, so a `vr:grade:v1` object written before these fields
 *  existed loads with identity values and renders exactly the old picture.
 *  LS_KEY therefore stays at v1 — bumping it would throw away real user grades
 *  to solve a problem that does not exist. Bump it only if an existing field's
 *  MEANING changes.
 */

export interface Grade {
  // -- core: CSS-filter parity required, applied in non-linear display space --
  contrast: number
  brightness: number
  /** Folded into brightness on BOTH paths — see coreParams(). */
  lift: number
  saturate: number
  // -- shader-only: identity defaults, ignored by gradeToFilter() --
  /** Stops, applied in linear light. 0 = identity. */
  exposure: number
  /** Mid-tone gamma, applied in linear light. 1 = identity. */
  gamma: number
  /** Warm (+) / cool (−) white balance, −1..1, in linear light. 0 = identity. */
  temperature: number
}

export const SHADER_ONLY_KEYS = ['exposure', 'gamma', 'temperature'] as const

/** Every field at its no-op value. Also the reset target and the preset base. */
export const IDENTITY_GRADE: Grade = {
  contrast: 1,
  brightness: 1,
  lift: 0,
  saturate: 1,
  exposure: 0,
  gamma: 1,
  temperature: 0
}

/**
 * Presets are PARTIAL and are merged over IDENTITY_GRADE by resolvePreset().
 * They used to be full Grade objects, which was already fragile and becomes a
 * real bug now that Grade has more fields: setGrade() merges, so a preset that
 * omitted `exposure` would inherit whatever exposure happened to be set and
 * "punchy" would mean something different depending on history. A preset must
 * fully define a look.
 */
export const GRADE_PRESETS: Record<string, Partial<Grade>> = {
  neutral: {},
  punchy: { contrast: 1.35, brightness: 0.96, saturate: 1.1 },
  // Historically identical to neutral; kept as-is rather than invented anew.
  flat: {},
  high: { contrast: 1.6, brightness: 0.9, saturate: 1.25 },
  mono: { contrast: 1.35, brightness: 0.98, saturate: 0, lift: 0.02 }
}

export const DEFAULT_GRADE: Grade = IDENTITY_GRADE

export interface CoreParams {
  contrast: number
  brightness: number
  saturate: number
}

/**
 * The only place `lift` folds into brightness. Both graders call this, so
 * rounding here is what keeps them bit-identical: `0.9 + 0.05` is
 * 0.9500000000000001, and an unrounded value would both litter the CSS filter
 * string with 17 digits and hand the shader a marginally different number than
 * Skia parses. 4dp is ~40× finer than 1/255, so it is invisible either way.
 */
function q(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

export function coreParams(g: Grade): CoreParams {
  return { contrast: q(g.contrast), brightness: q(g.brightness + g.lift), saturate: q(g.saturate) }
}

/**
 * CSS filter for the SDR wall path. Ignores the shader-only tier by
 * construction — VideoTile badges any tile where that matters.
 */
export function gradeToFilter(g: Grade): string {
  const { contrast, brightness, saturate } = coreParams(g)
  return `contrast(${contrast}) brightness(${brightness}) saturate(${saturate})`
}

export function resolvePreset(name: string): Grade {
  return { ...IDENTITY_GRADE, ...(GRADE_PRESETS[name] ?? {}) }
}

/**
 * Field-wise. GradePanel's active-preset check used
 * `JSON.stringify(preset) === JSON.stringify(grade)`, which is key-order
 * sensitive and breaks the moment Grade grows a field the presets omit.
 */
export function gradesEqual(a: Grade, b: Grade): boolean {
  return (Object.keys(IDENTITY_GRADE) as Array<keyof Grade>).every((k) => a[k] === b[k])
}

export function isNeutral(g: Grade): boolean {
  return gradesEqual(g, IDENTITY_GRADE)
}

/** True when the grade contains something the CSS path cannot render. */
export function hasShaderOnly(g: Grade): boolean {
  return SHADER_ONLY_KEYS.some((k) => g[k] !== IDENTITY_GRADE[k])
}

// ---------------------------------------------------------------------------
// Tone curve — a JS mirror of the shader, for drawing over the histogram
// ---------------------------------------------------------------------------

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

/**
 * Where a neutral input value ends up after grading, in 0..1 display space.
 *
 * MUST mirror GradeRenderer's fragment shader — same order, same spaces:
 * decode to linear, exposure/gamma in linear, re-encode, then the CSS-parity
 * core tier with its per-stage clamp. Saturation and white balance are omitted
 * because they do nothing to a neutral value, which is exactly what a tone
 * curve plots. If the shader's order changes, change this with it or the
 * curve becomes a decorative lie.
 */
export function toneCurve(g: Grade, samples = 256): Float32Array {
  const out = new Float32Array(samples)
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
  for (let i = 0; i < samples; i++) {
    const x = i / (samples - 1)
    let lin = srgbToLinear(x)
    lin *= Math.pow(2, g.exposure)
    lin = Math.pow(Math.max(lin, 0), 1 / Math.max(0.01, g.gamma))
    let c = clamp01(linearToSrgb(lin))
    c = clamp01(c * g.contrast + (0.5 - 0.5 * g.contrast))
    c = clamp01(c * (g.brightness + g.lift))
    out[i] = c
  }
  return out
}
