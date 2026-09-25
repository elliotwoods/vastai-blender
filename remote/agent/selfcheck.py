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
  * an Octane job on a node without OctaneBlender rendered with stock Blender,
    in another engine, and completed.
  * nothing checked the scene: a texture or library it did not pack, an
    unbaked simulation split across chunks, or a movie output rendered wrong
    on every node, completed and was billed. preflight.py and the other
    remote/blender/ scripts run here against a stand-in `bpy`.
  * Cycles with no GPU to enable rendered on the CPU at GPU prices, and the
    EEVEE OpenGL retry keyed on the job's engine label, not the scene's.
  * a GPU out of memory was reported as a bare exit code, and a frame
    Blender wrote after it could be manifested.
  * GPU lanes were pinned for every engine, though only Cycles honours the
    pin, and one failed nvidia-smi turned pinning off for good, silently.
    These cases drive the real run_render and process() against a scripted
    fake `blender`, and are skipped on Windows, where its `#!/bin/sh` wrapper
    cannot run.
"""

import contextlib
import hashlib
import io
import json
import os
import runpy
import shlex
import shutil
import sys
import tempfile
import threading
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import noderunner as nr  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "encode"))
import encode_preview as ep  # noqa: E402

FAILED = []
REMOTE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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
if attempt.get("pidFile"):
    # This process and, with "child", one it starts, as a script a .blend runs might.
    pids = [os.getpid()]
    if attempt.get("child"):
        import subprocess
        pids.append(subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]).pid)
    if attempt.get("ignoreTerm"):
        import signal
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(attempt["pidFile"], "w") as f:
        json.dump(pids, f)
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
for line in attempt.get("bytes", []):
    # Written as Latin-1: bytes that are not UTF-8, as a path in a .blend can be.
    sys.stdout.buffer.write(line.encode("latin-1") + b"\n")
    sys.stdout.buffer.flush()
if "render" in attempt:
    # The frames argv asks for, as -a or -f renders them; with "views", one
    # file per view, and a frame is skipped when any one of them exists.
    views = attempt.get("views") or [""]
    for n in frames():
        paths = [os.path.join(out, "%04d%s.exr" % (n, v)) for v in views]
        if no_overwrite and any(os.path.exists(p) for p in paths):
            print('skipping existing frame "%s"' % paths[0], flush=True)
            continue
        print("Fra:%d Mem:1.00M | Rendering" % n, flush=True)
        for path, view in zip(paths, views):
            with open(path, "w") as f:
                f.write("%s%d%s" % (attempt["render"], n, view))
            print("Saved: '%s'" % path, flush=True)
for entry in attempt.get("write", []):
    name, body, announce = entry[:3]
    for line in entry[3:]:
        print(line, flush=True)
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
if attempt.get("sleep"):
    import time
    time.sleep(attempt["sleep"])
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
    holding body + the frame number, with "Fra:" and "Saved:" lines; with
    "views" (["_L", "_R"]), as one NNNN_L.exr per view, as Blender does. In
    "write", `announce` True prints Blender's "Saved:" line, and "error" its
    "cannot save" line, after which the fake stops writing, as Blender does;
    any further items in an entry are lines printed before it is written.
    "sleep" seconds pass before the exit. "bytes" lines are printed Latin-1
    encoded, after "print". "pidFile" gets a JSON list of the fake's pid and,
    with "child", that of a process it starts; "ignoreTerm" makes the fake
    ignore SIGTERM.
    Overwrite is off, skipping any frame already on disk, when `noOverwrite`
    says the .blend has it unchecked or a --python-expr sets use_overwrite.
    "record" appends each run's argv and VR_* environment to a JSON-lines file.
    """
    names = ("ROOT", "RENDERS", "STATE", "LOGS", "BLENDER_ROOT", "INBOX", "DONE", "FAILED",
             "CONTROL", "OCTANE_BLENDER", "ENCODE_SCRIPT", "size_stable", "SETTLE_PAUSE",
             "BLENDER_STOP_GRACE", "write_state")
    saved = {k: getattr(nr, k) for k in names}
    with tempfile.TemporaryDirectory() as tmp:
        # The agent watches a frame's size for 0.5-1 s, and pauses 0.5 s between
        # settle passes, for Blender's slow writes. The fake writes each file
        # whole and then exits, and the real waits made these cases ~20 s of
        # every `npm test`.
        real_stable = saved["size_stable"]
        nr.size_stable = lambda path, wait=1.0: real_stable(path, wait=0.01)
        nr.SETTLE_PAUSE = 0.01
        nr.BLENDER_STOP_GRACE = 1.0
        nr.ROOT = tmp
        nr.RENDERS = os.path.join(tmp, "renders")
        nr.STATE = os.path.join(tmp, "state")
        nr.LOGS = os.path.join(tmp, "logs")
        nr.BLENDER_ROOT = os.path.join(tmp, "blender")
        nr.INBOX = os.path.join(tmp, "jobs", "inbox")
        nr.DONE = os.path.join(tmp, "jobs", "done")
        nr.FAILED = os.path.join(tmp, "jobs", "failed")
        nr.CONTROL = os.path.join(tmp, "control")
        # Absent unless a case installs them.
        nr.OCTANE_BLENDER = os.path.join(tmp, "octane", "blender")
        nr.ENCODE_SCRIPT = os.path.join(tmp, "encode", "encode_preview.py")
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
        # The node's copy of remote/blender/ sits beside the Blender versions.
        # The fake never runs its scripts; the agent only checks it is there.
        open(os.path.join(nr.BLENDER_ROOT, "preflight.py"), "w").close()
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
    check("a disk errno is the machine's",
          nr.failure_kind(OSError(28, "full")) == ("machine", None))
    check("an unexplained exception is transient",
          nr.failure_kind(ValueError("x")) == ("transient", None))


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
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                nr.process(spec_path)
        except Exception as e:  # noqa: BLE001
            raised = e
        check("full disk: process() does not raise, and says what it could not write",
              raised is None and "could not write the failed state of c1" in out.getvalue())
        check("full disk: the spec leaves the inbox for failed/",
              not os.path.exists(spec_path) and os.path.exists(os.path.join(nr.FAILED, "c1.json")))


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def gone_soon(pids, timeout=3.0):
    """True once none of `pids` is alive; an orphan waits for init to reap it."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not any(alive(p) for p in pids):
            return True
        time.sleep(0.05)
    return False


def test_every_spec_leaves_the_inbox():
    """#81 (review of 1.17): process() read the spec and made the chunk dir
    before its try. On a full disk the thread died with no state written and
    the spec in the inbox, and the main loop launched it again every 2 s."""
    with fake_node() as tmp:
        make_chunk(tmp)
        spec_path = os.path.join(nr.INBOX, "c1.json")
        with open(spec_path, "w") as f:
            json.dump(chunk_spec(tmp, {"default": {"render": "f"}}), f)
        real = os.makedirs
        chunk_dir = os.path.join(nr.RENDERS, "c1")

        def full(path, *args, **kwargs):
            if os.path.abspath(path) == chunk_dir:
                raise OSError(28, "No space left on device")
            return real(path, *args, **kwargs)

        shutil.rmtree(chunk_dir)
        os.makedirs = full
        try:
            nr.process(spec_path)
        finally:
            os.makedirs = real
        with open(os.path.join(nr.STATE, "c1.json")) as f:
            state = json.load(f)
        check("full disk before the render: a failed state, errorKind machine",
              state.get("status") == "failed" and state.get("errorKind") == "machine")
        check("full disk before the render: the spec leaves the inbox",
              not os.path.exists(spec_path) and os.path.exists(os.path.join(nr.FAILED, "c1.json")))
    with fake_node() as tmp:
        spec_path = os.path.join(nr.INBOX, "c2.json")
        with open(spec_path, "w") as f:
            f.write('{"chunkId": "c2", "blendF')
        nr.process(spec_path)
        with open(os.path.join(nr.STATE, "c2.json")) as f:
            state = json.load(f)
        check("a spec that cannot be read fails under its file's name, and leaves the inbox",
              state.get("status") == "failed" and not os.path.exists(spec_path))


def test_a_failed_drain_stops_blender():
    """#81 (review of 1.17): an error out of run_once's stdout loop left Blender
    running, blocked on a pipe nobody drained, holding its GPU memory."""
    with fake_node() as tmp:
        make_chunk(tmp)
        pid_file = os.path.join(tmp, "pids.json")
        real = nr.write_state

        def filling(chunk_id, state):
            if state.get("lastLine") == "the disk fills here":
                raise OSError(28, "No space left on device")
            real(chunk_id, state)

        nr.write_state = filling  # fake_node restores it
        started = time.time()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            _state, entries = run_chunk(tmp, {"default": {
                "pidFile": pid_file, "child": True, "ignoreTerm": True,
                "print": ["the disk fills here"], "sleep": 30}})
        with open(pid_file) as f:
            pids = json.load(f)
        check("a failed drain: Blender and what it started are stopped, SIGKILL after SIGTERM",
              gone_soon(pids) and time.time() - started < 10)
        check("a failed drain: the spec leaves the inbox",
              os.path.exists(os.path.join(nr.FAILED, "c1.json")) and entries == [])
    with fake_node() as tmp:
        make_chunk(tmp)
        state, entries = run_chunk(tmp, {"default": {
            "bytes": ["Read blend: '/scenes/caf\xe9.blend'"], "render": "f"}}, grid=(1, 2, 1))
        check("output that is not UTF-8 is read, not a failure",
              state.get("status") == "done" and len(entries) == 2
              and "caf\ufffd.blend" in render_log())


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
        # The heartbeat thread serialises the dict while the render loop fills
        # these in; a key added mid-dump would fail that write.
        check("the fields scan_line fills in are there from the first write",
              {k: state.get(k, "absent") for k in ("engine", "preflight", "oom")}
              == {"engine": None, "preflight": None, "oom": False})


@contextlib.contextmanager
def fake_nvidia_smi(answer):
    """nvidia-smi, as the agent runs it, printing answer(query). Yields the
    queries it was asked, in order."""
    real = nr.subprocess.run
    calls = []

    def run(cmd, **_kw):
        if not cmd or cmd[0] != "nvidia-smi":
            return real(cmd, **_kw)
        query = next(a for a in cmd if a.startswith("--query-gpu="))
        calls.append(query)
        return types.SimpleNamespace(stdout=answer(query), returncode=0)

    nr.subprocess.run = run
    try:
        yield calls
    finally:
        nr.subprocess.run = real


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
        # The app always sends an encode block; with nothing rendered there is
        # nothing to encode, and encode_preview would fail on the empty frames/.
        state, _ = run_chunk(tmp, {"record": rec, "default": {"render": "f"}}, frames=[],
                             encode={"sdr": True, "thumbs": True})
        check("frame list: an empty list is done without starting Blender or the encoder",
              state.get("status") == "done" and state.get("framesTotal") == 0
              and not os.path.exists(rec) and "nothing to encode" in render_log())


def test_no_overwrite_expr_runs():
    """Review of 1.9: the fake Blender only looks for "use_overwrite" in argv,
    so nothing ran the expression itself. Blender runs --python-expr with one
    namespace today; with a locals dict of its own, the comprehension it was
    raised NameError on a Python before 3.12, and every render failed."""
    for render in (NS(use_overwrite=True, use_placeholder=True), NS(use_overwrite=True)):
        bpy = types.ModuleType("bpy")
        bpy.context = NS(scene=NS(render=render))
        saved = sys.modules.get("bpy")
        sys.modules["bpy"] = bpy
        err = None
        try:
            exec(nr.NO_OVERWRITE_EXPR, {}, {})
        except Exception as e:  # noqa: BLE001
            err = e
        finally:
            if saved is None:
                sys.modules.pop("bpy", None)
            else:
                sys.modules["bpy"] = saved
        check(f"the Overwrite expression runs, with {len(vars(render))} of its properties",
              err is None and render.use_overwrite is False
              and getattr(render, "use_placeholder", False) is False)
    check("the Overwrite expression is one line", "\n" not in nr.NO_OVERWRITE_EXPR)


def test_multiview_frames_are_whole():
    """Review of 1.9: with Overwrite off, Blender skips a stereo frame when any
    one view file exists. A left view manifested alone, before a kill, stayed
    on disk, and every later attempt skipped the frame: no right view, ever."""
    views = 'VR_VIEWS ["_L", "_R"]'
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        state, entries = run_chunk(tmp, {"default": {"print": [views], "write": [
            ["0001_L.exr", "l1", True], ["0001_R.exr", "r1", True],
            ["0002_L.exr", "l2", True]], "exit": 1}})
        check("stereo: a frame's views are manifested together, or not at all",
              sorted(e["file"] for e in entries) == ["frames/0001_L.exr", "frames/0001_R.exr"]
              and sorted(disk(cdir)) == ["0001_L.exr", "0001_R.exr"])
        state, entries = run_chunk(tmp, {"default": {"print": [views], "render": "new",
                                                     "views": ["_L", "_R"]}})
        on_disk = disk(cdir)
        check("stereo: the chunk sent again renders the frame it was killed in, both views",
              state.get("status") == "done"
              and sorted(on_disk) == ["0001_L.exr", "0001_R.exr", "0002_L.exr", "0002_R.exr",
                                      "0003_L.exr", "0003_R.exr"]
              and on_disk["0002_R.exr"] == "new2_R" and on_disk["0001_L.exr"] == "l1")
        check("stereo: every manifest line matches the bytes on disk",
              sorted(e["file"][7:] for e in entries) == sorted(on_disk)
              and all(e.get("sha256") == sha(on_disk[e["file"][7:]]) for e in entries))


def test_never_a_stand_in_blender():
    """1.18 / #85: an Octane job on a node without OctaneBlender rendered with
    stock Blender, which fell back to another engine; the wrong frames
    completed and were billed. A version the job names is never swapped either."""
    with fake_node() as tmp:
        make_chunk(tmp)
        rec = os.path.join(tmp, "runs.jsonl")
        state, _ = run_chunk(tmp, {"record": rec, "default": {"render": "f"}}, engine="octane")
        check("octane: no OctaneBlender fails the job, and no other Blender runs",
              state.get("errorKind") == "job" and "OctaneBlender" in (state.get("error") or "")
              and state.get("exitCode") is None and not os.path.exists(rec))
    with fake_node() as tmp:
        make_chunk(tmp)
        os.makedirs(os.path.dirname(nr.OCTANE_BLENDER))
        shutil.copy(os.path.join(nr.BLENDER_ROOT, "fake", "blender"), nr.OCTANE_BLENDER)
        state, _ = run_chunk(tmp, {"default": {"render": "f"}}, engine="octane")
        check("octane: OctaneBlender renders it when it is there",
              state.get("status") == "done" and state["command"].startswith(nr.OCTANE_BLENDER))
    with fake_node() as tmp:
        make_chunk(tmp)
        rec = os.path.join(tmp, "runs.jsonl")
        state, _ = run_chunk(tmp, {"record": rec, "default": {"render": "f"}},
                             blenderVersion="4.5.3")
        check("version: a missing version is this node's failure, not a swap for another",
              state.get("errorKind") == "machine" and "4.5.3" in (state.get("error") or "")
              and "installed: fake" in state["error"] and not os.path.exists(rec))
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {"render": "f"}}, blenderVersion=None)
        check("version: a spec that names none renders with the newest installed",
              state.get("status") == "done")

def blender_script(name, bpy, env=None):
    """Run remote/blender/<name> as Blender's -P would, against the stand-in
    `bpy`. Returns (what it raised or None, what it printed)."""
    env = env or {}
    saved_env = {k: os.environ.get(k) for k in env}
    saved_bpy = sys.modules.get("bpy")
    sys.modules["bpy"] = bpy
    os.environ.update(env)
    out = io.StringIO()
    err = None
    try:
        with contextlib.redirect_stdout(out):
            runpy.run_path(os.path.join(REMOTE, "blender", name), run_name="__main__")
    except Exception as e:  # noqa: BLE001
        err = e
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if saved_bpy is None:
            sys.modules.pop("bpy", None)
        else:
            sys.modules["bpy"] = saved_bpy
    return err, out.getvalue()


def marker(printed, tag):
    """The JSON of the first `tag {...}` line, or None."""
    for line in printed.splitlines():
        if line.startswith(tag + " "):
            return json.loads(line[len(tag) + 1:])
    return None


NS = types.SimpleNamespace


class ID(types.SimpleNamespace):
    """A stand-in datablock. Hashed and compared by identity, as bpy compares
    two handles on one ID by its pointer. `uses` lists the datablocks it
    refers to, which is what the stand-in bpy.data.user_map() inverts."""

    __hash__ = object.__hash__

    def __eq__(self, other):
        return self is other


def datablock(id_type, name, uses=(), **kw):
    fields = dict(id_type=id_type, name=name, uses=list(uses), users=1, use_fake_user=False,
                  library=None, is_missing=False, packed_file=None)
    fields.update(kw)
    return ID(**fields)


def obj(name, uses=(), type="MESH", modifiers=(), **kw):
    """An object that renders unless hide_render says otherwise."""
    fields = dict(type=type, hide_render=False, modifiers=list(modifiers), users_collection=[])
    fields.update(kw)
    return datablock("OBJECT", name, uses, **fields)


def collection(name, *objects, **kw):
    coll = datablock("COLLECTION", name, objects, objects=list(objects), hide_render=False, **kw)
    for o in objects:
        o.users_collection.append(coll)
    return coll


def drawn(*ids, name="Cube", **kw):
    """A mesh that renders (unless `kw` hides it), with a material that uses `ids`."""
    return obj(name, [datablock("MATERIAL", name + " material", ids)], **kw)


def scene_bpy(tmp, scene_objects=(), **data):
    """A stand-in bpy holding one scene, saved as <tmp>/job.blend as on a node.

    `scene_objects` are the scene's objects (and bpy.data.objects, unless
    `data` says otherwise); `data` fills bpy.data collections (images=[...],
    libraries=[...], ...); the scene is bpy.context.scene, its render
    bpy.context.scene.render. bpy.data.user_map() inverts the `uses` of every
    datablock it can reach from those, as Blender's does its ID pointers.
    """
    blend = os.path.join(tmp, "job.blend")

    def abspath(path, library=None, start=None):
        if path.startswith("//"):
            base = os.path.dirname(abspath(library.filepath) if library is not None else blend)
            return os.path.join(base, path[2:])
        return path

    render = NS(engine="CYCLES", is_movie_format=False, use_compositing=True,
                image_settings=NS(file_format="OPEN_EXR"))
    scene = datablock("SCENE", "Scene", render=render, frame_start=1,
                      objects=list(scene_objects), rigidbody_world=None, world=None,
                      use_nodes=False, node_tree=None)
    data.setdefault("objects", list(scene_objects))
    bpy = types.ModuleType("bpy")

    def user_map():
        todo = [scene, scene.world, getattr(scene, "compositing_node_group", None)]
        todo += list(scene.objects)
        for value in data.values():
            try:
                todo += list(value)
            except Exception:  # noqa: BLE001 — a collection a case broke on purpose
                pass
        found = {}
        while todo:
            idb = todo.pop()
            if isinstance(idb, ID) and idb not in found:
                found[idb] = set()
                todo += idb.uses
        for idb in list(found):
            for dep in idb.uses:
                if isinstance(dep, ID):
                    found[dep].add(idb)
        return found

    bpy.data = NS(filepath=blend, user_map=user_map, **data)
    bpy.context = NS(scene=scene)
    bpy.path = NS(abspath=abspath)
    bpy.utils = NS(blend_paths=lambda **kw: [])
    bpy.app = NS(version=(4, 2, 0))
    return bpy


def image(name, path, users=1, **kw):
    fields = dict(filepath=path, users=users, source="FILE", type="IMAGE", tiles=[])
    fields.update(kw)
    return datablock("IMAGE", name, **fields)


def cache(**kw):
    fields = dict(is_baked=False, use_disk_cache=False, use_external=False, frame_start=1,
                  filepath="")
    fields.update(kw)
    return NS(**fields)


def cloth(name="Flag", pc=None, **kw):
    return obj(name, modifiers=[NS(type="CLOTH", show_render=True, point_cache=pc or cache())],
               **kw)


def layer(coll, children=(), exclude=False, hide_render=False):
    """A view layer's LayerCollection over `coll`, a collection or its name."""
    if isinstance(coll, str):
        coll = collection(coll)
    coll.hide_render = hide_render
    return NS(collection=coll, exclude=exclude, children=list(children))


