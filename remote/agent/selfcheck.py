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
  * a failed state said only "failed", with exitCode null even for a crash, so
    the app retried a scene error on every node exactly like a flaky one; and a
    state write that failed (a full disk) left the spec in the inbox, where the
    next scan launched it again.
  * the 60 s heartbeat keeps updatedAt fresh for a Blender that is alive but
    hung, so the state had no way to say "no frame for an hour".
  * a chunk sent again after an app restart rendered its whole range again,
    rewriting frames under manifest lines whose hashes no longer matched.
    These cases drive the real run_render and process() against a scripted
    fake `blender`, and are skipped on Windows, where its `#!/bin/sh` wrapper
    cannot run.
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
if script.get("record"):
    with open(script["record"], "a") as f:
        env = {k: v for k, v in os.environ.items() if k.startswith("VR_")}
        f.write(json.dumps({"argv": argv, "env": env}) + "\n")
attempt = script["opengl" if "--gpu-backend" in argv else "default"]
out = os.path.dirname(argv[argv.index("-o") + 1])
exprs = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--python-expr"]
# Overwrite off: unchecked in the .blend, or turned off by an expression.
no_overwrite = script.get("noOverwrite") or any("use_overwrite" in e for e in exprs)


def frames():
    if "-f" in argv:
        found = []
        for part in argv[argv.index("-f") + 1].split(","):
            a, _, b = part.partition("..")
            found += range(int(a), int(b or a) + 1)
        return found
    step = int(argv[argv.index("-j") + 1]) if "-j" in argv else 1
    return range(int(argv[argv.index("-s") + 1]), int(argv[argv.index("-e") + 1]) + 1, step)


for line in attempt.get("print", []):
    print(line, flush=True)
if "render" in attempt:
    # The frames argv asks for, as -a or -f renders them.
    for n in frames():
        path = os.path.join(out, "%04d.exr" % n)
        if no_overwrite and os.path.exists(path):
            print('skipping existing frame "%s"' % path, flush=True)
            continue
        print("Fra:%d Mem:1.00M | Rendering" % n, flush=True)
        with open(path, "w") as f:
            f.write("%s%d" % (attempt["render"], n))
        print("Saved: '%s'" % path, flush=True)
for name, body, announce in attempt.get("write", []):
    path = os.path.join(out, name)
    if no_overwrite and os.path.exists(path):
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

    Script shape: {"default": attempt, "opengl": attempt, "noOverwrite": bool,
    "record": path}, where "opengl" is the attempt run with `--gpu-backend
    opengl` and an attempt is {"print": [line], "render": body,
    "write": [[name, body, announce]], "exit": code}, acted out in that order.
    "render" renders the frames argv asks for (-s/-e/-j, or -f) as NNNN.exr
    holding body + the frame number, with "Fra:" and "Saved:" lines. In
    "write", `announce` True prints Blender's "Saved:" line, and "error" its
    "cannot save" line, after which the fake stops writing, as Blender does.
    Overwrite is off, skipping any frame already on disk, when `noOverwrite`
    says the .blend has it unchecked or a --python-expr sets use_overwrite.
    "record" appends each run's argv and VR_* environment to a JSON-lines file.
    """
    names = ("ROOT", "RENDERS", "STATE", "LOGS", "BLENDER_ROOT", "INBOX", "DONE", "FAILED",
             "CONTROL", "size_stable", "SETTLE_PAUSE", "write_state")
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
        nr.INBOX = os.path.join(tmp, "jobs", "inbox")
        nr.DONE = os.path.join(tmp, "jobs", "done")
        nr.FAILED = os.path.join(tmp, "jobs", "failed")
        nr.CONTROL = os.path.join(tmp, "control")
        bin_dir = os.path.join(nr.BLENDER_ROOT, "fake")
        for d in (nr.RENDERS, nr.STATE, nr.LOGS, nr.INBOX, nr.DONE, nr.FAILED, nr.CONTROL,
                  bin_dir, os.path.join(tmp, "work", "scenes")):
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


def chunk_spec(tmp, script, grid=(1, 3, 1), engine="cycles", **extra):
    """Chunk c1's spec, with `script` saved as its "blend file"."""
    with open(os.path.join(tmp, "work", "scenes", "s.blend"), "w") as f:
        json.dump(script, f)
    spec = {
        "chunkId": "c1", "blendFile": "s.blend", "blenderVersion": "fake", "engine": engine,
        "frameStart": grid[0], "frameEnd": grid[1], "frameStep": grid[2],
    }
    spec.update(extra)
    return spec


