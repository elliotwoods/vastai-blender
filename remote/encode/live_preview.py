#!/usr/bin/env python3
"""Per-frame preview encoder — runs ON the node, once per rendered frame.

Two outputs from ONE decode of the source frame:

  --thumb-out   a small JPEG. The render itself is usually EXR, which no
                browser can decode, so without this the app has no image to
                show at all until a chunk finishes and its clip is encoded.
  --au-out      a single-frame All-Intra HEVC access unit in raw Annex-B.
                Appending these to one .h265 file builds a playable stream as
                the render goes (see --remux-live in encode_preview.py) at a
                cost of one encode per frame, rather than re-encoding the
                whole chunk-so-far on every emission.

Decoding a 2K half-float EXR is the expensive part, so asking for both in one
invocation (a `split` filter graph) rather than two is the single biggest cost
saving available here.

Prints one JSON line per produced artefact, like encode_preview.py.
Stdlib only.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preview_common import (  # noqa: E402
    FFMPEG,
    X265_INTRA_PINNED,
    build_vf,
    colour_tags,

)


def build_cmd(args, is_exr):
    """One ffmpeg invocation, one input decode, up to two outputs."""
    # nice: this is strictly less important than the render it runs beside.
    # Conditional so the script is runnable off-node (Windows has no `nice`),
    # which is what makes the encode chain testable without renting a machine.
    # -threads/-filter_threads 1 for the same reason as pools=none — see
    # preview_common.X265_INTRA_PINNED.
    cmd = ["nice", "-n", "19"] if shutil.which("nice") else []
    cmd += [FFMPEG, "-y", "-nostdin", "-loglevel", "error",
            "-threads", "1", "-filter_threads", "1", "-i", args.frame]

    want_au = bool(args.au_out)
    want_thumb = bool(args.thumb_out)
    au_vf = build_vf(is_exr, width=args.width, hdr=args.hdr and is_exr)
    thumb_vf = build_vf(is_exr, width=args.thumb_width)

    if want_au and want_thumb:
        # split=2 — decode once, filter twice.
        cmd += ["-filter_complex",
                "[0:v]split=2[a][b];[a]%s[v];[b]%s[t]" % (au_vf, thumb_vf)]
        au_map = ["-map", "[v]"]
        thumb_map = ["-map", "[t]"]
    elif want_au:
        cmd += ["-vf", au_vf]
        au_map = []
        thumb_map = []
    else:
        cmd += ["-vf", thumb_vf]
        au_map = []
        thumb_map = []

    if want_au:
        cmd += au_map + [
            "-c:v", "libx265", "-crf", str(args.crf), "-preset", "veryfast",
            "-x265-params", X265_INTRA_PINNED,
        ] + colour_tags(args.hdr and is_exr) + [
            "-frames:v", "1", "-f", "hevc", args.au_out,
        ]
    if want_thumb:
        # -atomic_writing: the app's downloader trusts the manifest, and the
        # manifest is written after this returns — but the agent also
        # size-stability-checks files, and a torn JPEG is the one thing that
        # check cannot see. Let ffmpeg rename it into place instead.
        cmd += thumb_map + [
            "-c:v", "mjpeg", "-q:v", str(args.thumb_quality),
            "-frames:v", "1", "-f", "image2", "-update", "1",
            "-atomic_writing", "1", args.thumb_out,
        ]
    return cmd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frame", required=True, help="source frame (EXR/PNG/JPG)")
    ap.add_argument("--thumb-out")
    ap.add_argument("--thumb-width", type=int, default=320)
    ap.add_argument("--thumb-quality", type=int, default=5, help="mjpeg -q:v, 2=best")
    ap.add_argument("--au-out", help="single-frame Annex-B HEVC output")
    ap.add_argument("--width", type=int, default=960, help="live clip width")
    ap.add_argument("--crf", type=int, default=22)
    ap.add_argument("--hdr", action="store_true", help="10-bit HLG live clip (EXR only)")
    args = ap.parse_args()

    if not args.thumb_out and not args.au_out:
        raise SystemExit("nothing to do: pass --thumb-out and/or --au-out")

    is_exr = os.path.splitext(args.frame)[1].lower() == ".exr"
    cmd = build_cmd(args, is_exr)
    r = subprocess.run(cmd, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        # stderr, not an exception trace: the caller turns any failure into
        # "disable live preview for this chunk", never into a failed render.
        sys.stderr.write(r.stderr or "")
        raise SystemExit(r.returncode)

    if args.thumb_out and os.path.exists(args.thumb_out):
        print(json.dumps({"kindKey": "thumb", "path": args.thumb_out,
                          "width": args.thumb_width}), flush=True)
    if args.au_out and os.path.exists(args.au_out):
        print(json.dumps({"kindKey": "au", "path": args.au_out,
                          "width": args.width, "hdr": bool(args.hdr and is_exr)}), flush=True)


if __name__ == "__main__":
    main()
