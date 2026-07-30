/**
 * WebGL2 grading renderer: draws a <video> through a shader instead of a CSS
 * filter, so grading can happen in LINEAR LIGHT and on the HLG signal's real
 * range rather than on whatever Chromium already tone-mapped and clipped.
 *
 * What this does and does not buy (measured, not assumed):
 *   Chromium hard-clamps `texImage2D(<video>)` to 8 bits per channel — the
 *   upload lands in GetN32FormatForCanvas() (crbug 40230609, still open at
 *   tip). So the shader gets BETTER MATHS, NOT A BETTER SOURCE: smooth HLG
 *   gradients can still band. What it does buy is real: no highlight clip
 *   above diffuse white, no BT.2020 gamut clip, and exposure/gamma/white
 *   balance that mean what they say because they run in linear light.
 *
 * The one Chromium-specific lever that makes it work is
 * UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE. Without it Chromium converts the
 * frame to sRGB during upload — clipping everything above SDR white and
 * hard-clipping out-of-gamut BT.2020 BEFORE the shader ever sees it. With it
 * we receive raw code values and do our own decode. (The WebGL spec only
 * defines this pixel-store parameter for HTMLImageElement; Chromium applies it
 * to video sources too, which is fine in Electron.)
 *
 * Core-tier parity: contrast/brightness/saturate are applied in NON-LINEAR
 * display space, last, exactly as CSS filters are, and with identity
 * shader-only values the linear round-trip is a no-op — so the wall's CSS path
 * and this shader agree. See docs and the parity harness for the ≤1 LSB check.
 *
 * Plain class, no React — GradeCanvas.tsx owns the lifecycle, mirroring how
 * ClipSyncController is consumed.
 */

import { coreParams, type Grade } from './grade'

/** Which transfer function the sampled code values are in. */
export type SourceTransfer = 'srgb' | 'hlg'

export interface GradeParams {
  grade: Grade
  transfer: SourceTransfer
}

/**
 * HLG scene-linear scale. `remote/encode/encode_preview.py` encodes with
 * `npl=203` (BT.2408 reference white), so EXR linear 1.0 lands at 203 of the
 * HLG system's 1000-nit nominal peak. Multiplying by 1000/203 puts diffuse
 * white back at 1.0 and leaves ~2.3 stops of headroom above it for the
 * exposure control to recover. If npl changes, this changes with it.
 */
const HLG_SCENE_SCALE = 1000 / 203

/** Upper bound on the drawing buffer width; sources above this are scaled. */
const MAX_BUFFER_WIDTH = 3840

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  // Full-screen triangle from gl_VertexID — no buffers, no attributes.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  // Flip V: texImage2D stores the video's first row at v=0, and clip-space
  // +y is the top of the screen.
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
uniform float uContrast;
uniform float uBrightness;
uniform float uSaturate;
uniform float uExposure;
uniform float uGamma;
uniform float uTemperature;
/** 0 = sRGB / BT.709, 1 = HLG BT.2020. */
uniform int uTransfer;
uniform float uHlgScale;
/** CSS clamps to [0,1] between filter primitives; the parity harness pins this. */
uniform int uClampPerStage;

const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
// filter-effects-1 feColorMatrix type="saturate" coefficients — deliberately
// NOT LUMA_709, because matching CSS is the whole point of the core tier.
const vec3 LUMA_SAT = vec3(0.213, 0.715, 0.072);

const float HLG_A = 0.17883277;
const float HLG_B = 0.28466892;
const float HLG_C = 0.55991073;

float srgbToLinear(float c) {
  c = max(c, 0.0);
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}

