#!/usr/bin/env python3
"""Self-check for the parts of noderunner.py that are easy to get wrong.

`remote/` is the one place with no automated coverage — it runs unattended on
rented hardware, where a mistake costs money and a whole render. This is its
suite: stdlib only, no ffmpeg, no node, no network. `npm test` and CI run it
(`npm run test:remote` on its own); run it after touching anything in remote/.

    python3 remote/agent/selfcheck.py

Covers the failure modes that actually bit:

  * `write_state` used one temp filename per CHUNK, so the 60s heartbeat and the
    render loop raced on it and whichever lost `os.replace` raised — killing
    either the heartbeat (silently ending the anti-stall refresh) or the render
    loop (failing a healthy chunk).
  * the live backfill listed `frames/` directly, feeding ffmpeg the frame blender
    was mid-write on and truncated leftovers from a killed render — and one such
    failure disabled thumbnails and the live clip for the whole chunk.
  * the backfill ran once, so closing and reopening the preview left a permanent
    hole in the append-only stream and clip indices stopped mapping to frames.
  * run_render's end-of-render sweep adopted ANY size-stable file in `frames/`,
    even after Blender crashed, so the frame it died writing (or a leftover from
    a killed earlier attempt) was manifested with a hash over truncated bytes —
    and the app verified against that hash, accepted it and never re-rendered it.
    A frame Blender could not write ("cannot save", e.g. a full disk) took the
    same route when Blender still exited 0.
  * the EEVEE OpenGL retry deleted a frame the first attempt had finished but
    not yet flushed, and was skipped for a re-dispatched chunk whose manifest
    already held frames.
    These cases drive the real run_render against a scripted fake `blender`,
    and are skipped on Windows, where its `#!/bin/sh` wrapper cannot run.
"""

import contextlib
import hashlib
import json
import os
import shlex
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import noderunner as nr  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "encode"))
import encode_preview as ep  # noqa: E402

FAILED = []


def check(name, cond):
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond:
        FAILED.append(name)


def make_chunk(tmp, frames=(), manifested=()):
    """A chunk dir with `frames` on disk and `manifested` recorded."""
    cdir = os.path.join(tmp, "renders", "c1")
    os.makedirs(os.path.join(cdir, "frames"), exist_ok=True)
    for n in frames:
        with open(os.path.join(cdir, "frames", n), "w") as f:
            f.write("x")
    with open(os.path.join(cdir, "manifest.jsonl"), "w") as f:
        for n in manifested:
            f.write(json.dumps({"kind": "frame", "file": "frames/" + n}) + "\n")
    return cdir


def worker(cdir, live_on):
    """A PreviewWorker whose `live_wanted` follows `live_on[0]`.

    Subclassing rather than setting an attribute: `live_wanted` is a property, so
    this keeps the real rising-edge code path under test.
    """
    w = nr.PreviewWorker("c1", cdir, {"thumbs": False, "live": {"mode": "onDemand"}})
    w.__class__ = type(
        "StubbedWorker", (nr.PreviewWorker,), {"live_wanted": property(lambda s: live_on[0])}
    )
    return w


def test_backfill_skips_unmanifested():
    with tempfile.TemporaryDirectory() as tmp:
        # 0003 is on disk but never manifested: mid-write, or a truncated corpse.
        cdir = make_chunk(tmp, ["0001.exr", "0002.exr", "0003.exr"], ["0001.exr", "0002.exr"])
        w = worker(cdir, [True])
        seen = []
        w._one = lambda p: seen.append(os.path.basename(p))
        w._maybe_emit = lambda: None
        w._backfill_live()
        check("backfill encodes only manifested frames", seen == ["0001.exr", "0002.exr"])