def preflight(tmp, bpy, **args):
    """(raised, report) for preflight.py over `bpy`, with VR_PREFLIGHT `args`."""
    base = {"jobChunks": None, "first": 1, "last": 50, "contiguous": True, "stepped": False,
            "resumed": False, "mode": "enforce"}
    base.update(args)
    err, printed = blender_script("preflight.py", bpy, {"VR_PREFLIGHT": json.dumps(base)})
    return err, marker(printed, "VR_PREFLIGHT")


def test_preflight_files():
    """1.16 / #246: only the .blend reaches a node. A texture, library or cache it
    refers to by path renders magenta, or as placeholders, on every chunk, and
    the job completes and is billed across the fleet."""
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "tex"))
        for name in ("ok.png", "udim.1001.png"):
            open(os.path.join(tmp, "tex", name), "w").close()
        clean = [
            image("packed", "//gone/a.png", packed_file=NS(size=1)),
            image("on disk", "//tex/ok.png"),
            image("generated", "", source="GENERATED"),
            image("render result", "", type="RENDER_RESULT"),
        ]
        fake = image("fake user only", "//gone/b.png", users=1, use_fake_user=True)
        err, report = preflight(tmp, scene_bpy(tmp, [drawn(*clean)], images=clean + [fake]))
        check("preflight: packed, present and unused files pass",
              err is None and report is not None and report["ok"] is True
              and report["warnings"] == [])

        wood = image("wood", "//tex/wood.png")
        udim = image("udim", "//tex/udim.<UDIM>.png", source="TILED",
                     tiles=[NS(number=1001), NS(number=1002)])
        err, report = preflight(tmp, scene_bpy(tmp, [drawn(*clean, wood, udim)],
                                               images=clean + [wood, udim]))
        check("preflight: a missing texture refuses the render before a frame",
              isinstance(err, RuntimeError) and str(err).startswith("scene preflight failed: ")
              and report is not None and report["ok"] is False)
        check("preflight: every missing file is named, each UDIM tile on its own",
              [(m["name"], m["path"], m["packable"]) for m in report["missing"]]
              == [("wood", "//tex/wood.png", True), ("udim", "//tex/udim.1002.png", True)]
              and "not packed into the .blend and not on the node: image 'wood' (//tex/wood.png)"
              in report["summary"])

        lib = datablock("LIBRARY", "chars.blend", filepath="//libs/chars.blend")
        other = datablock("LIBRARY", "props.blend", filepath="//tex/ok.png")
        hero = obj("Hero", is_missing=True, users=2, library=lib)
        chair = obj("Chair", is_missing=True, library=other)
        err, report = preflight(tmp, scene_bpy(tmp, [hero, chair], libraries=[lib, other]))
        check("preflight: a missing library, and data missing from one that is there",
              err is not None and [(m["kind"], m["name"]) for m in report["missing"]]
              == [("library", "chars.blend"), ("linked data", "Chair")]
              and "linked data missing from its library: linked data 'Chair'"
              in report["summary"])

        bpy = scene_bpy(tmp)
        bpy.context.scene.render.is_movie_format = True
        bpy.context.scene.render.image_settings.file_format = "FFMPEG"
        err, report = preflight(tmp, bpy)
        check("preflight: a movie output is refused (#249)",
              err is not None and "movie (FFMPEG)" in report["summary"])

        err, report = preflight(tmp, scene_bpy(tmp, [drawn(wood)], images=[wood]), mode="warn")
        check("preflight: warn mode reports without refusing",
              err is None and report["ok"] is False)

        class Broken:
            def __iter__(self):
                raise AttributeError("renamed in a later Blender")

        bpy = scene_bpy(tmp, images=Broken())
        bpy.utils.blend_paths = lambda **kw: ["/nowhere/ies/lamp.ies", "/nowhere/frame_####.png"]
        err, report = preflight(tmp, bpy)
        check("preflight: a check that breaks, and a path only blend_paths knows, only warn",
              err is None and report["ok"] is True
              and any("check_images could not run" in w for w in report["warnings"])
              and any("/nowhere/ies/lamp.ies" in w for w in report["warnings"])
              and not any("####" in w for w in report["warnings"]))