def frame_entries():
    try:
        with open(os.path.join(nr.RENDERS, "c1", "manifest.jsonl")) as f:
            entries = [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []
    return [e for e in entries if e.get("kind", "frame") == "frame"]


def render(tmp, script, grid=(1, 3, 1), engine="cycles", **extra):
    """run_render chunk c1 against `script`. Returns (error or None, frame manifest lines)."""
    spec = chunk_spec(tmp, script, grid, engine, **extra)
    err = None
    try:
        nr.run_render(spec, os.path.join(nr.LOGS, "c1.log"),
                      nr.FrameTracker(os.path.join(nr.RENDERS, "c1")))
    except RuntimeError as e:
        err = str(e)
    return err, frame_entries()


def run_chunk(tmp, script, grid=(1, 3, 1), engine="cycles", gpu=None, **extra):
    """Chunk c1 through process(), from the inbox, as the agent's main loop runs
    it. Returns (the state the app would read, frame manifest lines)."""
    spec_path = os.path.join(nr.INBOX, "c1.json")
    with open(spec_path, "w") as f:
        json.dump(chunk_spec(tmp, script, grid, engine, **extra), f)
    nr.process(spec_path, gpu)
    with open(os.path.join(nr.STATE, "c1.json")) as f:
        state = json.load(f)
    return state, frame_entries()


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
        }}, grid=(1, 5, 2))
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
        }, grid=(1, 2, 1), engine="eevee")
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
        }, grid=(1, 2, 1), engine="eevee")
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
        }, grid=(1, 2, 1), engine="eevee")
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
        }, grid=(1, 3, 1), engine="eevee")
        check("eevee: a re-dispatched chunk with frames recorded is still retried",
              err is None
              and sorted(e["file"] for e in entries)
              == ["frames/0001.exr", "frames/0002.exr", "frames/0003.exr"])


def test_failed_state_says_why():
    """1.17: every failed state carries errorKind, exitCode and a logTail."""
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {
            "print": ["Fra:1 Mem:12.00M | Syncing Cube"],
            "write": [["0001.exr", "trun", False]], "exit": 1,
        }})
        check("crash: a transient failure, with Blender's exit code",
              state.get("status") == "failed" and state.get("errorKind") == "transient"
              and state.get("exitCode") == 1 and state.get("error") == "blender exited 1")
        tail = state.get("logTail")
        check("crash: logTail ends with the log's last lines",
              isinstance(tail, list) and any("render exit code 1" in s for s in tail)
              and tail[-1] == "=== FAILED (transient): blender exited 1")
        check("crash: the failure keeps what the render had reported",
              state.get("currentFrame") == 1 and " -b " in (state.get("command") or ""))
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {
            "write": [["0001.exr", "part", "error"]], "exit": 0,
        }})
        check("write error: the node's disk, exit code 0 kept",
              state.get("errorKind") == "machine" and state.get("exitCode") == 0)
    for printed, kind in (
        ("Error: script failed, file: '/root/vastai/blender/run_startup_scripts.py', exiting.",
         "scene"),
        ("Error: script failed, expr: 'import my_addon; my_addon.register()', exiting.", "job"),
    ):
        with fake_node() as tmp:
            make_chunk(tmp)
            state, _ = run_chunk(tmp, {"default": {"print": [printed], "exit": nr.GUARD_EXIT}})
            check(f"guard exit: a raising {kind} script is errorKind {kind}",
                  state.get("errorKind") == kind and state.get("exitCode") == nr.GUARD_EXIT)
    with fake_node() as tmp:
        make_chunk(tmp)
        os.remove(os.path.join(nr.BLENDER_ROOT, "fake", "blender"))
        state, _ = run_chunk(tmp, {"default": {}})
        check("no Blender on the node: machine, and no exit code because none ran",
              state.get("errorKind") == "machine" and state.get("exitCode") is None
              and isinstance(state.get("logTail"), list))
    check("a disk errno is the machine's", nr.failure_kind(OSError(28, "full")) == ("machine", None))
    check("an unexplained exception is transient", nr.failure_kind(ValueError("x")) == ("transient", None))


