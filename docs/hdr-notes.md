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