def broken_user_map():
    raise RuntimeError("user_map broke")


def test_preflight_simulations():
    """1.16 / #247: an unbaked simulation steps only frame by frame from its
    start. Every chunk but the first, and a chunk that skips frames already on
    disk, starts it cold and renders it wrong."""
    with tempfile.TemporaryDirectory() as tmp:
        def scene(*objects, **scene_kw):
            bpy = scene_bpy(tmp, objects)
            for k, v in scene_kw.items():
                setattr(bpy.context.scene, k, v)
            return bpy

        def layered(objects, *children):
            """A scene whose view layer holds `children` under its own collection."""
            return scene(*objects, view_layers=[NS(use=True, layer_collection=layer(
                "Scene Collection", children))])

        def in_collections(home):
            """A cloth in `home` of Set and WIP, whose WIP is disabled for renders."""
            flag = cloth()
            wip = collection("WIP", *([flag] if home == "WIP" else []))
            set_ = collection("Set", *([flag] if home == "Set" else []))
            return layered([flag], layer(set_), layer(wip, hide_render=True))

        def excluded(instanced):
            flag = cloth()
            wip = collection("WIP", flag)
            empties = [obj("Flags", [wip], type="EMPTY", instance_collection=wip)] if instanced else []
            return layered([flag] + empties, layer(collection("Set", *empties)),
                           layer(wip, exclude=True))

        def surface_deform():
            proxy = cloth("Proxy", hide_render=True)
            shirt = obj("Shirt", [proxy], modifiers=[
                NS(type="SURFACE_DEFORM", show_render=True, target=proxy)])
            return scene(shirt, proxy)

        def instanced_from_outside():
            props = collection("Props", cloth())
            return scene(obj("Props", [props], type="EMPTY", instance_collection=props))

        def untraced():
            bpy = scene(cloth(hide_render=True))
            bpy.data.user_map = broken_user_map
            return bpy

        cases = [
            ("split job", scene(cloth()), {"jobChunks": 3}, False),
            ("one chunk from the start", scene(cloth()), {"jobChunks": 1}, True),
            ("one chunk, frames 1-50 already on disk", scene(cloth()),
             {"jobChunks": 1, "first": 51, "last": 60, "resumed": True}, False),
            ("a frame step", scene(cloth()), {"contiguous": False, "stepped": True}, False),
            ("every frame already on disk", scene(cloth()), {"first": None, "last": None}, True),
            ("render ends before the sim starts", scene(cloth(pc=cache(frame_start=100))),
             {"jobChunks": 3}, True),
            ("starts at the scene start, after the cache's", scene(cloth(), frame_start=1001),
             {"first": 1001, "last": 1100}, True),
            ("baked into the .blend", scene(cloth(pc=cache(is_baked=True))),
             {"jobChunks": 3}, True),
            ("baked to disk, one chunk", scene(cloth(pc=cache(is_baked=True, use_disk_cache=True))),
             {"jobChunks": 1}, False),
            ("hidden, and nothing that renders uses it", scene(cloth(hide_render=True)),
             {"jobChunks": 3}, True),
            # Review of 1.16: what renders pulls in what it depends on, hidden
            # or excluded, and that simulation starts cold all the same.
            ("hidden, but a mesh that renders follows it through Surface Deform",
             surface_deform(), {"jobChunks": 3}, False),
            ("in a collection disabled for renders", in_collections("WIP"), {"jobChunks": 3}, True),
            ("in a collection the view layer excludes", excluded(False), {"jobChunks": 3}, True),
            ("in an excluded collection an empty that renders instances", excluded(True),
             {"jobChunks": 3}, False),
            ("in a collection outside the scene that an empty instances",
             instanced_from_outside(), {"jobChunks": 3}, False),
            ("hidden, when bpy cannot say what the render uses", untraced(),
             {"jobChunks": 3}, False),
            ("in a collection that renders", in_collections("Set"), {"jobChunks": 3}, False),
            ("hair without dynamics", scene(obj("Fur", modifiers=[
                NS(type="PARTICLE_SYSTEM", show_render=True, particle_system=NS(
                    settings=NS(type="HAIR", physics_type="NEWTON"), use_hair_dynamics=False,
                    point_cache=cache()))])), {"jobChunks": 3}, True),
            ("rigid body world", scene(rigidbody_world=NS(
                enabled=True, collection=NS(objects=[1]), point_cache=cache())),
             {"jobChunks": 3}, False),
            ("fluid bake on disk", scene(obj("Pool", modifiers=[
                NS(type="FLUID", show_render=True, fluid_type="DOMAIN", domain_settings=NS(
                    cache_type="ALL", has_cache_baked_any=True, cache_frame_start=1,
                    cache_directory="//cache_fluid"))])), {"jobChunks": 1}, False),
        ]
        for label, bpy, args, ok in cases:
            err, report = preflight(tmp, bpy, **args)
            check(f"preflight sim: {label} -> {'renders' if ok else 'refused'}",
                  report is not None and report["ok"] is ok and (err is None) is ok)

        # Review of 1.16: a single-chunk job sent again mid-way was told to
        # "render the job as one chunk", which it already was.
        for label, args, says in (
            ("a split job", {"jobChunks": 3}, "or render the job as one chunk"),
            ("a resumed chunk", {"jobChunks": 1, "first": 51, "last": 60, "resumed": True},
             "resumes at frame 51, after frames it had already rendered"),
            ("a resumed chunk with a gap", {"jobChunks": 1, "contiguous": False, "resumed": True},
             "skips frames it had already rendered, so it starts cold after them; bake it"
             " (Disk Cache off) and re-save, or render the chunk again from its first frame"),
            ("a frame step", {"contiguous": False, "stepped": True},
             "or render it with a frame step of 1"),
        ):
            _err, report = preflight(tmp, scene(cloth()), **args)
            problem = (report or {}).get("problems", [""])[0]
            check(f"preflight sim: the refusal of {label} says so",
                  says in problem and ("one chunk" in problem) is (label == "a split job"))


