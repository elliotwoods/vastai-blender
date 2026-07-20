#!/usr/bin/env python3
"""Preview clip encoder — runs ON the node after a chunk completes.

Input: a directory of numbered frames (EXR treated as linear Rec.709 — the
render contract; PNG/JPG treated as sRGB). Outputs H.265 (or AV1) clips:

  --sdr    Rec.709 SDR at native resolution
  --hdr    10-bit HLG BT.2020 at native resolution (EXR input only)
  --proxy  512px-wide SDR

All clips are All-Intra (keyint=1): frame-exact scrubbing beats bitrate for
QA previews. Prints one JSON line per produced clip (parsed by the agent).
"""

import argparse
import json
import os
import re
import subprocess
import sys

FFMPEG = os.environ.get("FFMPEG_BIN") or (
    os.path.join(os.path.expanduser("~"), "vastai", "bin", "ffmpeg")
    if os.path.exists(os.path.join(os.path.expanduser("~"), "vastai", "bin", "ffmpeg"))
    else "ffmpeg"
)
FFPROBE = os.environ.get("FFPROBE_BIN") or (
    os.path.join(os.path.expanduser("~"), "vastai", "bin", "ffprobe")
    if os.path.exists(os.path.join(os.path.expanduser("~"), "vastai", "bin", "ffprobe"))
    else "ffprobe"
)

NUM_RE = re.compile(r"^(\d+)\.(\w+)$")


def scan_frames(frames_dir):
    """Return (pattern, start_number, count, ext)."""
    frames = []
    for name in os.listdir(frames_dir):
        m = NUM_RE.match(name)
        if m:
            frames.append((int(m.group(1)), len(m.group(1)), m.group(2).lower()))
    if not frames:
        raise SystemExit("no numbered frames found in " + frames_dir)
    frames.sort()
    start, width, ext = frames[0]
    pattern = os.path.join(frames_dir, f"%0{width}d.{ext}")
    return pattern, start, len(frames), ext


def probe_size(path):
    out = subprocess.check_output(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", path],
        text=True,
    )
    s = json.loads(out)["streams"][0]
    return s["width"], s["height"]


def build_cmd(pattern, start, fps, vf, out_path, codec, ten_bit, hdr_tags, crf):
    cmd = [FFMPEG, "-y", "-loglevel", "error",
           "-start_number", str(start), "-framerate", str(fps), "-i", pattern,
           "-vf", vf]
    if codec == "av1":
        cmd += ["-c:v", "libsvtav1", "-crf", str(crf + 12), "-preset", "6",
                "-svtav1-params", "keyint=1"]
    else:
        cmd += ["-c:v", "libx265", "-crf", str(crf), "-preset", "medium",
                "-x265-params", "keyint=1:min-keyint=1:scenecut=0",
                "-tag:v", "hvc1"]
    if hdr_tags:
        cmd += ["-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                "-color_trc", "arib-std-b67"]
    else:
        cmd += ["-colorspace", "bt709", "-color_primaries", "bt709",
                "-color_trc", "bt709"]
    cmd += ["-movflags", "+faststart", out_path]
    return cmd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--fps", type=float, default=25)
    ap.add_argument("--codec", choices=["hevc", "av1"], default="hevc")
    ap.add_argument("--sdr", action="store_true")
    ap.add_argument("--hdr", action="store_true")
    ap.add_argument("--proxy", action="store_true")
    args = ap.parse_args()

    pattern, start, count, ext = scan_frames(args.frames_dir)
    first_frame = pattern % start
    width, height = probe_size(first_frame)
    os.makedirs(args.out_dir, exist_ok=True)
    is_exr = ext == "exr"

    # EXR carries linear Rec.709 (the render contract); LDR formats are sRIn.
    sdr_vf = (
        "zscale=tin=linear:pin=bt709:t=bt709:p=bt709:m=bt709,format=yuv420p"
        if is_exr
        else "format=yuv420p"
    )
    hdr_vf = (
        "zscale=tin=linear:pin=bt709:t=arib-std-b67:p=bt2020:m=bt2020nc:npl=1000,"
        "format=yuv420p10le"
    )
    proxy_vf = ("zscale=tin=linear:pin=bt709:t=bt709:p=bt709:m=bt709," if is_exr else "") + \
        "scale=512:-2,format=yuv420p"

    jobs = []
    if args.sdr:
        jobs.append(("previewSdr", f"{args.label}_sdr.mp4", sdr_vf, False, False, 18))
    if args.hdr:
        if is_exr:
            jobs.append(("previewHdr", f"{args.label}_hdr.mp4", hdr_vf, True, True, 18))
        else:
            print(f"skipping HDR: input .{ext} is not EXR", file=sys.stderr)
    if args.proxy:
        jobs.append(("proxy", f"{args.label}_proxy.mp4", proxy_vf, False, False, 24))

    for kind, name, vf, ten_bit, hdr_tags, crf in jobs:
        out_path = os.path.join(args.out_dir, name)
        cmd = build_cmd(pattern, start, args.fps, vf, out_path, args.codec, ten_bit, hdr_tags, crf)
        subprocess.run(cmd, check=True)
        out_w, out_h = (512, int(height * 512 / width) // 2 * 2) if kind == "proxy" else (width, height)
        print(json.dumps({
            "kindKey": kind,
            "file": os.path.join("previews", name).replace(os.sep, "/"),
            "fps": args.fps,
            "frames": count,
            "width": out_w,
            "height": out_h,
            "codec": args.codec,
            "hdr": hdr_tags,
        }), flush=True)


if __name__ == "__main__":
    main()
