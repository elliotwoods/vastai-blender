#!/usr/bin/env python3
"""Self-check for the parts of noderunner.py that are easy to get wrong.

`remote/` is the one place with no automated coverage — it runs unattended on
rented hardware, where a mistake costs money and a whole render. The app-side
suite (`npm test`) cannot reach it, so this stands in: stdlib only, no ffmpeg, no
node, no network. Run it after touching noderunner.py.

    python3 remote/agent/selfcheck.py

Covers the three failure modes that actually bit:

  * `write_state` used one temp filename per CHUNK, so the 60s heartbeat and the
    render loop raced on it and whichever lost `os.replace` raised — killing
    either the heartbeat (silently ending the anti-stall refresh) or the render
    loop (failing a healthy chunk).
  * the live backfill listed `frames/` directly, feeding ffmpeg the frame blender
    was mid-write on and truncated leftovers from a killed render — and one such
    failure disabled thumbnails and the live clip for the whole chunk.
  * the backfill ran once, so closing and reopening the preview left a permanent
    hole in the append-only stream and clip indices stopped mapping to frames.
"""

import json
import os
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import noderunner as nr  # noqa: E402

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


def main():
    for fn in (
        test_backfill_skips_unmanifested,
        test_per_frame_failures_are_tolerated,
        test_resubscribe_fills_the_gap,
        test_write_state_under_threads,
    ):
        fn()
    print()
    if FAILED:
        print("FAILURES: " + ", ".join(FAILED))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