def test_preflight_reads_only_what_renders():
    """Review of 1.16: a file counted as needed because anything used it, so a
    scene that renders right was refused, non-retryably, over a file nothing it
    draws reads: a reference image, a camera's background, a brush's texture,
    the footage a camera solve was tracked from, a hidden object's cache."""
    with tempfile.TemporaryDirectory() as tmp:
        def refused(label, bpy, ok=False, **args):
            err, report = preflight(tmp, bpy, **args)
            passed = report is not None and report["ok"] is ok and (err is None) is ok
            if ok:
                # Not silent either: the artist may still want the file.
                passed = passed and any("nothing the render draws uses it" in w
                                        for w in report["warnings"])
            check(f"preflight reads: {label} -> {'renders' if ok else 'refused'}", passed)
            return report

        ref = image("reference", "//gone/ref.png")
        refused("an empty's reference image", scene_bpy(
            tmp, [obj("Ref", [ref], type="EMPTY", data=ref)], images=[ref]), ok=True)
        bg = image("background", "//gone/bg.png")
        camera = obj("Camera", [datablock("CAMERA", "Camera", [bg])], type="CAMERA")
        refused("a camera's background image", scene_bpy(tmp, [camera], images=[bg]), ok=True)
        stroke = image("stroke", "//gone/stroke.png")
        brush = datablock("BRUSH", "Draw", [datablock("TEXTURE", "Stroke", [stroke])])
        refused("a brush's texture", scene_bpy(tmp, images=[stroke], brushes=[brush]), ok=True)
        wood = image("wood", "//gone/wood.png")
        refused("a hidden object's material", scene_bpy(
            tmp, [drawn(wood, name="Crate", hide_render=True)], images=[wood]), ok=True)
        refused("a displace texture on a mesh that renders", scene_bpy(
            tmp, [obj("Ground", [datablock("TEXTURE", "Noise", [wood])])], images=[wood]))

        # A camera solve reads the tracking data saved in the .blend, not the
        # footage, and a movie clip cannot be packed at all.
        plate = datablock("MOVIECLIP", "Plate", filepath="//footage/plate.mov", users=2)
        solved = obj("Camera", [datablock("CAMERA", "Camera", [plate]), plate], type="CAMERA")
        bpy = scene_bpy(tmp, [solved], movieclips=[plate])
        bpy.context.scene.active_clip = plate
        bpy.context.scene.uses.append(plate)
        refused("a camera solve's footage", bpy, ok=True)

        def composited(on):
            bpy = scene_bpy(tmp, [drawn()], movieclips=[plate])
            bpy.context.scene.use_nodes = True
            bpy.context.scene.node_tree = NS(nodes=[
                NS(bl_idname="CompositorNodeRLayers", scene=bpy.context.scene),
                NS(bl_idname="CompositorNodeMovieClip", clip=plate)])
            bpy.context.scene.render.use_compositing = on
            return bpy

        report = refused("footage the compositor reads", composited(True))
        check("preflight reads: a clip it cannot pack is not called unpacked",
              report is not None and [m["packable"] for m in report["missing"]] == [False]
              and "a .blend cannot pack them: movie clip 'Plate'" in report["summary"]
              and "not packed into" not in report["summary"])
        refused("footage in a compositor that is off", composited(False), ok=True)
        bpy = scene_bpy(tmp, [drawn()], movieclips=[plate])
        bpy.context.scene.compositing_node_group = datablock(
            "NODETREE", "Compositor", [plate], nodes=[NS(bl_idname="CompositorNodeMovieClip",
                                                          clip=plate)])
        refused("footage the 5.0 compositor's node group reads", bpy)

        abc = datablock("CACHEFILE", "sim.abc", filepath="//cache/sim.abc")
        refused("an Alembic cache only a hidden object reads", scene_bpy(
            tmp, [obj("Sim", [abc], hide_render=True)], cache_files=[abc]), ok=True)
        refused("an Alembic cache a rendered object reads", scene_bpy(
            tmp, [obj("Sim", [abc])], cache_files=[abc]))

        # Sculpting links Blender's own brush assets; nothing rendered is
        # linked from them, and their path is the artist's Blender install.
        essentials = datablock("LIBRARY", "essentials_brushes-mesh_sculpt.blend",
                               filepath="/Applications/Blender.app/brushes/essentials.blend")
        linked = datablock("BRUSH", "Clay Strips", library=essentials)
        refused("a library only brushes are linked from", scene_bpy(
            tmp, [drawn()], libraries=[essentials], brushes=[linked]), ok=True)
        chars = datablock("LIBRARY", "chars.blend", filepath="//libs/chars.blend")
        rig = collection("Hero", library=chars, is_missing=True)
        refused("a missing library a rendered empty instances a collection from", scene_bpy(
            tmp, [obj("Hero", [rig], type="EMPTY", instance_collection=rig)],
            libraries=[chars], collections=[rig]))
        hero = obj("Hero", library=chars, is_missing=True)
        refused("a missing library a rendered override is rebuilt from", scene_bpy(
            tmp, [obj("Hero override", override_library=NS(reference=hero))],
            libraries=[chars]))
        placed = collection("Set", library=chars, is_missing=True)
        bpy = scene_bpy(tmp, [], libraries=[chars], collections=[placed])
        bpy.context.scene.view_layers = [NS(use=True, layer_collection=layer(
            "Scene Collection", [layer(placed)]))]
        refused("a missing library whose collection sits in the view layer", bpy)

        bpy = scene_bpy(tmp, [drawn(wood, name="Crate", hide_render=True)], images=[wood])
        bpy.data.user_map = broken_user_map
        err, report = preflight(tmp, bpy)
        check("preflight reads: without a trace, every file with a user counts, and it says so",
              err is not None and [m["name"] for m in report["missing"]] == ["wood"]
              and any("could not trace what the render uses" in w for w in report["warnings"]))


