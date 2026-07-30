# HDR / codec capability findings (Phase 0 probe)

Probed on: Windows 11 Pro, Electron 39.8.10 (Chromium 142), NVIDIA GPU, Windows HDR enabled.
Probe fixtures: `scripts/make-fixtures.ps1` (1024², 25 fps, 100 frames, All-Intra, burned-in frame numbers).

## Results

| Query (MediaCapabilities.decodingInfo) | supported | smooth | powerEfficient |
| --- | --- | --- | --- |
| HEVC Main10 `hvc1.2.4.L120.B0` | true | true | true |
| HEVC Main10 + `transferFunction: hlg`, `colorGamut: rec2020` | true | true | true |
| AV1 10-bit `av01.0.08M.10` | true | true | true |
| AV1 10-bit + hlg/rec2020 | **false** | — | — |

Playback: all three probe clips (`probe_hlg_hevc.mp4`, `probe_hlg_av1.mp4`, `probe_sdr_hevc.mp4`)
load and play via the custom `media://` protocol (Range/stream support confirmed by seeking).

Display capability media queries:

- `(dynamic-range: high)` → **true** (Windows HDR on) — this is the query the UI uses, with a
  live `change` subscription (tracks window moving between displays / HDR toggled).
- `(video-dynamic-range: high)` → false on the same setup. Do **not** gate on this one.

## Decisions

1. **Proxy codec = HEVC (libx265)**: hardware decode confirmed smooth + power-efficient, HLG
   flagged supported. This matches the encode contract (10-bit HLG BT.2020, All-Intra keyint=1).
2. **AV1 (SVT-AV1) retained as a settings-level fallback** for machines without HEVC hardware
   decode. Note: MediaCapabilities under-reports AV1 HDR (query returns false) even though the
   HLG AV1 clip decodes and plays — if AV1 is selected, gate only on the plain AV1 query.
3. No Electron command-line switches were needed for HEVC or HDR — stock Electron 39 works.
4. HDR passthrough rule stands: HDR mode remounts the `<video>` (React `key`) with **no CSS
   filter**; any filter forces SDR compositing and clamps HDR.

## Caveats

- HDR rendition only looks correct when the window is on a display with Windows HDR enabled;
  `(dynamic-range: high)` flips live when HDR is toggled or the window moves — the UI hides the
  HDR toggle when false.
- Frame stepping via `currentTime = (frame + 0.5) / fps` on All-Intra clips is the seek model;
  visually verified against burned-in frame numbers on the probe page.
- `extract-zip` (used by electron's install script) silently failed to extract the Electron
  binary on this machine; fixed by manual `Expand-Archive` of the cached zip + writing
  `node_modules/electron/path.txt`. If a fresh `npm install` ever reports "Electron uninstall",
  repeat that (see git history of this file for the exact commands).

## WebGL grading parity (measured 2026-07-27)

The Gallery wall grades with a CSS `filter`; the preview overlay grades with a
WebGL shader (`media/GradeRenderer.ts`). Both read one shared `Grade`, so they
have to agree or a clip changes appearance depending on where you opened it.

Measured with the grade lab — `?screen=gradelab&run=1`, which sweeps 12 grades
over `fixtures/grade_chart_sdr.mp4` and compares the shader's `readPixels`
against `CanvasRenderingContext2D.filter` (the readable oracle: `drawImage`
does not apply an element's CSS filter, but the 2D context's `filter` runs the
same Skia chain).

**Result: 12/12 within 3 LSB.** Every single-parameter grade is ≤1 LSB;
combined contrast+brightness+saturate chains land at 2-3.

Two hypotheses for that residual were tested and rejected:

| Change | Result |
|---|---|
| Drop the per-stage `[0,1]` clamp | Much worse — 11, 26, 35 LSB. The clamp is right; CSS clamps between filter primitives. |
| Round to 8-bit between primitives | No better on combined grades, *worse* on simple ones (Δ0 → Δ1). Skia keeps float precision through the chain. |

So `GradeRenderer.cssClampPerStage = true` is correct, and the 2-3 LSB residual
is Skia's chain arithmetic, unisolated and sub-perceptual.

### Two prerequisites, both non-obvious

1. **`media:` must be CORS-enabled** (`corsEnabled: true` in
   `registerSchemesAsPrivileged` plus `Access-Control-Allow-Origin` on every
   response) and every graded `<video>` needs `crossOrigin="anonymous"`.
   Without both, `texImage2D` throws "The video element contains cross-origin
   data" and the renderer falls back to the CSS filter — silently, because
   falling back is the correct response to a failed upload. The shader path
   simply never ran.
2. **Never call `WEBGL_lose_context.loseContext()` on teardown.** It poisons
   the *canvas element*, not just the context: a later `getContext()` returns
   the lost context and every shader compile fails with a `null` info log.
   StrictMode runs effects mount → cleanup → mount, so the second mount always
   landed on a dead canvas.

HLG parity is deliberately NOT asserted: graded mode replaces Chromium's
HLG→SDR conversion with its own decode, so that comparison is a
documented-difference check rather than a parity check.
