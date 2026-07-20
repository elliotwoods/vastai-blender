# Generates local video fixtures for development & the HDR/HEVC capability probe.
# Requires ffmpeg (with libx265 + libsvtav1) on PATH. Output goes to fixtures/ (gitignored).
#
# Clips are 100 frames @ 25fps, 1024x1024, All-Intra (keyint=1) with burned-in frame
# numbers so frame-exact seeking can be verified visually.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'fixtures'
New-Item -ItemType Directory -Force $out | Out-Null

$font = 'C\:/Windows/Fonts/consola.ttf'
$src = 'testsrc2=size=1024x1024:rate=25:duration=4'
$draw = "drawtext=fontfile='$font':text='%{frame_num}':fontsize=200:fontcolor=white:borderw=6:bordercolor=black:x=(w-tw)/2:y=(h-th)/2"
$tag709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709'
$toHlg = 'zscale=transferin=bt709:primariesin=bt709:matrixin=bt709:transfer=arib-std-b67:primaries=bt2020:matrix=bt2020nc'

# 1) HDR: 10-bit HLG BT.2020 HEVC, All-Intra
ffmpeg -y -f lavfi -i $src `
  -vf "$tag709,$draw,$toHlg,format=yuv420p10le" `
  -c:v libx265 -crf 18 -preset fast -x265-params "keyint=1:min-keyint=1:scenecut=0" `
  -colorspace bt2020nc -color_primaries bt2020 -color_trc arib-std-b67 `
  -tag:v hvc1 -movflags +faststart "$out/probe_hlg_hevc.mp4"
if ($LASTEXITCODE -ne 0) { throw "hlg hevc encode failed" }

# 2) HDR fallback candidate: 10-bit HLG BT.2020 AV1, All-Intra
ffmpeg -y -f lavfi -i $src `
  -vf "$tag709,$draw,$toHlg,format=yuv420p10le" `
  -c:v libsvtav1 -crf 30 -preset 6 -svtav1-params "keyint=1" `
  -colorspace bt2020nc -color_primaries bt2020 -color_trc arib-std-b67 `
  -movflags +faststart "$out/probe_hlg_av1.mp4"
if ($LASTEXITCODE -ne 0) { throw "hlg av1 encode failed" }

# 3) SDR baseline: 8-bit BT.709 HEVC, All-Intra
ffmpeg -y -f lavfi -i $src `
  -vf "$tag709,$draw,format=yuv420p" `
  -c:v libx265 -crf 18 -preset fast -x265-params "keyint=1:min-keyint=1:scenecut=0" `
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 `
  -tag:v hvc1 -movflags +faststart "$out/probe_sdr_hevc.mp4"
if ($LASTEXITCODE -ne 0) { throw "sdr hevc encode failed" }

Get-ChildItem $out | Select-Object Name, Length