def test_startup_script_marker():
    blocks = [NS(name="startup_guard.py", as_string=lambda: "raise ValueError('needs add-on foo')"),
              NS(name="notes.txt", as_string=lambda: "not python")]
    err, printed = blender_script("run_startup_scripts.py", NS(data=NS(texts=blocks)))
    check("a raising startup block still fails the render, and names itself first",
          isinstance(err, ValueError)
          and marker(printed, "VR_STARTUP_FAILED")
          == {"script": "startup_guard.py", "error": "ValueError: needs add-on foo"})
    ran = NS(name="startup_ok.py", as_string=lambda: "import bpy\nbpy.data.touched = True")
    bpy = NS(data=NS(texts=[ran]))
    err, printed = blender_script("run_startup_scripts.py", bpy)
    check("a startup block that works runs, with no marker",
          err is None and getattr(bpy.data, "touched", False)
          and marker(printed, "VR_STARTUP_FAILED") is None)


def test_agent_runs_the_preflight():
    """1.16: the agent runs preflight.py third, tells it which frames will
    render, and fails a refused scene as errorKind scene."""
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        finished_frame(cdir, "0001.exr", "old1")
        rec = os.path.join(tmp, "runs.jsonl")
        state, _ = run_chunk(tmp, {"record": rec, "default": {"render": "f"}},
                             grid=(1, 5, 1), jobChunks=4)
        with open(rec) as f:
            run = json.loads(f.readline())
        argv, env = run["argv"], run["env"]
        scripts = [os.path.basename(argv[i + 1]) for i, a in enumerate(argv) if a == "-P"]
        check("preflight: the third script, after the startup blocks and the GPU setup",
              scripts == ["run_startup_scripts.py", "enable_gpu.py", "preflight.py"])
        check("-x 1: every frame gets its file extension, set before the render",
              "-x" in argv and argv[argv.index("-x") + 1] == "1"
              and argv.index("-x") < argv.index("-a"))
        check("preflight: told the first frame that will really render, and the chunking",
              json.loads(env.get("VR_PREFLIGHT") or "{}")
              == {"jobChunks": 4, "first": 2, "last": 5, "contiguous": True, "stepped": False,
                  "resumed": True, "mode": "enforce"})
        check("preflight: a clean pass renders as before", state.get("status") == "done")

    report = {"ok": False, "summary": "1 file(s) not packed into the .blend and not on the node:"
              " image 'wood' (//tex/wood.png)", "missing": [], "problems": [], "warnings": []}
    with fake_node() as tmp:
        make_chunk(tmp)
        state, entries = run_chunk(tmp, {"default": {
            "print": ["VR_PREFLIGHT " + json.dumps(report),
                      "Error: script failed, file: '/root/vastai/blender/preflight.py', exiting."],
            "exit": nr.GUARD_EXIT}})
        check("preflight refusal: errorKind scene, with the report's summary as the error",
              state.get("errorKind") == "scene" and state.get("exitCode") == nr.GUARD_EXIT
              and state.get("error") == "scene preflight failed: " + report["summary"]
              and state.get("preflight") == report and entries == [])
    # "warn" mode: the report says ok false and raises nothing, so a later
    # script that raised is the cause, not the scene's files.
    for label, printed, kind, error in (
        ("the job's expression", "Error: script failed, expr: 'import my_addon;"
         " my_addon.register()', exiting.", "job", "a python expression of the job raised"),
        ("the agent's Overwrite expression",
         "Error: script failed, expr: '%s', exiting." % nr.NO_OVERWRITE_EXPR.splitlines()[0],
         "transient", "the agent's Overwrite-off expression raised"),
        ("preflight.py itself", "Error: script failed, file:"
         " '/root/vastai/blender/preflight.py', exiting.", "scene", "scene preflight failed: "),
    ):
        with fake_node() as tmp:
            make_chunk(tmp)
            state, _ = run_chunk(tmp, {"default": {
                "print": ["VR_PREFLIGHT " + json.dumps(report), printed],
                "exit": nr.GUARD_EXIT}}, preflight="warn")
            check(f"preflight warn: {kind} when {label} raised",
                  state.get("errorKind") == kind
                  and state.get("error", "").startswith(error))
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {
            "print": ["VR_PREFLIGHT " + json.dumps(report),
                      'VR_STARTUP_FAILED {"script": "startup_guard.py",'
                      ' "error": "ValueError: no"}',
                      "Error: script failed, file: '/root/vastai/blender/run_startup_scripts.py',"
                      " exiting."],
            "exit": nr.GUARD_EXIT}}, preflight="warn")
        check("preflight warn: a startup block that raised is named, not the preflight",
              state.get("errorKind") == "scene"
              and "'startup_guard.py'" in state.get("error", ""))
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {
            "print": ['VR_STARTUP_FAILED {"script": "startup_guard.py",'
                      ' "error": "ValueError: no"}'],
            "exit": nr.GUARD_EXIT}})
        check("startup refusal: errorKind scene, naming the block",
              state.get("errorKind") == "scene" and "'startup_guard.py'" in state.get("error", "")
              and "ValueError: no" in state["error"])
    with fake_node() as tmp:
        make_chunk(tmp)
        rec = os.path.join(tmp, "runs.jsonl")
        state, _ = run_chunk(tmp, {"record": rec, "default": {"render": "f"}}, preflight="off")
        with open(rec) as f:
            run = json.loads(f.readline())
        check("preflight off: the app's way past a wrong refusal",
              "preflight.py" not in " ".join(run["argv"]) and "VR_PREFLIGHT" not in run["env"]
              and state.get("status") == "done")