def test_per_frame_failures_are_tolerated():
    with tempfile.TemporaryDirectory() as tmp:
        cdir = make_chunk(tmp, ["0001.exr"], ["0001.exr"])
        frame = os.path.join(cdir, "frames", "0001.exr")

        w = worker(cdir, [True])
        w._one = lambda p: (_ for _ in ()).throw(RuntimeError("ffmpeg boom"))
        w._one_tolerant(frame)
        check("one bad frame does not disable previews", w.disabled_reason is None)
        for _ in range(nr.PREVIEW_FAIL_LIMIT - 1):
            w._one_tolerant(frame)
        check("a run of failures does stand the worker down", w.disabled_reason is not None)

        w2 = worker(cdir, [True])
        calls = []

        def flaky(path):
            calls.append(path)
            if len(calls) == 1:
                raise RuntimeError("transient")

        w2._one = flaky
        w2._one_tolerant(frame)
        w2._one_tolerant(frame)
        check("a success resets the failure streak", w2._fail_streak == 0)


def test_resubscribe_fills_the_gap():
    with tempfile.TemporaryDirectory() as tmp:
        cdir = make_chunk(tmp)
        live = [True]
        w = worker(cdir, live)
        appended = []

        def fake_one(path):
            """Stands in for the real append, with the same dedupe rule."""
            stem = os.path.splitext(os.path.basename(path))[0]
            if w.live_wanted and stem not in w.live_done:
                w.live_done.add(stem)
                appended.append(stem)

        w._one = fake_one
        w._maybe_emit = lambda: None

        def land(names):
            with open(os.path.join(cdir, "manifest.jsonl"), "a") as f:
                for n in names:
                    open(os.path.join(cdir, "frames", n), "w").close()
                    f.write(json.dumps({"kind": "frame", "file": "frames/" + n}) + "\n")

        land(["0001.exr", "0002.exr"])
        w._backfill_live()
        # Mark the stream so a re-subscribe deleting it would be visible.
        os.makedirs(w.previews_dir, exist_ok=True)
        with open(w.stream_path, "w") as f:
            f.write("AU")

        live[0] = False
        w._backfill_live()
        land(["0003.exr", "0004.exr"])
        check("nothing is appended while unsubscribed", appended == ["0001", "0002"])

        live[0] = True
        w._backfill_live()
        check(
            "re-subscribing fills the gap, in frame order",
            appended == ["0001", "0002", "0003", "0004"],
        )
        check("the destructive stream reset stays one-shot", os.path.exists(w.stream_path))

        before = list(appended)
        w._backfill_live()
        check("the steady state is a no-op", appended == before)