float linearToSrgb(float c) {
  c = max(c, 0.0);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

/** HLG inverse OETF (ARIB STD-B67): signal -> scene light, 0..1 of peak. */
float hlgToScene(float e) {
  e = max(e, 0.0);
  return e <= 0.5 ? (e * e) / 3.0 : (exp((e - HLG_C) / HLG_A) + HLG_B) / 12.0;
}

vec3 bt2020ToBt709(vec3 c) {
  return vec3(
    dot(c, vec3( 1.6605, -0.5876, -0.0728)),
    dot(c, vec3(-0.1246,  1.1329, -0.0083)),
    dot(c, vec3(-0.0182, -0.1006,  1.1187))
  );
}

/**
 * Highlight rolloff, HLG path only. Identity below the knee, asymptotic to
 * 1.0 above, C1-continuous at the knee. Applied ONLY where the source really
 * carries values above display white — on the SDR path any range compression
 * would break core-tier parity with the CSS filter.
 */
vec3 shoulder(vec3 c) {
  const float knee = 0.8;
  const float span = 1.0 - knee;
  vec3 over = max(c - knee, 0.0);
  return min(c, vec3(knee)) + span * (over / (over + span));
}

/**
 * One CSS filter-primitive boundary. Clamp only — NOT 8-bit rounding: that was
 * measured (grade lab, 12-grade sweep) and made single-parameter grades worse
 * while not helping combined ones, so Skia evidently keeps float precision
 * through the chain and only quantises at the end.
 */
vec3 stage(vec3 c) {
  return uClampPerStage == 1 ? clamp(c, 0.0, 1.0) : c;
}

/** Warm/cool in linear light, luminance-preserving so it stays chromatic. */
vec3 whiteBalance(vec3 c, float t) {
  vec3 gained = c * vec3(1.0 + 0.20 * t, 1.0, 1.0 - 0.20 * t);
  float before = dot(c, LUMA_709);
  float after = dot(gained, LUMA_709);
  return after > 0.0 ? gained * (before / after) : gained;
}

void main() {
  vec3 code = texture(uTex, vUv).rgb;

  // -- decode to linear scene light --------------------------------------
  vec3 lin;
  if (uTransfer == 1) {
    lin = vec3(hlgToScene(code.r), hlgToScene(code.g), hlgToScene(code.b)) * uHlgScale;
    lin = max(bt2020ToBt709(lin), 0.0);
  } else {
    lin = vec3(srgbToLinear(code.r), srgbToLinear(code.g), srgbToLinear(code.b));
  }

  // -- shader-only tier, in linear light ---------------------------------
  lin *= exp2(uExposure);
  lin = whiteBalance(lin, uTemperature);
  lin = pow(max(lin, 0.0), vec3(1.0 / uGamma));
  if (uTransfer == 1) lin = shoulder(lin);

  // -- back to display space; the core tier matches CSS from here on -----
  vec3 c = vec3(linearToSrgb(lin.r), linearToSrgb(lin.g), linearToSrgb(lin.b));
  c = clamp(c, 0.0, 1.0);

  // Each CSS filter function is a separate primitive and clamps at its
  // boundary — see stage(). Order matches the string gradeToFilter() builds:
  // contrast, then brightness, then saturate.
  c = stage(c * uContrast + (0.5 - 0.5 * uContrast));
  c = stage(c * uBrightness);
  c = mix(vec3(dot(c, LUMA_SAT)), c, uSaturate);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[grade] shader compile failed:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

export class GradeRenderer {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private tex: WebGLTexture | null = null
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private video: HTMLVideoElement | null = null
  private params: GradeParams | null = null
  private rvfcHandle: number | null = null
  private raf: number | null = null
  /** Allocated texture size; a change means re-allocate rather than sub-image. */
  private texW = 0
  private texH = 0
  private dead = false

  /**
   * CSS clamps between filter primitives per spec; the parity harness flips
   * this if Chromium is measured to differ. Static so one probe run settles it
   * for every instance.
   */
  static cssClampPerStage = true

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onUnavailable: (reason: string) => void
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power'
    })
    if (!gl) {
      this.fail('WebGL2 unavailable')
      return
    }
    this.gl = gl

    canvas.addEventListener('webglcontextlost', this.onContextLost)

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const program = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !program) {
      this.fail('shader compile failed')
      return
    }
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[grade] program link failed:', gl.getProgramInfoLog(program))
      this.fail('program link failed')
      return
    }
    this.program = program
    gl.useProgram(program)
    for (const name of [
      'uTex',
      'uContrast',
      'uBrightness',
      'uSaturate',
      'uExposure',
      'uGamma',
      'uTemperature',
      'uTransfer',
      'uHlgScale',
      'uClampPerStage'
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }

    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // THE line that makes shader grading worth doing — see the file comment.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.uniform1i(this.uniforms.uTex ?? null, 0)

    // No ResizeObserver: the drawing buffer is sized from the VIDEO, not from
    // CSS layout (see sizeToVideo). Deriving it from clientWidth was both
    // wrong and self-inflicted — an absolutely-positioned canvas measures 0
    // when the renderer is constructed, giving a 1x1 buffer stretched over the
    // whole tile (a single texel of the source, which reads as a flat colour),
    // and writing canvas.width from inside a resize callback re-entered the
    // observer every frame.
  }

  get alive(): boolean {
    return !this.dead && this.gl != null && this.program != null
  }

  /** Attach (or re-attach, after an HDR remount) the source element. */
  attach(video: HTMLVideoElement): void {
    if (this.video === video) return
    this.stopDriver()
    this.video = video
    // Force a re-allocate: a different element may have a different size.
    this.texW = 0
    this.texH = 0
    this.startDriver()
    this.kick()
  }

  setParams(params: GradeParams): void {
    this.params = params
    this.kick()
  }

  /**
   * Redraw on the next animation frame. A grade change fires NO video event,
   * and on a paused clip this is the only redraw trigger there is — so it has
   * to be one. Coalesced: many slider events collapse into one draw.
   */
  kick(): void {
    if (!this.alive || this.raf != null) return
    this.raf = requestAnimationFrame(() => {
      this.raf = null
      this.draw()
    })
  }

  /**
   * Render one frame at the video's native size and read the pixels back.
   *
   * For the parity harness only. Native size and a 1:1 viewport matter: any
   * scaling would make GL's LINEAR filtering and canvas2d's drawImage resample
   * differently, and the difference would be attributed to the grade.
   *
   * Returns TOP-DOWN rows. readPixels is bottom-up, so this flips — comparing
   * against a 2D canvas without that is the classic way to "prove" a mismatch
   * that isn't there.
   */
  probe(): { width: number; height: number; data: Uint8ClampedArray } | null {
    const gl = this.gl
    const video = this.video
    if (!gl || !video || video.readyState < 2 || video.videoWidth === 0) return null
    this.sizeToVideo(video)
    const w = this.canvas.width
    const h = this.canvas.height
    this.draw()
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const flipped = new Uint8ClampedArray(w * h * 4)
    const stride = w * 4
    for (let y = 0; y < h; y++) {
      flipped.set(raw.subarray((h - 1 - y) * stride, (h - y) * stride), y * stride)
    }
    return { width: w, height: h, data: flipped }
  }

  /**
   * Luma histogram of what is CURRENTLY ON SCREEN — i.e. after grading, which
   * is the only version worth showing next to grade controls.
   *
   * Reads the existing drawing buffer rather than re-rendering, and subsamples
   * on a stride so cost is bounded regardless of source resolution. Returns
   * 256 buckets normalised to 0..1, or null if there is nothing drawn yet.
   */
  histogram(targetSamples = 20000): Float32Array | null {
    const gl = this.gl
    if (!gl || !this.video || this.canvas.width === 0) return null
    // Redraw first. The context is preserveDrawingBuffer:false, so the buffer
    // is undefined once the frame has been composited — reading it "later"
    // yields zeros, which is a histogram of nothing.
    this.draw()
    const w = this.canvas.width
    const h = this.canvas.height
    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const stride = Math.max(1, Math.floor((w * h) / targetSamples))
    const bins = new Float32Array(256)
    let n = 0
    for (let p = 0; p < w * h; p += stride) {
      const i = p * 4
      // Rec.709 luma on the display-space output.
      const y = (buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722) | 0
      bins[y > 255 ? 255 : y]++
      n++
    }
    if (n === 0) return null
    let peak = 0
    for (let i = 0; i < 256; i++) if (bins[i] > peak) peak = bins[i]
    if (peak > 0) for (let i = 0; i < 256; i++) bins[i] /= peak
    return bins
  }

  destroy(): void {
    this.dead = true
    this.stopDriver()
    if (this.raf != null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    const gl = this.gl
    if (gl) {
      if (this.tex) gl.deleteTexture(this.tex)
      if (this.program) gl.deleteProgram(this.program)
      // Deliberately NOT WEBGL_lose_context.loseContext(): forcing the context
      // lost poisons the CANVAS ELEMENT, not just this renderer — a later
      // getContext() on the same element returns the lost context and every
      // shader compile fails with a null info log.
      //
      // That is not a corner case. StrictMode runs effects mount → cleanup →
      // mount, so the second mount always landed on a dead canvas; switching
      // sources in the grade lab does the same thing deliberately. Dropping our
      // references is enough — Chromium reclaims the context when the canvas
      // is collected.
    }
    this.gl = null
    this.program = null
    this.tex = null
    this.video = null
  }

  // -- internals ------------------------------------------------------------

  private onContextLost = (e: Event): void => {
    // Default action would keep the canvas in a lost state silently; preventing
    // it permits restore, but we do not attempt one — flapping between graders
    // mid-scrub is worse than staying on the CSS filter for the session.
    e.preventDefault()
    this.fail('WebGL context lost')
  }

  private fail(reason: string): void {
    if (this.dead) return
    this.dead = true
    this.onUnavailable(reason)
  }

  private startDriver(): void {
    const video = this.video
    if (!video || !this.alive) return
    if (typeof video.requestVideoFrameCallback === 'function') {
      const step = (): void => {
        if (this.dead || this.video !== video) return
        this.draw()
        this.rvfcHandle = video.requestVideoFrameCallback(step)
      }
      this.rvfcHandle = video.requestVideoFrameCallback(step)
      return
    }
    // Fallback: poll while playing. Paused redraws still come through kick().
    const tick = (): void => {
      if (this.dead || this.video !== video) return
      if (!video.paused && !video.ended) this.draw()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stopDriver(): void {
    const video = this.video
    if (video && this.rvfcHandle != null) {
      video.cancelVideoFrameCallback(this.rvfcHandle)
    }
    this.rvfcHandle = null
  }

  /**
   * Match the drawing buffer to the source's native resolution and let CSS
   * scale it. Resolution-independent, deterministic, and it never depends on
   * layout having happened yet. Capped so a 8K source can't allocate an
   * unreasonable buffer.
   */
  private sizeToVideo(video: HTMLVideoElement): void {
    const gl = this.gl
    if (!gl) return
    const scale = Math.min(1, MAX_BUFFER_WIDTH / video.videoWidth)
    const w = Math.max(1, Math.round(video.videoWidth * scale))
    const h = Math.max(1, Math.round(video.videoHeight * scale))
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = w
    this.canvas.height = h
    gl.viewport(0, 0, w, h)
  }

  private draw(): void {
    const gl = this.gl
    const video = this.video
    const params = this.params
    if (!gl || !this.program || !video || !params) return
    // readyState < HAVE_CURRENT_DATA means there is no frame to upload yet;
    // drawing anyway would show one black frame on every src swap.
    if (video.readyState < 2 || video.videoWidth === 0) return
    this.sizeToVideo(video)

    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    try {
      if (video.videoWidth !== this.texW || video.videoHeight !== this.texH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
        this.texW = video.videoWidth
        this.texH = video.videoHeight
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video)
      }
    } catch (e) {
      // A tainted or undecodable frame throws rather than returning an error
      // code. One bad upload must not wedge the tile.
      this.fail(`video upload failed: ${(e as Error).message}`)
      return
    }

    const { contrast, brightness, saturate } = coreParams(params.grade)
    const u = this.uniforms
    gl.uniform1f(u.uContrast ?? null, contrast)
    gl.uniform1f(u.uBrightness ?? null, brightness)
    gl.uniform1f(u.uSaturate ?? null, saturate)
    gl.uniform1f(u.uExposure ?? null, params.grade.exposure)
    // A zero gamma would divide by zero in the shader; the panel clamps but a
    // hand-edited localStorage value must not blank the canvas.
    gl.uniform1f(u.uGamma ?? null, Math.max(0.01, params.grade.gamma))
    gl.uniform1f(u.uTemperature ?? null, params.grade.temperature)
    gl.uniform1i(u.uTransfer ?? null, params.transfer === 'hlg' ? 1 : 0)
    gl.uniform1f(u.uHlgScale ?? null, HLG_SCENE_SCALE)
    gl.uniform1i(u.uClampPerStage ?? null, GradeRenderer.cssClampPerStage ? 1 : 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