def gpu_bpy(engine="CYCLES", devices=(), addons=None):
    """A stand-in bpy for enable_gpu.py: one scene, Cycles' device list."""
    cprefs = NS(devices=[NS(type=t, id=i, name=n, use=False) for t, i, n in devices],
                compute_device_type="NONE", refresh_devices=lambda: None)
    cycles = NS(device="CPU", use_auto_tile=False, use_persistent_data=False)
    bpy = types.ModuleType("bpy")
    bpy.context = NS(scene=NS(render=NS(engine=engine), cycles=cycles),
                     preferences=NS(addons={"cycles": NS(preferences=cprefs)}
                                    if addons is None else addons))
    bpy.app = NS(version=(4, 2, 0))
    return bpy, cprefs, cycles


def test_enable_gpu():
    """1.16 / #83: Cycles with no GPU to enable printed a warning and rendered on
    the CPU at GPU prices, and its slow frames were scored against the GPU."""
    gpus = [("CUDA", "CUDA_NVIDIA GeForce RTX 4090_0000:01:00", "RTX 4090"),
            ("OPTIX", "OPTIX_NVIDIA GeForce RTX 4090_0000:01:00", "RTX 4090"),
            ("OPTIX", "OPTIX_NVIDIA GeForce RTX 4090_0000:41:00", "RTX 4090 #2"),
            ("CPU", "CPU", "AMD EPYC")]
    bpy, cprefs, cycles = gpu_bpy(devices=gpus)
    err, printed = blender_script("enable_gpu.py", bpy)
    check("gpu: OptiX preferred, every OptiX card on, CUDA and the CPU off",
          err is None and cycles.device == "GPU" and cprefs.compute_device_type == "OPTIX"
          and [d.use for d in cprefs.devices] == [False, True, True, False]
          and marker(printed, "VR_GPU") == {"ok": True, "backend": "OPTIX",
                                            "devices": ["RTX 4090", "RTX 4090 #2"]})
    bpy, cprefs, _ = gpu_bpy(devices=gpus)
    err, _ = blender_script("enable_gpu.py", bpy,
                            {"VR_GPU_INDEX": "1", "VR_GPU_BUS": "00000000:41:00.0"})
    check("gpu: pinned, only the card on the named bus when both are listed",
          err is None and [d.use for d in cprefs.devices] == [False, False, True, False])

    bpy, cprefs, cycles = gpu_bpy(devices=[("CPU", "CPU", "AMD EPYC")])
    err, printed = blender_script("enable_gpu.py", bpy)
    check("gpu: none to enable refuses the render instead of using the CPU",
          isinstance(err, RuntimeError) and str(err).startswith("no Cycles GPU device: ")
          and (marker(printed, "VR_GPU") or {}).get("ok") is False
          and "VR_ENGINE CYCLES" in printed)
    bpy, _, _ = gpu_bpy(addons={})
    err, printed = blender_script("enable_gpu.py", bpy)
    check("gpu: a device setup that breaks is refused and reported the same way",
          isinstance(err, RuntimeError)
          and "KeyError" in (marker(printed, "VR_GPU") or {}).get("reason", ""))
    bpy, _, cycles = gpu_bpy(devices=[("CPU", "CPU", "AMD EPYC")])
    err, printed = blender_script("enable_gpu.py", bpy, {"VR_CPU_RENDER": "1"})
    check("gpu: a job that renders on the CPU by design is left on the CPU",
          err is None and cycles.device == "CPU"
          and (marker(printed, "VR_GPU") or {}).get("backend") == "CPU")
    bpy, _, cycles = gpu_bpy(engine="BLENDER_EEVEE_NEXT")
    err, printed = blender_script("enable_gpu.py", bpy)
    check("gpu: EEVEE is left alone, and its engine reported",
          err is None and printed.startswith("VR_ENGINE BLENDER_EEVEE_NEXT\n")
          and marker(printed, "VR_GPU") is None and cycles.device == "CPU")

    def views(**render):
        bpy, _, _ = gpu_bpy(engine="BLENDER_EEVEE_NEXT")
        vs = [NS(name="left", file_suffix="_L", use=True), NS(name="right", file_suffix="_R", use=True),
              NS(name="top", file_suffix="_T", use=True), NS(name="off", file_suffix="_O", use=False)]
        fields = dict(use_multiview=True, views_format="STEREO_3D", views=vs,
                      image_settings=NS(views_format="INDIVIDUAL"))
        fields.update(render)
        for k, v in fields.items():
            setattr(bpy.context.scene.render, k, v)
        err, printed = blender_script("enable_gpu.py", bpy)
        return err, printed.count("VR_VIEWS"), marker(printed, "VR_VIEWS")

    check("views: stereo saved as one file per view names its two suffixes",
          views() == (None, 1, ["_L", "_R"]))
    check("views: multiview names every view it renders",
          views(views_format="MULTIVIEW") == (None, 1, ["_L", "_R", "_T"]))
    check("views: one file per frame says nothing",
          views(image_settings=NS(views_format="STEREO_3D"))[1] == 0
          and views(use_multiview=False)[1] == 0)


