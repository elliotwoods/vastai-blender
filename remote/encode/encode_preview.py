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
import shutil
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

# The frame names the agent manifests (the app's manifest.ts FILE_PATTERNS.frame
# holds the same grammar): the zero-padded frame number, an optional view
# suffix from a stereo/multiview scene that saves each view to its own file
# (`_L`, `_R`, or a custom view name), and the format's extension, which a
# scene with File Extensions off leaves out. 0042.exr, 0042_L.png, 0042.
FRAME_RE = re.compile(r"^(\d{1,9})([A-Za-z_-][A-Za-z0-9_-]{0,62})?(?:\.([A-Za-z0-9]{1,8}))?$")

# Leading bytes of the formats Blender writes, for frames saved without an
# extension: ffmpeg's image2 demuxer picks its decoder from the extension.
MAGIC = [
    (b"\x89PNG", "png"),
    (b"\x76\x2f\x31\x01", "exr"),
    (b"\xff\xd8\xff", "jpg"),
    (b"II*\x00", "tif"),
    (b"MM\x00*", "tif"),
    (b"BM", "bmp"),
    (b"DDS ", "dds"),
    (b"\x80\x2a\x5f\xd7", "cin"),
    (b"SDPX", "dpx"),
    (b"XPDS", "dpx"),
]


def plan_sequence(names):
    """Pick the frames one preview clip is made of, from a chunk's frames/ listing.

    Returns (picked, step, view, ext): `picked` is one source name per clip
    frame, in order. A clip is one view — the plain frames when there are any,
    else `_L`, else the first view name — because ffmpeg reads a single
    numbered pattern and a preview needs only one eye.

    Clip index i must stay frame `first + i * step`: the app maps a clip frame
    back to a Blender frame by that arithmetic (jobClipPlan, frame-domain).
    ffmpeg's `%04d` + `-start_number` reads until the first missing number, so
    a frame step above 1 used to give a one-frame clip that still claimed the
    file count, and a gap cut the clip short with every later frame shifted. So
    the step is inferred from the numbers, and a missing frame holds the
    previous one rather than closing the gap.
    """
    by_view = {}
    for name in names:
        m = FRAME_RE.match(name)
        if m:
            by_view.setdefault(m.group(2) or "", []).append((int(m.group(1)), (m.group(3) or "").lower(), name))
    if not by_view:
        return [], 1, "", ""
    view = "" if "" in by_view else ("_L" if "_L" in by_view else sorted(by_view)[0])
    frames = by_view[view]
    # One format per clip: the most common extension wins (a stray leftover in
    # another format must not become the clip's decoder).
    exts = {}
    for _, ext, _ in frames:
        exts[ext] = exts.get(ext, 0) + 1
    ext = max(sorted(exts), key=lambda e: exts[e])
    numbered = sorted({n: name for n, e, name in frames if e == ext}.items())
    nums = [n for n, _ in numbered]
    diffs = [b - a for a, b in zip(nums, nums[1:])]
    step = min(diffs) if diffs else 1
    have = dict(numbered)
    picked, last = [], None
    for n in range(nums[0], nums[-1] + 1, step):
        last = have.get(n, last)
        picked.append(last)
    return picked, step, view, ext


def sniff_ext(path):
    try:
        with open(path, "rb") as f:
            head = f.read(8)
    except OSError:
        return ""
    for magic, ext in MAGIC:
        if head.startswith(magic):
            return ext
    return ""


def link_sequence(frames_dir, picked, ext, seq_dir):
    """Symlink the picked frames as seq_dir/000000.<ext>, 000001.<ext>, …

    A dense, extension-bearing sequence is the one input ffmpeg's image2
    demuxer reads without surprises, whatever the originals were called.
    """
    os.makedirs(seq_dir, exist_ok=True)
    if not ext:
        ext = sniff_ext(os.path.join(frames_dir, picked[0])) or "png"
    for i, name in enumerate(picked):
        os.symlink(os.path.join(os.path.abspath(frames_dir), name), os.path.join(seq_dir, f"{i:06d}.{ext}"))
    return os.path.join(seq_dir, f"%06d.{ext}"), ext


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

    picked, step, view, ext = plan_sequence(os.listdir(args.frames_dir))
    if not picked:
        raise SystemExit("no numbered frames found in " + args.frames_dir)
    count = len(picked)
    if step != 1 or view or len(set(picked)) != count:
        print(
            f"sequence: {count} clip frames, step {step}, view {view or '(single)'}, "
            f"{count - len(set(picked))} held over a gap",
            file=sys.stderr,
        )
    os.makedirs(args.out_dir, exist_ok=True)
    seq_dir = os.path.join(args.out_dir, f".seq-{args.label}")
    shutil.rmtree(seq_dir, ignore_errors=True)
    try:
        pattern, ext = link_sequence(args.frames_dir, picked, ext, seq_dir)
        encode_all(args, pattern, ext, count)
    finally:
        shutil.rmtree(seq_dir, ignore_errors=True)


def encode_all(args, pattern, ext, count):
    start = 0
    width, height = probe_size(pattern % start)
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
        # The app trusts "frames" to map clip index -> Blender frame, so a
        # clip that came out shorter or longer is not published at all.
        got = probe_frames(out_path)
        if got != count:
            os.remove(out_path)
            raise SystemExit(f"{name}: encoded {got} frames, expected {count} — clip discarded")
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
