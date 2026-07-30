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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preview_common import (  # noqa: E402
    FFMPEG,
    FFPROBE,
    X265_INTRA,
    build_vf,
    colour_tags,

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
    # -nostdin: these run under tmux and would otherwise inherit the agent's
    # stdin, where a stray byte turns into an ffmpeg keypress command.
    cmd = [FFMPEG, "-y", "-nostdin", "-loglevel", "error",
           "-start_number", str(start), "-framerate", str(fps), "-i", pattern,
           "-vf", vf]
    if codec == "av1":
        cmd += ["-c:v", "libsvtav1", "-crf", str(crf + 12), "-preset", "6",
                "-svtav1-params", "keyint=1"]
    else:
        cmd += ["-c:v", "libx265", "-crf", str(crf), "-preset", "medium",
                "-x265-params", X265_INTRA, "-tag:v", "hvc1"]

    cmd += colour_tags(hdr_tags)
    cmd += ["-movflags", "+faststart", out_path]
    return cmd


def remux_live(args):
    """Wrap the accumulated Annex-B stream in MP4 without re-encoding.

    The stream is built one frame at a time by live_preview.py (one encode per
    frame, ever) and this just containerises it — so a preview that grows to N
    frames costs N encodes total, not the O(N²/cadence) that re-encoding the
    whole chunk-so-far on every emission would.

    `hev1`, not `hvc1`: hev1 explicitly permits in-band parameter sets, which
    is what libx265 emits when no global header is requested. Whether ffmpeg
    preserves them across an `hvc1` -c copy remux is unconfirmed, and the
    definitive clips (which are encoded in one pass) keep hvc1 regardless.
    """
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    cmd = [FFMPEG, "-y", "-nostdin", "-loglevel", "error",
           "-r", str(args.fps), "-f", "hevc", "-i", args.stream,
           "-c", "copy", "-tag:v", "hev1",
           "-video_track_timescale", "12800"]
    cmd += colour_tags(args.hdr)
    cmd += ["-movflags", "+faststart", args.out]
    subprocess.run(cmd, check=True)
    frames = probe_frames(args.out)
    width, height = probe_size(args.out)
    print(json.dumps({
        "kindKey": "live",
        "file": os.path.join("previews", os.path.basename(args.out)).replace(os.sep, "/"),
        "fps": args.fps,
        "frames": frames,
        "width": width,
        "height": height,
        "codec": "hevc",
        "hdr": bool(args.hdr),
    }), flush=True)


def probe_frames(path):
    out = subprocess.check_output(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=nb_read_frames", "-of", "json", path],
        text=True,
    )
    try:
        return int(json.loads(out)["streams"][0]["nb_read_frames"])
    except (KeyError, IndexError, ValueError, TypeError):
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir")
    ap.add_argument("--out-dir")
    ap.add_argument("--label")
    ap.add_argument("--fps", type=float, default=25)
    ap.add_argument("--codec", choices=["hevc", "av1"], default="hevc")
    ap.add_argument("--sdr", action="store_true")
    ap.add_argument("--hdr", action="store_true")
    ap.add_argument("--proxy", action="store_true")
    # Live remux mode: containerise an accumulated Annex-B stream.
    ap.add_argument("--remux-live", action="store_true")
    ap.add_argument("--stream", help="live.h265 to containerise")
    ap.add_argument("--out", help="output mp4 for --remux-live")
    args = ap.parse_args()

    if args.remux_live:
        if not args.stream or not args.out:
            raise SystemExit("--remux-live needs --stream and --out")
        remux_live(args)
        return

    if not (args.frames_dir and args.out_dir and args.label):
        raise SystemExit("--frames-dir, --out-dir and --label are required")

    pattern, start, count, ext = scan_frames(args.frames_dir)
    first_frame = pattern % start
    width, height = probe_size(first_frame)
    os.makedirs(args.out_dir, exist_ok=True)
    is_exr = ext == "exr"

    # Shared with live_preview.py — see preview_common.build_vf for why.
    sdr_vf = build_vf(is_exr)
    hdr_vf = build_vf(is_exr, hdr=True) if is_exr else None
    proxy_vf = build_vf(is_exr, width=512)

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