def test_agent_gpu_and_engine():
    """1.16: the machine, not the scene, is blamed for a missing GPU, and the
    scene's real engine is reported and decides the EEVEE OpenGL retry."""
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {"print": [
            "VR_ENGINE CYCLES",
            'VR_GPU {"ok": false, "backend": null, "devices": [], "reason": "no OptiX/CUDA'
            ' device could be enabled (none listed)"}',
            "Error: script failed, file: '/root/vastai/blender/enable_gpu.py', exiting.",
        ], "exit": nr.GUARD_EXIT}})
        check("no GPU: errorKind machine, saying so, although the exit is the guard's",
              state.get("errorKind") == "machine" and state.get("engine") == "cycles"
              and state.get("error", "").startswith("no Cycles GPU device on this node: "))
    with fake_node() as tmp:
        make_chunk(tmp)
        # An EEVEE scene the job labelled Cycles; Vulkan dies before frame 1.
        state, entries = run_chunk(tmp, {
            "default": {"print": ["VR_ENGINE BLENDER_EEVEE_NEXT"], "exit": 1},
            "opengl": {"print": ["VR_ENGINE BLENDER_EEVEE_NEXT"], "render": "gl"},
        }, grid=(1, 2, 1), engine="cycles")
        check("engine: an EEVEE scene labelled Cycles is still retried on OpenGL (#248)",
              "retrying with --gpu-backend opengl" in render_log()
              and state.get("status") == "done" and len(entries) == 2
              and state.get("engine") == "eevee")
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {"print": ["VR_ENGINE CYCLES"], "exit": 1}},
                             engine="eevee")
        check("engine: a Cycles scene labelled EEVEE is not retried on OpenGL",
              "retrying" not in render_log() and state.get("errorKind") == "transient")
    with fake_node() as tmp:
        make_chunk(tmp)
        rec = os.path.join(tmp, "runs.jsonl")
        run_chunk(tmp, {"record": rec, "default": {"render": "f"}}, cpuRender=True)
        with open(rec) as f:
            env = json.loads(f.readline())["env"]
        check("cpuRender: enable_gpu.py is told the CPU is by design",
              env.get("VR_CPU_RENDER") == "1")


def test_out_of_memory():
    """1.11 / #228: a GPU out of memory was just "blender exited N", requeued
    into the same lane plan until the retries ran out; and a frame Blender
    wrote after the error, black or cut short, could be announced and kept."""
    with fake_node() as tmp:
        cdir = make_chunk(tmp)
        started = time.time()
        state, entries = run_chunk(tmp, {"default": {"write": [
            ["0001.exr", "good", True],
            ["0002.exr", "black", True,
             "Fra:2 Mem:23000M | Error: System is out of GPU memory"],
        ], "sleep": 20, "exit": 0}}, gpu=1)
        check("oom: errorKind machine, oom and the GPU in the state, the line in the error",
              state.get("status") == "failed" and state.get("errorKind") == "machine"
              and state.get("oom") is True and state.get("gpu") == 1
              and state.get("error", "").startswith("out of GPU memory on GPU 1 (exit ")
              and "System is out of GPU memory" in state["error"])
        check("oom: a frame announced after the error is not kept; one before it is",
              [e["file"] for e in entries] == ["frames/0001.exr"]
              and sorted(os.listdir(os.path.join(cdir, "frames"))) == ["0001.exr"])
        check("oom: Blender is stopped at once, not left to render on",
              time.time() - started < 15 and "stopping this attempt" in render_log())
    with fake_node() as tmp:
        make_chunk(tmp)
        state, _ = run_chunk(tmp, {"default": {
            "print": ["CUDA error: Out of memory in cuMemAlloc_v2(&device_pointer, size)"],
            "exit": 1}}, engine="eevee")
        check("oom: no OpenGL retry, the backend was not the problem",
              "retrying" not in render_log() and state.get("oom") is True)
    # Blender's other wordings, as its 5.1 binary holds them (the Vulkan line
    # is only an error code in a line of that shape). Each is followed by a
    # frame Blender still saves and announces, drawn wrong.
    for line in (
        "Error: System is out of GPU and shared host memory",
        "Fra:2 Mem:9000M | Time:00:41.20 | System is out of GPU and shared host memory",
        "Error: Could not allocate shadow atlas. Most likely out of GPU memory.",
        "Error: Could not allocate 3D texture for volume.",
        "Error: Could not allocate irradiance staging texture",
        "Out of memory - couldn't allocate integrator state",
        "Vulkan: VK_ERROR_OUT_OF_DEVICE_MEMORY in vkAllocateMemory",
    ):
        with fake_node() as tmp:
            cdir = make_chunk(tmp)
            state, entries = run_chunk(tmp, {"default": {"write": [
                ["0001.exr", "good", True],
                ["0002.exr", "wrong", True, line],
            ], "exit": 0}}, engine="eevee" if "allocate" in line else "cycles")
            check(f"oom: {line!r} fails the chunk, and the frame after it is not kept",
                  state.get("errorKind") == "machine" and state.get("oom") is True
                  and [e["file"] for e in entries] == ["frames/0001.exr"]
                  and sorted(os.listdir(os.path.join(cdir, "frames"))) == ["0001.exr"])
    st = {}
    nr.scan_line("Fra:3 Mem:10M | Sample 12/128", st, {}, 1.0)
    nr.scan_line("Error: Shadow buffer full, may result in missing shadows and lower"
                 " performance. (512 / 512)", st, {}, 1.0)
    nr.scan_line("Fra:3 Mem:10M | Time:00:01.02 | Mem:4096.00M, Peak:9000.00M | Scene, "
                 "ViewLayer | Sample 64/128", st, {}, 1.0)
    nr.scan_line('VR_PREFLIGHT {"ok": true, "warnings": ["not on the node: //out of memory.png"]}',
                 st, {}, 1.0)
    check("oom: an ordinary line, or a script's report quoting a file name, is not an OOM",
          "oom" not in st)


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
    check("single GPU: unpinned lanes share it, as planned",
          nr.plan_launches([("a", ex(2)), ("b", ex(2))], [], 1, 1)
          == [("a", None), ("b", None)])