def test_full_disk_still_retires_the_spec():
    """1.17 / #81: a state that cannot be written must not strand the spec in the
    inbox, where every scan of the main loop would launch it again."""
    with fake_node() as tmp:
        make_chunk(tmp)
        spec_path = os.path.join(nr.INBOX, "c1.json")
        with open(spec_path, "w") as f:
            json.dump(chunk_spec(tmp, {"default": {"exit": 0}}), f)

        def full(_chunk_id, _state):
            raise OSError(28, "No space left on device")

        nr.write_state = full  # fake_node restores it
        raised = None
        try:
            nr.process(spec_path)
        except Exception as e:  # noqa: BLE001
            raised = e
        check("full disk: process() does not raise", raised is None)
        check("full disk: the spec leaves the inbox for failed/",
              not os.path.exists(spec_path) and os.path.exists(os.path.join(nr.FAILED, "c1.json")))


def test_last_progress_at():
    """1.7 / #77: a hung Blender keeps updatedAt fresh through the heartbeat, so
    progress needs its own clock that only frames move."""
    st, seen = {}, {}
    stamps = []
    for line, now in (
        ("Fra:1 Mem:12.00M | Syncing Cube", 100.0),
        ("Fra:1 Mem:12.00M | Sample 64/128", 160.0),  # same frame: not progress
        ("Saved: '/x/frames/0001.exr'", 170.0),
        ("Fra:2 Mem:12.00M | Syncing Cube", 200.0),
        ("Warning: something unrelated", 250.0),
    ):
        nr.scan_line(line, st, seen, now)
        stamps.append(st.get("lastProgressAt"))
    check("lastProgressAt moves on a new frame or a saved one, never on samples or chatter",
          stamps == [100.0, 100.0, 170.0, 200.0, 200.0])
    with tempfile.TemporaryDirectory() as tmp:
        original = nr.STATE
        nr.STATE = tmp
        try:
            nr.write_state("c1", {"status": "rendering", "lastProgressAt": 5.0})
            with open(os.path.join(tmp, "c1.json")) as f:
                written = json.load(f)
        finally:
            nr.STATE = original
        check("the heartbeat's write refreshes updatedAt and leaves lastProgressAt alone",
              written["lastProgressAt"] == 5.0 and written["updatedAt"] > 5.0)


def test_render_publishes_last_progress():
    with fake_node() as tmp:
        make_chunk(tmp)
        started = time.time()
        state, _ = run_chunk(tmp, {"default": {"write": [["0001.exr", "a", True]], "exit": 0}},
                             grid=(1, 1, 1))
        stamp = state.get("lastProgressAt")
        check("a render publishes lastProgressAt",
              isinstance(stamp, float) and started <= stamp <= state["updatedAt"])


def finished_frame(cdir, name, body):
    """A frame an earlier attempt finished: on disk, manifested with its hash."""
    with open(os.path.join(cdir, "frames", name), "w") as f:
        f.write(body)
    with open(os.path.join(cdir, "manifest.jsonl"), "a") as f:
        f.write(json.dumps({"kind": "frame", "file": "frames/" + name,
                            "size": len(body), "sha256": sha(body)}) + "\n")


def disk(cdir):
    out = {}
    for name in sorted(os.listdir(os.path.join(cdir, "frames"))):
        with open(os.path.join(cdir, "frames", name)) as f:
            out[name] = f.read()
    return out


