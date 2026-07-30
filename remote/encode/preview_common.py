#!/usr/bin/env python3
"""Shared colour chain for every preview encode on the node.

The whole point of this module is that `encode_preview.py` (the definitive
per-chunk clips, produced once at the end) and `live_preview.py` (one frame at
a time, while the render is still going) MUST agree pixel for pixel. They
don't run together, they don't even run at the same stage, and the user sees
them one after the other in the same viewer — so any divergence in the zscale
chain shows up as a colour pop at the live→definitive handoff and gets
diagnosed as a rendering bug forever. One `build_vf()`, both callers.

Stdlib only, like everything else that ships to the node.
"""

import os

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

# npl is the luminance that linear 1.0 maps to. At npl=1000 (HLG's nominal
# peak) EXR linear 1.0 lands at HLG peak, so everything above diffuse white
# clipped BEFORE encode and the clip carried 10-bit precision but no range.
# BT.2408 reference white leaves ~2.3 stops of headroom, which is what the
# viewer-side exposure control recovers.
#
# Paired with HLG_SCENE_SCALE in src/renderer/src/media/GradeRenderer.ts —
# change one and you must change the other.
HLG_NPL = 203

# x265 params for a genuinely All-Intra stream.
#
# open-gop=0 is NOT optional: x265's --open-gop defaults to ENABLED ("allows I
# slices to be non-IDR"), so keyint=1:min-keyint=1 alone yields a stream of
# non-IDR CRA pictures rather than the every-frame-seekable stream these
# previews promise.
#
# pools=none:frame-threads=1 is NOT optional either: x265 sizes its thread
# pools from the HOST core count, not the container's cgroup quota, so an
# unpinned per-frame invocation can spawn dozens of threads to encode one
# small still — on a machine whose cores are already the render bottleneck.
X265_INTRA = "keyint=1:min-keyint=1:scenecut=0:open-gop=0"
X265_INTRA_PINNED = X265_INTRA + ":pools=none:frame-threads=1:info=0"


def build_vf(is_exr, width=None, hdr=False):
    """Video-filter chain from a render frame to a display-referred encode.

    is_exr — EXR carries linear Rec.709 (the render contract) and needs the
             zscale conversion; LDR formats are already display-referred.
    width  — scale to this width (even height), or None for native size.
    hdr    — 10-bit HLG BT.2020 instead of 8-bit Rec.709. EXR only: there is
             no meaningful HDR to recover from an 8-bit sRGB source.
    """
    if hdr and not is_exr:
        raise ValueError("HDR output requires EXR input")
    parts = []
    if hdr:
        parts.append(
            "zscale=tin=linear:pin=bt709:t=arib-std-b67:p=bt2020:m=bt2020nc:npl=%d" % HLG_NPL
        )
    elif is_exr:
        parts.append("zscale=tin=linear:pin=bt709:t=bt709:p=bt709:m=bt709")
    if width:
        # min(iw,W): the width is a CAP, never a target. Plain `scale=W:-2`
        # UPSCALES a smaller render — a 512px scene became a soft 960px clip
        # that then got blown up again in the viewer. A preview must never be
        # larger than the frame it previews.
        parts.append("scale=w='min(iw\\,%d)':h=-2" % width)
    parts.append("format=yuv420p10le" if hdr else "format=yuv420p")
    return ",".join(parts)


# A note for the next person to run ffprobe on these clips: an All-Intra 8-bit
# 4:2:0 stream reports `profile=Rext`, not `Main`. That is correct — x265 calls
# it "Main Intra", and intra-only profiles are defined in the Range Extensions
# family (general_profile_idc 4). It is the same profile the definitive
# preview clips have always used, and they play. Forcing `-profile:v main` does
# nothing here; measured, not assumed.


def colour_tags(hdr):
    """Stream colour tags matching build_vf's output."""
    if hdr:
        return ["-colorspace", "bt2020nc", "-color_primaries", "bt2020",
                "-color_trc", "arib-std-b67"]
    return ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