def test_pinning_is_cycles_only():
    """1.11 / #229 #235: EEVEE and Octane pick their own GPU, so their "pinned"
    lanes piled onto one card while the Fleet screen showed one per GPU."""
    def ex(engine, pin=True):
        return {"exclusive": True, "lanes": 4, "pinGpus": pin, "engine": engine}

    got = nr.plan_launches([(f"e{i}", ex("eevee")) for i in range(4)], [], 4, 1)
    check("eevee: never pinned, and its pinned lanes run one at a time", got == [("e0", None)])
    got = nr.plan_launches([(f"o{i}", ex("octane")) for i in range(4)], [], 4, 1)
    check("octane: likewise", got == [("o0", None)])
    got = nr.plan_launches([(f"c{i}", ex("cycles")) for i in range(4)], [], 4, 1)
    check("cycles: one lane per GPU, each pinned", [g for _, g in got] == [0, 1, 2, 3])
    shared = {"exclusive": False, "nodeSlots": 4, "pinGpus": True, "engine": "eevee"}
    check("eevee shared work: unpinned, its slots unchanged",
          nr.plan_launches([(f"s{i}", shared) for i in range(3)], [], 4, 4)
          == [("s0", None), ("s1", None), ("s2", None)])
    check("pin_plan: EEVEE is refused, not failed", nr.pin_plan(ex("eevee"), 4) == (False, False))


def test_pin_failure_is_reported():
    """1.11 / #230: one failed nvidia-smi as the agent started turned pinning off
    for the rental, and the app kept sending pinned lanes that each loaded the
    scene onto every GPU."""
    ex = {"exclusive": True, "lanes": 4, "pinGpus": True, "engine": "cycles"}
    check("pin failed: pinned lanes the agent cannot pin run one at a time",
          nr.plan_launches([("a", ex), ("b", ex)], [], 0, 1) == [("a", None)]
          and nr.plan_launches([("a", ex), ("b", ex)], [], 1, 1) == [("a", None)])

    answers = ["", "0, 00000000:01:00.0\n1, 00000000:41:00.0"]
    with fake_nvidia_smi(lambda q: answers.pop(0) if answers else "") as calls:
        saved = {k: getattr(nr, k, None) for k in ("_GPUS", "_GPUS_ASKED", "GPU_LIST_RETRY")}
        try:
            nr._GPUS = None
            first = nr.gpu_list()
            nr.GPU_LIST_RETRY = 3600
            soon = nr.gpu_list()
            asked_soon = len(calls)
            nr.GPU_LIST_RETRY = 0
            later = nr.gpu_list()
            cached = nr.gpu_list()
        finally:
            for k, v in saved.items():
                setattr(nr, k, v)
    check("gpu_list: an empty answer is not kept for the rental",
          first == [] and soon == [] and asked_soon == 1
          and later == [(0, "00000000:01:00.0"), (1, "00000000:41:00.0")])
    check("gpu_list: a list with GPUs is kept", cached == later and len(calls) == 2)

    for engine, expect in (("cycles", True), ("eevee", None)):
        with fake_node() as tmp:
            make_chunk(tmp)
            state, _ = run_chunk(tmp, {"default": {"render": "f"}}, engine=engine,
                                 pinGpus=True, lanes=4, exclusive=True)
            check(f"pinFailed: in the state of an unpinned {engine} render the app asked to pin"
                  if expect else "pinFailed: not for an EEVEE render, which is never pinned",
                  state.get("pinFailed") is expect and state.get("status") == "done"
                  and "not pinned to a GPU as the app asked" in render_log())
    check("pin failed: pin_plan says so", nr.pin_plan(ex, 1) == (False, True))


def test_vram_bound_by_engine():
    """1.11 / #229: the agent summed every card's VRAM, so shared EEVEE work,
    which lands on one card, could be packed N cards over its size."""
    with fake_nvidia_smi(lambda q: "2048\n1024\n") as _calls:
        cycles, eevee = nr.gpu_vram_mb("cycles"), nr.gpu_vram_mb("eevee")
        absent = nr.gpu_vram_mb()
        real_cpus = os.cpu_count
        os.cpu_count = lambda: 64
        try:
            ceilings = (nr.node_ceiling("cycles"), nr.node_ceiling("eevee"))
            slots = nr.slot_limit({"nodeSlots": 16, "engine": "eevee"})
        finally:
            os.cpu_count = real_cpus
    check("vram: Cycles sums the cards, any other engine gets the smallest",
          (cycles, eevee, absent) == (3072, 1024, 3072))
    check("vram: the slot ceiling for EEVEE follows the smallest card",
          ceilings[1] == 1 and ceilings[0] >= ceilings[1] and slots == 1)


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
        test_pinning_is_cycles_only,
        test_vram_bound_by_engine,
        test_backfill_skips_unmanifested,
        test_per_frame_failures_are_tolerated,
        test_resubscribe_fills_the_gap,
        test_write_state_under_threads,
        test_sweep_filters,
        test_preview_sequence,
        test_log_tail,
        test_no_overwrite_expr_runs,
        test_last_progress_at,
        test_preflight_files,
        test_preflight_simulations,
        test_preflight_reads_only_what_renders,
        test_startup_script_marker,
        test_enable_gpu,
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
        test_every_spec_leaves_the_inbox,
        test_a_failed_drain_stops_blender,
        test_render_publishes_last_progress,
        test_restart_renders_only_missing_frames,
        test_explicit_frame_list,
        test_multiview_frames_are_whole,
        test_never_a_stand_in_blender,
        test_agent_runs_the_preflight,
        test_agent_gpu_and_engine,
        test_out_of_memory,
        test_pin_failure_is_reported,
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