def test_restart_renders_only_missing_frames():
    """1.9 / #79 #145 #183: a chunk sent again after an app restart (provision.sh
    killed its Blender) re-rendered its whole range. A frame rewritten before
    the app downloaded it no longer matched its manifest line, and failed
    verification until the chunk ran out of retries."""
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        finished_frame(cdir, "0001.exr", "old1")
        finished_frame(cdir, "0002.exr", "old2")
        state, entries = run_chunk(tmp, {"default": {"render": "new"}}, grid=(1, 3, 1))
        on_disk = disk(cdir)
        check("restart: the frames already rendered are not rendered again",
              on_disk.get("0001.exr") == "old1" and on_disk.get("0002.exr") == "old2"
              and "skipping existing frame" in render_log())
        check("restart: the missing frame is rendered and the chunk is done",
              on_disk.get("0003.exr") == "new3" and state.get("status") == "done")
        check("restart: every manifest line matches the bytes on disk",
              sorted(e["file"] for e in entries)
              == ["frames/0001.exr", "frames/0002.exr", "frames/0003.exr"]
              and all(e.get("sha256") == sha(on_disk[e["file"][7:]]) for e in entries))


def test_explicit_frame_list():
    """1.9: the app may name the frames to render; only those are rendered."""
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        rec = os.path.join(tmp, "runs.jsonl")
        state, entries = run_chunk(tmp, {"record": rec, "default": {"render": "f"}},
                                   grid=(1, 9, 1), frames=[9, 1, 2, 3, 7])
        with open(rec) as f:
            argv = json.loads(f.readline())["argv"]
        check("frame list: -f with its runs, and no -a",
              "-f" in argv and argv[argv.index("-f") + 1] == "1..3,7,9" and "-a" not in argv)
        check("frame list: exactly those frames are rendered and counted",
              sorted(disk(cdir)) == ["0001.exr", "0002.exr", "0003.exr", "0007.exr", "0009.exr"]
              and len(entries) == 5 and state.get("framesTotal") == 5)
        scripts = [i for i, a in enumerate(argv) if a in ("-P", "--python-expr")]
        overwrite = [i for i in scripts if "use_overwrite" in argv[i + 1]]
        check("Overwrite goes off after every other script, and before the render",
              len(overwrite) == 1 and overwrite[0] == max(scripts)
              and overwrite[0] < argv.index("-o"))
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {"render": "f"}}, grid=(1, 9, 2), frames=[1, 4])
        check("frame list: a frame off the chunk's grid fails the job before anything renders",
              state.get("errorKind") == "job" and state.get("exitCode") is None
              and os.listdir(os.path.join(nr.RENDERS, "c1", "frames")) == [])
    with fake_node() as tmp:
        make_chunk(tmp)
        rec = os.path.join(tmp, "runs.jsonl")
        state, _ = run_chunk(tmp, {"record": rec, "default": {"render": "f"}}, frames=[])
        check("frame list: an empty list is done without starting Blender",
              state.get("status") == "done" and state.get("framesTotal") == 0
              and not os.path.exists(rec))


def test_log_tail():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "c1.log")
        with open(path, "w") as f:
            for i in range(5000):
                f.write(f"line {i}\n")
            f.write("x" * 5000 + "\n")
        tail = nr.log_tail(path)
        check("logTail: the last 40 lines, each capped",
              len(tail) == nr.LOG_TAIL_LINES and tail[-2] == "line 4999" and len(tail[-1]) == 400)
        check("logTail: a missing log is an empty tail", nr.log_tail(path + ".gone") == [])


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


def run(fn):
    """Run one case. A case that raises is a failure, not the end of the suite."""
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        check(f"{fn.__name__} ran to the end (raised {type(e).__name__}: {e})", False)


def main():
    for fn in (
        test_plan_launches,
        test_backfill_skips_unmanifested,
        test_per_frame_failures_are_tolerated,
        test_resubscribe_fills_the_gap,
        test_write_state_under_threads,
        test_sweep_filters,
        test_preview_sequence,
        test_log_tail,
        test_last_progress_at,
    ):
        run(fn)
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
        test_failed_state_says_why,
        test_full_disk_still_retires_the_spec,
        test_render_publishes_last_progress,
        test_restart_renders_only_missing_frames,
        test_explicit_frame_list,
    ):
        if os.name == "nt":
            print(f"SKIP  {fn.__name__}: the fake blender needs a POSIX shell")
            continue
        run(fn)
    print()
    if FAILED:
        print("FAILURES: " + ", ".join(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