def test_write_state_under_threads():
    with tempfile.TemporaryDirectory() as tmp:
        original = nr.STATE
        nr.STATE = os.path.join(tmp, "state")
        os.makedirs(nr.STATE, exist_ok=True)
        try:
            # One shared dict, as the render loop and heartbeat really do.
            state = {"status": "rendering", "framesDone": 0}
            errors = []

            def hammer():
                for i in range(150):
                    try:
                        state["framesDone"] = i
                        nr.write_state("c1", state)
                    except Exception as e:  # noqa: BLE001
                        errors.append(repr(e))

            threads = [threading.Thread(target=hammer) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            check("concurrent write_state never raises", not errors)
            with open(os.path.join(nr.STATE, "c1.json")) as f:
                check("the published state is always valid JSON", isinstance(json.load(f), dict))
            check(
                "no temp files are left behind",
                not [n for n in os.listdir(nr.STATE) if n.endswith(".tmp")],
            )
        finally:
            nr.STATE = original


# Stands in for Blender: acts out the "blend file", which is a JSON script
# rather than a scene. Frames are written straight to their final name, as
# Blender does, so a file written without a "Saved:" line is exactly what a
# crash mid-write leaves behind.
FAKE_BLENDER = r"""
import json, os, sys
argv = sys.argv[1:]
with open(argv[argv.index("-b") + 1]) as f:
    script = json.load(f)
attempt = script["opengl" if "--gpu-backend" in argv else "default"]
out = os.path.dirname(argv[argv.index("-o") + 1])
for line in attempt.get("print", []):
    print(line, flush=True)
for name, body, announce in attempt.get("write", []):
    path = os.path.join(out, name)
    if script.get("noOverwrite") and os.path.exists(path):
        print("skipping existing frame '%s'" % path, flush=True)
        continue
    with open(path, "w") as f:
        f.write(body)
    if announce == "error":
        # Blender's report for a failed write. It stops the animation there,
        # whatever exit code follows.
        print("Error: Render error (No space left on device) cannot save: '%s'" % path,
              flush=True)
        break
    if announce:
        print("Saved: '%s'" % path, flush=True)
sys.exit(attempt.get("exit", 0))
"""


@contextlib.contextmanager
def fake_node():
    """A throwaway ~/vastai whose `blender` is FAKE_BLENDER. Yields its root.

    Script shape: {"default": attempt, "opengl": attempt, "noOverwrite": bool},
    where "opengl" is the attempt run with `--gpu-backend opengl` and an attempt
    is {"print": [line], "write": [[name, body, announce]], "exit": code}.
    "print" lines come first. `announce` True prints Blender's "Saved:" line,
    and "error" its "cannot save" line, after which the fake stops writing, as
    Blender does. `noOverwrite` mimics a .blend with Overwrite unchecked, which
    skips any frame already on disk.
    """
    names = ("ROOT", "RENDERS", "STATE", "LOGS", "BLENDER_ROOT", "size_stable", "SETTLE_PAUSE")
    saved = {k: getattr(nr, k) for k in names}
    with tempfile.TemporaryDirectory() as tmp:
        # The agent watches a frame's size for 0.5-1 s, and pauses 0.5 s between
        # settle passes, for Blender's slow writes. The fake writes each file
        # whole and then exits, and the real waits made these cases ~20 s of
        # every `npm test`.
        real_stable = saved["size_stable"]
        nr.size_stable = lambda path, wait=1.0: real_stable(path, wait=0.01)
        nr.SETTLE_PAUSE = 0.01
        nr.ROOT = tmp
        nr.RENDERS = os.path.join(tmp, "renders")
        nr.STATE = os.path.join(tmp, "state")
        nr.LOGS = os.path.join(tmp, "logs")
        nr.BLENDER_ROOT = os.path.join(tmp, "blender")
        bin_dir = os.path.join(nr.BLENDER_ROOT, "fake")
        for d in (nr.RENDERS, nr.STATE, nr.LOGS, bin_dir, os.path.join(tmp, "work", "scenes")):
            os.makedirs(d, exist_ok=True)
        script = os.path.join(bin_dir, "fake_blender.py")
        with open(script, "w") as f:
            f.write(FAKE_BLENDER)
        exe = os.path.join(bin_dir, "blender")
        with open(exe, "w") as f:
            f.write('#!/bin/sh\nexec %s %s "$@"\n' % (shlex.quote(sys.executable), shlex.quote(script)))
        os.chmod(exe, 0o755)
        try:
            yield tmp
        finally:
            for k, v in saved.items():
                setattr(nr, k, v)


def render(tmp, script, frames=(1, 3, 1), engine="cycles"):
    """run_render chunk c1 against `script`. Returns (error or None, frame manifest lines)."""
    with open(os.path.join(tmp, "work", "scenes", "s.blend"), "w") as f:
        json.dump(script, f)
    spec = {
        "chunkId": "c1", "blendFile": "s.blend", "blenderVersion": "fake", "engine": engine,
        "frameStart": frames[0], "frameEnd": frames[1], "frameStep": frames[2],
    }
    cdir = os.path.join(nr.RENDERS, "c1")
    err = None
    try:
        nr.run_render(spec, os.path.join(nr.LOGS, "c1.log"), nr.FrameTracker(cdir))
    except RuntimeError as e:
        err = str(e)
    with open(os.path.join(cdir, "manifest.jsonl")) as f:
        entries = [json.loads(line) for line in f if line.strip()]
    return err, [e for e in entries if e.get("kind", "frame") == "frame"]


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def render_log():
    with open(os.path.join(nr.LOGS, "c1.log")) as f:
        return f.read()


def test_crashed_render_adopts_nothing_unannounced():
    with fake_node() as tmp:
        cdir = make_chunk(tmp, ["0001.exr"], ["0001.exr"])
        err, entries = render(tmp, {"default": {
            # 0002 finished and was announced; blender died writing 0003.
            "write": [["0002.exr", "whole", True], ["0003.exr", "trun", False]],
            "exit": 1,
        }})
        files = [e["file"] for e in entries]
        check("a crashed render fails the chunk", err == "blender exited 1")
        check("crash: the frame blender died writing is not manifested",
              "frames/0003.exr" not in files)
        check("crash: frames announced before the crash still are", "frames/0002.exr" in files)
        check("crash: an already-manifested frame is kept",
              files.count("frames/0001.exr") == 1
              and os.path.exists(os.path.join(cdir, "frames", "0001.exr")))
        # Not left for this chunk's next attempt here: the app may re-dispatch
        # it to another node, and the partial would sit on this disk for good.
        check("crash: the partial frame is deleted at once",
              sorted(os.listdir(os.path.join(cdir, "frames"))) == ["0001.exr", "0002.exr"])


def test_write_error_is_a_failed_frame():
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        # The disk fills while 0002 is written: Blender reports it, stops the
        # animation and exits 0 anyway, leaving a partial 0002 on the grid.
        err, entries = render(tmp, {"default": {
            "write": [["0001.exr", "whole", True], ["0002.exr", "part", "error"]],
            "exit": 0,
        }})
        files = [e["file"] for e in entries]
        check("write error: the chunk fails although blender exited 0",
              (err or "").startswith("blender could not save 0002.exr (exit 0)"))
        check("write error: the frame blender could not save is not manifested",
              "frames/0002.exr" not in files)
        check("write error: its partial file is deleted",
              not os.path.exists(os.path.join(cdir, "frames", "0002.exr")))
        check("write error: frames saved before it are kept",
              files == ["frames/0001.exr"]
              and os.path.exists(os.path.join(cdir, "frames", "0001.exr")))
    with fake_node() as tmp:
        make_chunk(tmp)
        # Where Blender exits non-zero after it, EEVEE must not be retried on
        # OpenGL: the GPU backend worked, the disk did not.
        err, _entries = render(tmp, {"default": {
            "write": [["0001.exr", "part", "error"]], "exit": 1,
        }}, engine="eevee")
        check("write error: no OpenGL retry for EEVEE",
              "retrying" not in render_log()
              and (err or "").startswith("blender could not save 0001.exr (exit 1)"))


def test_stale_leftovers_are_discarded():
    with fake_node() as tmp:
        # 0001 was finished and manifested by an earlier run of this chunk. 0002
        # and 0007 are what a killed run left mid-write; 0007 is from before the
        # chunk was narrowed to 1-3.
        cdir = make_chunk(tmp, ["0001.exr", "0002.exr", "0007.exr"], ["0001.exr"])
        # Overwrite unchecked in the .blend: blender skips frames already on
        # disk, so a leftover that is not deleted first is never replaced.
        err, entries = render(tmp, {"noOverwrite": True, "default": {
            "write": [["0001.exr", "new1", True], ["0002.exr", "new2", True],
                      ["0003.exr", "new3", True]],
            "exit": 0,
        }})
        by_file = {e["file"]: e for e in entries}
        check("stale: the render succeeds", err is None)
        check("stale: a leftover is deleted before blender starts",
              not os.path.exists(os.path.join(cdir, "frames", "0007.exr")))
        check("stale: no leftover bytes are ever manifested",
              "frames/0007.exr" not in by_file
              and by_file.get("frames/0002.exr", {}).get("sha256") == sha("new2"))
        with open(os.path.join(cdir, "frames", "0001.exr")) as f:
            check("stale: a manifested frame survives the new attempt untouched",
                  f.read() == "x" and [e["file"] for e in entries].count("frames/0001.exr") == 1)


def test_clean_render_is_manifested():
    with fake_node() as tmp:
        make_chunk(tmp)
        # Frames 1, 3, 5 on a step-2 grid; 3 and 5 without their "Saved:" line.
        # The rest are not this chunk's frames at all.
        err, entries = render(tmp, {"default": {
            "write": [["0001.exr", "a", True], ["0003.exr", "b", False],
                      ["0005.exr", "c", False], ["0002.exr", "d", False],
                      ["0009.exr", "e", False], ["notes.txt", "f", False]],
            "exit": 0,
        }}, frames=(1, 5, 2))
        check("clean: the render succeeds", err is None)
        check("clean: every frame on the grid is manifested, announced or swept, and nothing else",
              sorted(e["file"] for e in entries)
              == ["frames/0001.exr", "frames/0003.exr", "frames/0005.exr"])


def test_eevee_opengl_retry():
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        # Vulkan attempt dies mid-write of frame 1; the OpenGL retry renders
        # 1 (skipping it if the corpse were still there) and 2 unannounced.
        err, entries = render(tmp, {
            "noOverwrite": True,
            "default": {"write": [["0001.exr", "vk", False]], "exit": 1},
            "opengl": {"write": [["0001.exr", "gl1", True], ["0002.exr", "gl2", False]], "exit": 0},
        }, frames=(1, 2, 1), engine="eevee")
        by_file = {e["file"]: e for e in entries}
        check("eevee: a failed first attempt is retried on OpenGL and succeeds", err is None)
        check("eevee: the retry's frames are manifested", sorted(by_file) == ["frames/0001.exr", "frames/0002.exr"])
        check("eevee: the failed attempt's corpse is discarded, not adopted",
              by_file.get("frames/0001.exr", {}).get("sha256") == sha("gl1"))
        check("eevee: the discard is logged", "discarded 1 unmanifested" in render_log())
        check("eevee: frames/ holds only manifested frames",
              sorted(os.listdir(os.path.join(cdir, "frames"))) == ["0001.exr", "0002.exr"])


def test_eevee_retry_keeps_finished_frames():
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        # Vulkan renders frame 1, announces it and dies on frame 2, all within
        # the 2 s between in-loop flushes, so 1 is still pending at the exit.
        # Were the chunk retried, the OpenGL attempt would fail at startup.
        err, entries = render(tmp, {
            "default": {"print": ["Fra:1 Mem:12.00M | Syncing Cube"],
                        "write": [["0001.exr", "vk1", True]], "exit": 1},
            "opengl": {"exit": 1},
        }, frames=(1, 2, 1), engine="eevee")
        by_file = {e["file"]: e for e in entries}
        check("eevee: a frame the failed attempt finished is manifested and kept",
              by_file.get("frames/0001.exr", {}).get("sha256") == sha("vk1")
              and os.path.exists(os.path.join(cdir, "frames", "0001.exr")))
        check("eevee: no OpenGL retry once the first attempt produced a frame",
              "retrying" not in render_log() and err == "blender exited 1")


def test_eevee_retry_forgets_unrecorded_announcements():
    """FrameTracker.forget_pending: the retry inherits no announcement."""
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        # Vulkan announces 0001 but leaves it empty, so it never becomes
        # size-stable and stays pending. The OpenGL retry then dies writing
        # 0001 without announcing it. Under the stale announcement, its
        # truncated bytes would be manifested.
        err, entries = render(tmp, {
            "default": {"write": [["0001.exr", "", True]], "exit": 1},
            "opengl": {"write": [["0001.exr", "trun", False]], "exit": 1},
        }, frames=(1, 2, 1), engine="eevee")
        check("retry: runs when the first attempt recorded nothing",
              "retrying with --gpu-backend opengl" in render_log() and err == "blender exited 1")
        check("retry: a stale announcement cannot manifest the retry's partial frame",
              "frames/0001.exr" not in [e["file"] for e in entries])
        check("retry: nothing unmanifested is left in frames/",
              os.listdir(os.path.join(cdir, "frames")) == [])


def test_eevee_retry_on_a_redispatched_chunk():
    with fake_node() as tmp:
        # 0003 was finished by an earlier run of this chunk on this node, so the
        # manifest is not empty when Vulkan fails to start this time.
        make_chunk(tmp, ["0003.exr"], ["0003.exr"])
        err, entries = render(tmp, {
            "default": {"exit": 1},
            "opengl": {"write": [["0001.exr", "gl1", True], ["0002.exr", "gl2", True]],
                       "exit": 0},
        }, frames=(1, 3, 1), engine="eevee")
        check("eevee: a re-dispatched chunk with frames recorded is still retried",
              err is None
              and sorted(e["file"] for e in entries)
              == ["frames/0001.exr", "frames/0002.exr", "frames/0003.exr"])


def test_sweep_filters():
    with tempfile.TemporaryDirectory() as tmp:
        cdir = make_chunk(tmp, ["0001.exr", "0002.exr", "0003.exr", "0004.exr"])
        frames = os.path.join(cdir, "frames")
        # 0003 predates the attempt, as a leftover discard_unmanifested failed to delete would.
        os.utime(os.path.join(frames, "0003.exr"), (time.time() - 600,) * 2)
        spec = {"frameStart": 1, "frameEnd": 4, "frameStep": 1}
        got = nr.unannounced_frames(frames, spec, time.time() - 60, {"frames/0001.exr"})
        check("the sweep skips recorded frames and files older than the attempt",
              [os.path.basename(p) for p in got] == ["0002.exr", "0004.exr"])


def test_plan_launches():
    """GPU lanes: exclusive chunks one per lane, pinned to distinct GPUs."""
    ex = lambda lanes=1, pin=False: {"exclusive": True, "lanes": lanes, "pinGpus": pin}  # noqa: E731
    sh = lambda pin=False: {"exclusive": False, "nodeSlots": 4, "pinGpus": pin}  # noqa: E731
    q = [(f"c{i}", ex(4, True)) for i in range(6)]
    got = nr.plan_launches(q, [], 4, 1)
    check("4 lanes start 4 exclusive chunks", [n for n, _ in got] == ["c0", "c1", "c2", "c3"])
    check("each lands on its own GPU", sorted(g for _, g in got) == [0, 1, 2, 3])
    got = nr.plan_launches(q, [(True, 0), (True, 2), (True, 3)], 4, 1)
    check("a freed lane is refilled on the free GPU", got == [("c0", 1)])
    got = nr.plan_launches([(f"c{i}", ex(8, True)) for i in range(8)], [], 4, 1)
    check("2 per GPU spreads evenly", sorted(g for _, g in got) == [0, 0, 1, 1, 2, 2, 3, 3])
    check("legacy: one exclusive owns the node",
          nr.plan_launches([("a", ex()), ("b", ex())], [], 4, 1) == [("a", None)])
    check("legacy: exclusive waits for shared work to drain",
          nr.plan_launches([("a", ex(4, True))], [(False, 0)], 4, 4) == [])
    check("shared never joins exclusive work",
          nr.plan_launches([("s", sh(True))], [(True, 0)], 4, 4) == [])
    check("FIFO: an exclusive head is not overtaken",
          nr.plan_launches([("a", ex()), ("s", sh())], [(False, None)], 1, 4) == [])
    got = nr.plan_launches([(f"s{i}", sh(True)) for i in range(4)], [], 2, 4)
    check("shared work is pinned least-loaded", [g for _, g in got] == [0, 1, 0, 1])
    check("no pinning on a single-GPU node",
          nr.plan_launches([("a", ex(2, True)), ("b", ex(2, True))], [], 1, 1)
          == [("a", None), ("b", None)])


def test_preview_sequence():
    """encode_preview: one clip frame per Blender frame on the chunk's step grid."""
    names = lambda ns, fmt="{:04d}.png": [fmt.format(n) for n in ns]  # noqa: E731
    picked, step, view, ext = ep.plan_sequence(names(range(1, 5)))
    check("plain frames: every file, step 1", (picked, step, view, ext) == (names(range(1, 5)), 1, "", "png"))
    picked, step, _, _ = ep.plan_sequence(names(range(1, 10, 2)))
    check("frame step 2: all five frames, not one", picked == names(range(1, 10, 2)) and step == 2)
    picked, _, _, _ = ep.plan_sequence(names([1, 2, 4, 5]))
    check("a gap holds the previous frame so later frames keep their index",
          picked == ["0001.png", "0002.png", "0002.png", "0004.png", "0005.png"])
    stereo = names(range(1, 4), "{:04d}_L.png") + names(range(1, 4), "{:04d}_R.png")
    picked, _, view, _ = ep.plan_sequence(stereo)
    check("stereo: one clip of the left view", view == "_L" and picked == names(range(1, 4), "{:04d}_L.png"))
    picked, _, view, ext = ep.plan_sequence(["0001", "0002", "0003"])
    check("frames saved without an extension are found", picked == ["0001", "0002", "0003"] and ext == "")
    picked, _, _, ext = ep.plan_sequence(names(range(1, 4), "{:04d}.exr") + ["0002.png", "notes.txt", "live.h265"])
    check("one format per clip; strays and non-frames ignored", ext == "exr" and len(picked) == 3)
    check("no frames at all -> empty plan", ep.plan_sequence(["a.txt"])[0] == [])
    with tempfile.TemporaryDirectory() as tmp:
        frames = os.path.join(tmp, "frames")
        os.makedirs(frames)
        for n in (1, 3):
            with open(os.path.join(frames, f"{n:04d}"), "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n" + bytes(8))
        picked, _, _, ext = ep.plan_sequence(os.listdir(frames))
        pattern, ext = ep.link_sequence(frames, picked, ext, os.path.join(tmp, "seq"))
        linked = sorted(os.listdir(os.path.join(tmp, "seq")))
        check("extension-less PNGs are sniffed and linked as a dense sequence",
              ext == "png" and linked == ["000000.png", "000001.png"] and pattern.endswith("%06d.png"))


def main():
    for fn in (
        test_plan_launches,
        test_backfill_skips_unmanifested,
        test_per_frame_failures_are_tolerated,
        test_resubscribe_fills_the_gap,
        test_write_state_under_threads,
        test_sweep_filters,
        test_preview_sequence,
    ):
        fn()
    # Through fake_node, whose `blender` is a `#!/bin/sh` wrapper that Windows
    # cannot exec. The agent itself only ever runs on Linux nodes.
    for fn in (
        test_crashed_render_adopts_nothing_unannounced,
        test_write_error_is_a_failed_frame,
        test_stale_leftovers_are_discarded,
        test_clean_render_is_manifested,
        test_eevee_opengl_retry,
        test_eevee_retry_keeps_finished_frames,
        test_eevee_retry_forgets_unrecorded_announcements,
        test_eevee_retry_on_a_redispatched_chunk,
    ):
        if os.name == "nt":
            print(f"SKIP  {fn.__name__}: the fake blender needs a POSIX shell")
            continue
        fn()
    print()
    if FAILED:
        print("FAILURES: " + ", ".join(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
