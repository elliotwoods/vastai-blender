"""Render the chunk's frames from Python, reporting where each frame's time goes.

The agent runs this last, in place of Blender's own `-a` or `-f`, when the
spec asks for it (renderDriver, Cycles only). It renders exactly what those
would: one `render(animation=True)` per run of frames, over the `-o` pattern
the command line set, with Overwrite as the agent's expression left it (off),
so a frame already on disk is skipped and every frame saved prints Blender's
own "Saved:" line. Verified against `-a` on Blender 5.1: the same pixels, and
the scene is evaluated once a frame, as `-a` does. One `render()` a frame
(write_still) evaluated the scene a second time after each one.

What it adds is the timing. Blender's `-a` shows none of it in a form the agent
can use, and the GPU sits idle for everything but the sampling. It reports,
one line each:
    VR_DRIVER {"event": "ready", "t": epoch s}
                    the scene is loaded and every script before this one ran:
                    the agent times the load from its launch to here
    Fra:<n> | VR driver
                    frame n starts: Blender's `-a` prints its own "Fra:" lines,
                    which the agent's progress watch reads; the operator
                    prints none
    VR_FRAME {"frame": n, "evalS", "syncS", "sampleS", "saveS", "t"}
                    frame n is rendered and saved. evalS: the render
                    depsgraph (animation, modifiers, geometry nodes) up to
                    Cycles' first status; syncS: Cycles' scene sync, BVH and
                    upload to the device, up to its first "Sample"; sampleS:
                    the sampling; saveS: compositing and the file write. A
                    phase whose status line never came is null
    VR_DRIVER {"event": "failed", "error": str}
                    the operator raised; Blender then exits RENDER_FAILED_EXIT,
                    not the guard's exit code: a render that fails is no verdict
                    on the scene's scripts
    VR_DRIVER {"event": "done", "t": epoch s}

Input, from the agent: VR_DRIVER_RUNS, a JSON list of [start, end, step], each
run rendered in order.
"""

import json
import os
import re
import sys
import time

import bpy

# Blender's exit for a render the operator failed; the agent reads it as it
# reads any other non-zero exit (not GUARD_EXIT, the scene scripts' code).
RENDER_FAILED_EXIT = 1

# Cycles' status text, as render_stats passes it: "Mem: 2M | Sample 0/256",
# "Mem: 24M | Finished". Before Cycles X (3.0): "Path Tracing Sample 1/128",
# "Path Tracing Tile 3/12".
SAMPLING_RE = re.compile(r"\bSample \d+/\d+|Path Tracing")
FINISHED_RE = re.compile(r"\|\s*Finished\b")


def say(tag, payload):
    print(f"{tag} {json.dumps(payload)}", flush=True)


class FrameClock:
    """One frame's phase boundaries, from Blender's render handlers."""

    def __init__(self):
        self.reset(None)

    def reset(self, frame):
        self.frame = frame
        self.pre = self.status = self.sampling = self.finished = None

    def on_pre(self, scene, *_):
        self.reset(scene.frame_current)
        self.pre = time.monotonic()
        print(f"Fra:{self.frame} | VR driver", flush=True)

    def on_stats(self, stats, *_):
        if self.pre is None or self.finished is not None:
            return
        now = time.monotonic()
        text = stats if isinstance(stats, str) else ""
        if self.status is None:
            self.status = now
        if self.sampling is None and SAMPLING_RE.search(text):
            self.sampling = now
        if self.sampling is not None and FINISHED_RE.search(text):
            self.finished = now

    def on_post(self, *_):
        if self.pre is None:
            return
        now = time.monotonic()

        def span(a, b):
            return round(b - a, 3) if a is not None and b is not None else None

        say("VR_FRAME", {
            "frame": self.frame,
            "evalS": span(self.pre, self.status),
            "syncS": span(self.status, self.sampling),
            "sampleS": span(self.sampling, self.finished),
            "saveS": span(self.finished, now),
            "t": time.time(),
        })
        self.reset(None)


def runs_from_env():
    runs = json.loads(os.environ.get("VR_DRIVER_RUNS") or "[]")
    return [(int(a), int(b), max(1, int(c))) for a, b, c in runs]


def main():
    scene = bpy.context.scene
    clock = FrameClock()
    handlers = bpy.app.handlers
    hooks = [
        (handlers.render_pre, clock.on_pre),
        (handlers.render_stats, clock.on_stats),
        (handlers.render_post, clock.on_post),
    ]
    for chain, fn in hooks:
        chain.append(fn)
    say("VR_DRIVER", {"event": "ready", "t": time.time()})
    kept = (scene.frame_start, scene.frame_end, scene.frame_step)
    try:
        for start, end, step in runs_from_env():
            # Start first: Blender pushes the end up to it, and the end is
            # then set to its own value, never below it.
            scene.frame_start = start
            scene.frame_end = end
            scene.frame_step = step
            bpy.ops.render.render(animation=True)
    except Exception as e:  # noqa: BLE001 — reported, then Blender exits
        say("VR_DRIVER", {"event": "failed", "error": f"{type(e).__name__}: {e}"[:300]})
        sys.stdout.flush()
        sys.exit(RENDER_FAILED_EXIT)
    finally:
        for chain, fn in hooks:
            if fn in chain:
                chain.remove(fn)
        scene.frame_start, scene.frame_end, scene.frame_step = kept
    say("VR_DRIVER", {"event": "done", "t": time.time()})


main()
