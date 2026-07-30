#!/usr/bin/env python3
"""Node agent — runs ON the rented instance under tmux, stdlib only.

Contract with the app (all under ~/vastai/):
  jobs/inbox/<chunkId>.json   job specs, SFTP-written by the app (atomic move)
  jobs/done/  jobs/failed/    specs move here on completion/failure
  logs/<chunkId>.log          full blender stdout/stderr
  state/<chunkId>.json        durable progress: {status, currentFrame,
                              framesDone, lastLine, exitCode, updatedAt}
  state/heartbeat             touched every 10s (app-side liveness check)
  renders/<chunkId>/frames/   render output
  renders/<chunkId>/manifest.jsonl
                              one JSON line per completed artefact:
                              {"kind":"frame"|"clip", "file":<relative>,
                               "size":N, "sha256":hex, "mtime":N, ...}

The manifest is the ONLY thing the app trusts for downloads — a file is listed
only after it is size-stable, so partially-written frames are never pulled.

Job spec:
  { "chunkId": str, "blendFile": str (under work/scenes/),
    "blenderVersion": "4.5.3", "engine": "cycles"|"eevee"|"octane",
    "frameStart": int, "frameEnd": int, "frameStep": int,
    "extraArgs": [str], "pythonExprs": [str],
    "encode": null | {"sdr": bool, "hdr": bool, "proxy": bool,
                       "codec": "hevc"|"av1", "fps": float,
                       "thumbs": bool, "thumbWidth": int} }

Every `encode` sub-key is optional and absent means off, so an old app talking
to a new agent (and vice versa) both degrade to the behaviour they knew.
"""

import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time

HOME = os.path.expanduser("~")
ROOT = os.environ.get("VASTAI_HOME", os.path.join(HOME, "vastai"))
INBOX = os.path.join(ROOT, "jobs", "inbox")
DONE = os.path.join(ROOT, "jobs", "done")
FAILED = os.path.join(ROOT, "jobs", "failed")
LOGS = os.path.join(ROOT, "logs")
STATE = os.path.join(ROOT, "state")
RENDERS = os.path.join(ROOT, "renders")
# App-written flag files: control/<chunkId>.live enables the live encoder for
# that chunk. Created here as well as in provision.sh because sftpWriteFile
# does no mkdir, so a node provisioned by an older build would otherwise fail
# every subscribe.
CONTROL = os.path.join(ROOT, "control")
BLENDER_ROOT = os.path.join(ROOT, "blender")
OCTANE_BLENDER = "/usr/local/OctaneBlender/blender"
ENCODE_SCRIPT = os.path.join(ROOT, "encode", "encode_preview.py")
LIVE_SCRIPT = os.path.join(ROOT, "encode", "live_preview.py")

# Consecutive per-frame preview encode failures before the worker stands down.
# One bad frame is tolerated (and logged); a broken ffmpeg is not allowed to
# spawn a subprocess per frame for the rest of the render.
PREVIEW_FAIL_LIMIT = 4

# \b + search, not ^ + match: Blender >= 4.x prefixes stdout lines with an
# elapsed-time/category column ("28:44.572  render | Fra: 95 ..."), so an
# anchored match never fires and currentFrame stays null in the UI.
FRA_RE = re.compile(r"\bFra:\s*(\d+)")
SAVED_RE = re.compile(r"Saved: '(.+?)'")

# Exit code Blender returns when any Python script raises (--python-exit-code).
# Distinguishes "a scene/startup guard aborted the render" from render crashes.
GUARD_EXIT = 32


def ensure_dirs():
    for d in (INBOX, DONE, FAILED, LOGS, STATE, RENDERS, CONTROL):
        os.makedirs(d, exist_ok=True)


def heartbeat_loop():
    path = os.path.join(STATE, "heartbeat")
    while True:
        try:
            with open(path, "w") as f:
                f.write(str(time.time()))
        except OSError:
            pass
        time.sleep(10)


# Serialises write_state. Several threads write the state of ONE chunk — the
# render loop's stdout drain and the 60s heartbeat — and they share the same
# mutable `state` dict, so without this a reader can see a mix of two writers'
# fields even when each write is atomic on its own.
_STATE_LOCK = threading.Lock()


def write_state(chunk_id, state):
    """Atomically publish a chunk's state for the app to read.

    The temp name is per-WRITER, not per-chunk: it used to be `<path>.tmp`, so
    the heartbeat thread and the render loop raced on one filename and whichever
    lost the `os.replace` raised FileNotFoundError. That killed either the
    heartbeat (silently stopping the anti-stall refresh this exists to provide)
    or the render loop (failing a perfectly healthy chunk). Nothing globs this
    directory — the app reads and deletes the exact `<chunkId>.json` path — so a
    decorated temp name is free.
    """
    path = os.path.join(STATE, f"{chunk_id}.json")
    tmp = "%s.%d.%d.tmp" % (path, os.getpid(), threading.get_ident())
    with _STATE_LOCK:
        state["updatedAt"] = time.time()
        try:
            with open(tmp, "w") as f:
                json.dump(state, f)
            os.replace(tmp, path)
        except Exception:
            # Never leave a temp file behind to accumulate on a long render.
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise


def file_hash(path):
    # sha256: the one digest guaranteed on both sides (Electron's Node runs
    # BoringSSL, which does NOT expose blake2b).
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def append_manifest(chunk_dir, entry):
    with open(os.path.join(chunk_dir, "manifest.jsonl"), "a") as f:
        f.write(json.dumps(entry) + "\n")


def size_stable(path, wait=1.0):
    """True once the file size stops changing across `wait` seconds."""
    try:
        a = os.path.getsize(path)
        time.sleep(wait)
        b = os.path.getsize(path)
        return a == b and a > 0
    except OSError:
        return False


def manifest_files(chunk_dir, kind=None):
    """Relative paths already recorded in the manifest, optionally by kind.

    `kind` matters: FrameTracker uses len(recorded) as framesDone, so counting
    non-frame lines inflates reported progress — already by 3 on any chunk
    restarted after its clips were encoded, and it would exactly DOUBLE once
    thumbnails add one line per frame.
    """
    seen = set()
    try:
        with open(os.path.join(chunk_dir, "manifest.jsonl")) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if kind is None or entry.get("kind", "frame") == kind:
                        seen.add(entry["file"])
                except (ValueError, KeyError):
                    pass
    except OSError:
        pass
    return seen


def pick_blender(spec):
    if spec.get("engine") == "octane" and os.path.exists(OCTANE_BLENDER):
        return OCTANE_BLENDER
    version = spec.get("blenderVersion")
    if version:
        path = os.path.join(BLENDER_ROOT, version, "blender")
        if os.path.exists(path):
            return path
    # Fall back to any installed version (newest first).
    try:
        versions = sorted(os.listdir(BLENDER_ROOT), reverse=True)
    except OSError:
        versions = []
    for v in versions:
        path = os.path.join(BLENDER_ROOT, v, "blender")
        if os.path.exists(path):
            return path
    raise RuntimeError("no blender installation found")


class FrameTracker:
    """Records saved frames into the manifest once size-stable."""

    def __init__(self, chunk_dir, on_frame=None):
        self.chunk_dir = chunk_dir
        self.pending = []  # absolute paths reported by "Saved:" lines
        self.recorded = manifest_files(chunk_dir, kind="frame")
        self.lock = threading.Lock()
        # Called with each newly-manifested frame path. The manifest is the
        # right hook: a frame is only listed once it is size-stable, so the
        # preview encoder never reads a half-written file.
        self.on_frame = on_frame

    def saw_saved(self, path):
        with self.lock:
            self.pending.append(path)

    def flush(self, final=False):
        """Move stable pending files into the manifest. Returns #recorded."""
        with self.lock:
            pending = list(self.pending)
        count = 0
        still = []
        for path in pending:
            rel = os.path.relpath(path, self.chunk_dir)
            if rel in self.recorded:
                continue
            if size_stable(path, wait=1.0 if not final else 0.5):
                append_manifest(
                    self.chunk_dir,
                    {
                        "kind": "frame",
                        "file": rel,
                        "size": os.path.getsize(path),
                        "sha256": file_hash(path),
                        "mtime": os.path.getmtime(path),
                    },
                )
                self.recorded.add(rel)
                count += 1
                if self.on_frame:
                    try:
                        self.on_frame(path)
                    except Exception:  # noqa: BLE001 — previews never break rendering
                        pass
            else:
                still.append(path)
        with self.lock:
            self.pending = still + [p for p in self.pending if p not in pending]
        return count


class PreviewWorker(threading.Thread):
    """Per-frame thumbnails (and, in live mode, HEVC access units).

    Runs on its own thread fed by a queue, NOT inline in run_once()'s stdout
    loop: that loop is what drains Blender's stdout pipe, and a ~200ms ffmpeg
    call per line stalls the renderer as soon as the pipe buffer fills.

    Every failure disables the worker rather than propagating. A preview is a
    convenience; it must never be the reason a paid render fails — the same
    rule as the agent's "must never die on a job".
    """

    def __init__(self, chunk_id, chunk_dir, enc):
        super().__init__(daemon=True)
        self.chunk_id = chunk_id
        self.chunk_dir = chunk_dir
        self.enc = enc or {}
        self.queue = queue.Queue()
        self.thumbs_dir = os.path.join(chunk_dir, "thumbs")
        self.previews_dir = os.path.join(chunk_dir, "previews")
        self.stream_path = os.path.join(self.previews_dir, "live.h265")
        self.disabled_reason = None
        # Own dedupe set: FrameTracker.recorded is frames-only now, so without
        # this an agent restart re-encodes and re-ships every thumbnail.
        self.done = {os.path.basename(f) for f in manifest_files(chunk_dir, kind="thumb")}
        # NOT `_stop`: threading.Thread._stop is an internal METHOD, and Thread.join()
        # calls it via _wait_for_tstate_lock. Shadowing it with an Event made every
        # join() raise "'Event'" object is not callable" — which surfaced as the chunk
        # failing right after a successful render, skipping the definitive encode.
        self._stopping = threading.Event()
        # Live-clip accumulation state. `live_done` keeps appends idempotent:
        # the backfill and the live edge can both reach the same frame.
        self.live_started = False
        # Tracks the previous value of `live_wanted` so a re-subscribe can be
        # detected as a rising edge — see _backfill_live.
        self.live_prev_wanted = False
        self._backfilling = False
        # Consecutive per-frame encode failures; reset by any success.
        self._fail_streak = 0
        self.live_done = set()
        self.live_is_hdr = False
        self.live_frames = 0
        self.emitted_frames = 0
        self.last_emit = 0.0
        self.spent = 0.0
        self.render_started = time.time()
        # Distinguishes this worker's emitted clips from those of any earlier
        # run of the same chunk — see _maybe_emit.
        self.run_token = f"{int(self.render_started)}"

    @property
    def live_cfg(self):
        cfg = self.enc.get("live")
        return cfg if isinstance(cfg, dict) else {}

    @property
    def may_run(self):
        """Could this worker ever have something to do for this chunk?

        Distinct from `enabled`, which is about right now. The thread has to be
        started on this weaker condition: with thumbs off and live on-demand,
        `enabled` is False at dispatch and only becomes True when the app
        subscribes mid-render — a thread that was never started could not
        notice.
        """
        return bool(self.enc.get("thumbs")) or (self.live_cfg.get("mode") or "off") != "off"

    @property
    def enabled(self):
        return (bool(self.enc.get("thumbs")) or self.live_wanted) and self.disabled_reason is None

    @property
    def live_wanted(self):
        """Live encoding is on for this chunk right now.

        'onDemand' is checked per flush rather than cached, so subscribing from
        the app takes effect on the next frame instead of the next chunk.
        """
        mode = self.live_cfg.get("mode") or "off"
        if mode == "always":
            return True
        if mode != "onDemand":
            return False
        return os.path.exists(os.path.join(CONTROL, f"{self.chunk_id}.live"))

    def submit(self, frame_path):
        # Queue on `may_run`, not `enabled`: an on-demand subscription can
        # arrive after this frame was manifested, and the backlog is what lets
        # the live clip start from frame 1 rather than from the moment you
        # happened to open the preview.
        if self.may_run and self.disabled_reason is None:
            self.queue.put(frame_path)

    def stop(self):
        self._stopping.set()
        self.queue.put(None)

    def disable(self, reason):
        self.disabled_reason = reason
        log_line(self.chunk_id, f"preview disabled: {reason}")

    def run(self):
        os.makedirs(self.thumbs_dir, exist_ok=True)
        while not self._stopping.is_set():
            try:
                frame_path = self.queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if frame_path is None:
                break
            if not self.enabled:
                continue
            try:
                self._backfill_live()
                # Tolerant: one undecodable frame must not cost the chunk its
                # thumbnails and live clip for every frame after it.
                self._one_tolerant(frame_path)
            except Exception as e:  # noqa: BLE001
                # Structural failures only now (unwritable dirs, missing script).
                self.disable(str(e))

    def _backfill_live(self):
        """Catch the live stream up to every frame already manifested on disk.

        Because the stream is append-only and each frame costs exactly one
        encode, subscribing halfway through a chunk yields a clip that starts at
        frame 1 rather than at the moment you happened to open the preview —
        which is what makes the preview useful for a chunk already underway.

        Runs on every RISING EDGE of `live_wanted`, not just the first one.
        Un-subscribing stops frames being appended, so a close-then-reopen used
        to leave a permanent hole: AUs 1-8, then 16, 17... appended straight
        after 8, and since the app only learns the clip's frame COUNT there is no
        way to recover the mapping from clip index to chunk frame. Re-running
        turns that into a gap fill — `live_done` makes every already-appended
        frame a no-op, so only the missing ones are encoded.
        """
        if not self.live_wanted:
            self.live_prev_wanted = False
            return
        # Only act on the transition, so the steady-state path costs nothing.
        if self.live_prev_wanted and self.live_started:
            return
        self.live_prev_wanted = True

        if not self.live_started:
            self.live_started = True
            # Reset the stream and its dedupe set TOGETHER — they are one piece
            # of state, and this must stay ONE-SHOT. The stream is append-only
            # and `live_done` starts empty on every construction, so a live.h265
            # left behind by an earlier run of this same chunk would receive a
            # second copy of every frame. That is not hypothetical:
            # cleanup_live_stream() only runs in process()'s finally block, and
            # provision.sh's cmd_base kills the agent outright (tmux
            # kill-session / pkill) on every reconnect, after which the scheduler
            # re-dispatches the same chunkId into the same renders/<chunkId>/.
            # Re-running it on a RE-subscribe would instead delete the stream
            # while live_done still held every stem, leaving a 1-frame clip.
            try:
                os.makedirs(self.previews_dir, exist_ok=True)
                if os.path.exists(self.stream_path):
                    os.remove(self.stream_path)
            except OSError:
                pass

        frames_dir = os.path.join(self.chunk_dir, "frames")
        try:
            names = sorted(n for n in os.listdir(frames_dir) if re.match(r"^\d+\.\w+$", n))
        except OSError:
            return
        # Only frames the manifest has accepted. Membership already means
        # "size-stable and complete" (FrameTracker.flush gates on size_stable),
        # which a bare listdir does not: it also picks up the frame blender is
        # mid-write on, and truncated corpses left by provision.sh's `pkill` —
        # feeding either to ffmpeg used to disable previews for the whole chunk.
        # Skipping a not-yet-manifested frame loses nothing, because the tracker
        # fires on_frame for it moments later and live_done keeps that
        # idempotent.
        manifested = manifest_files(self.chunk_dir, kind="frame")
        # Emit once at the end rather than every cadence step: the backlog is
        # already on disk, so intermediate versions would be shipped and
        # superseded before anyone could watch them.
        self._backfilling = True
        try:
            for name in names:
                if self.disabled_reason or self._stopping.is_set():
                    return
                if os.path.join("frames", name).replace(os.sep, "/") not in manifested:
                    continue
                self._one_tolerant(os.path.join(frames_dir, name))
        finally:
            self._backfilling = False
        self._maybe_emit()

    def _one_tolerant(self, frame_path):
        """`_one`, but one bad frame does not take the whole chunk down.

        A single unreadable EXR used to raise straight out to run()'s handler and
        set `disabled_reason`, which is terminal — losing thumbnails AND the live
        clip for every remaining frame. A run of consecutive failures still
        stands the worker down, so a genuinely broken ffmpeg does not spawn a
        subprocess per frame forever.
        """
        try:
            self._one(frame_path)
            self._fail_streak = 0
        except Exception as e:  # noqa: BLE001
            self._fail_streak += 1
            # Name the frame: a skipped frame is a gap in the append-only
            # stream, so this is the only record of why indices shifted.
            log_line(
                self.chunk_id,
                f"preview: skipped {os.path.basename(frame_path)}"
                f" ({self._fail_streak}/{PREVIEW_FAIL_LIMIT}): {e}",
            )
            if self._fail_streak >= PREVIEW_FAIL_LIMIT:
                self.disable(f"{self._fail_streak} consecutive preview failures: {e}")

    def _one(self, frame_path):
        stem = os.path.splitext(os.path.basename(frame_path))[0]
        name = f"{stem}.jpg"
        want_thumb = bool(self.enc.get("thumbs")) and name not in self.done
        want_live = self.live_wanted and stem not in self.live_done
        if not want_thumb and not want_live:
            return

        os.makedirs(self.previews_dir, exist_ok=True)
        thumb_out = os.path.join(self.thumbs_dir, name) if want_thumb else None
        au_out = os.path.join(self.previews_dir, f".{stem}.au.h265") if want_live else None
        # The AU output is only used when want_live; `.`-prefixed and unlinked
        # after appending, so a crash mid-frame leaves no manifested garbage.

        # Derived from the frame in hand, not from a guess made before any
        # frame existed: Blender's output format follows the .blend, and
        # treating a PNG as linear EXR would push sRGB values through the
        # linear→HLG conversion and wreck the colour.
        is_exr = os.path.splitext(frame_path)[1].lower() == ".exr"

        cmd = [sys.executable, LIVE_SCRIPT, "--frame", frame_path]
        if thumb_out:
            cmd += ["--thumb-out", thumb_out,
                    "--thumb-width", str(self.enc.get("thumbWidth") or 320)]
        if au_out:
            cmd += ["--au-out", au_out,
                    "--width", str(self.live_cfg.get("width") or 960),
                    "--crf", str(self.live_cfg.get("crf") or 22)]
            if is_exr:
                cmd += ["--hdr"]

        started = time.time()
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if r.returncode != 0:
            raise RuntimeError(
                f"live_preview exited {r.returncode}: {(r.stderr or '').strip()[:200]}"
            )
        self.spent += time.time() - started

        if thumb_out and os.path.exists(thumb_out):
            append_manifest(
                self.chunk_dir,
                {
                    "kind": "thumb",
                    "file": os.path.join("thumbs", name).replace(os.sep, "/"),
                    "size": os.path.getsize(thumb_out),
                    "sha256": file_hash(thumb_out),
                    "mtime": os.path.getmtime(thumb_out),
                    "meta": {
                        "frame": frame_number(stem),
                        "width": self.enc.get("thumbWidth") or 320,
                    },
                },
            )
            self.done.add(name)

        if au_out and os.path.exists(au_out):
            # Append then unlink: libx265 repeats VPS/SPS/PPS in-band when no
            # global header is requested, so concatenated access units are a
            # legal Annex-B stream and this needs no bitstream filter.
            with open(self.stream_path, "ab") as stream, open(au_out, "rb") as au:
                shutil.copyfileobj(au, stream)
            os.unlink(au_out)
            self.live_done.add(stem)
            self.live_is_hdr = is_exr
            self.live_frames += 1
            self._maybe_emit()

        self._check_budget()

    def _maybe_emit(self):
        """Containerise the stream when the cadence says so.

        Frame-count gated, never bare time: on a 20s/frame Cycles render a
        plain 'every T seconds' would re-ship a byte-identical clip dozens of
        times, for a 50-100x redundancy multiplier.
        """
        if self._backfilling:
            return
        cfg = self.live_cfg
        min_frames = int(cfg.get("minFrames") or 5)
        max_age = float(cfg.get("maxAgeSec") or 20)
        new = self.live_frames - self.emitted_frames
        age = time.time() - self.last_emit
        if new <= 0:
            return
        if not (new >= min_frames or (age >= max_age and age >= 8)):
            return

        # The run token keeps emitted names unique ACROSS agent restarts. Named
        # by frame count alone, a restarted worker re-emits _live_0001.mp4 — a
        # filename the app has already downloaded and hashed, so the manifest
        # ends up with two mismatched entries for one file and the viewer is
        # served the stale 1-frame version.
        out_name = f"{self.chunk_id}_live_{self.run_token}_{self.live_frames:04d}.mp4"
        out_path = os.path.join(self.previews_dir, out_name)
        cmd = [
            sys.executable, ENCODE_SCRIPT, "--remux-live",
            "--stream", self.stream_path, "--out", out_path,
            "--fps", str(self.enc.get("fps") or 25),
        ]
        # Must match how the access units were actually encoded, not what we
        # guessed before the first frame existed — mislabelled colour tags on a
        # -c copy remux are unfixable downstream.
        if self.live_is_hdr:
            cmd += ["--hdr"]
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"remux-live exited {r.returncode}: {(r.stderr or '').strip()[:200]}")

        for line in r.stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                meta = json.loads(line)
            except ValueError:
                continue
            if os.path.exists(out_path):
                append_manifest(
                    self.chunk_dir,
                    {
                        "kind": "clip",
                        "file": meta["file"],
                        "size": os.path.getsize(out_path),
                        "sha256": file_hash(out_path),
                        "mtime": os.path.getmtime(out_path),
                        "meta": meta,
                    },
                )
        self.emitted_frames = self.live_frames
        self.last_emit = time.time()
        self._prune_versions()

    def _prune_versions(self, keep=2):
        """Keep the newest few live MP4s.

        One generation of slack matters: the app may be mid-download of the
        previous version when a new one lands, and deleting it under the
        transfer turns into a permanent 404 for that file.
        """
        try:
            versions = sorted(
                f for f in os.listdir(self.previews_dir)
                if f.startswith(f"{self.chunk_id}_live_") and f.endswith(".mp4")
            )
        except OSError:
            return
        for stale in versions[:-keep]:
            try:
                os.unlink(os.path.join(self.previews_dir, stale))
            except OSError:
                pass

    def _check_budget(self):
        """Stand down if previews are eating the render.

        The node is rented by the hour to render, not to make previews. If our
        own encode time passes ~15% of wall-clock we are competing with the
        thing being paid for, so stop.
        """
        elapsed = time.time() - self.render_started
        if elapsed > 120 and self.spent > elapsed * 0.15:
            self.disable(
                f"preview encoding used {self.spent:.0f}s of {elapsed:.0f}s — standing down"
            )


def frame_number(stem):
    """Blender writes zero-padded frame numbers as the filename."""
    try:
        return int(stem)
    except ValueError:
        return None


def log_line(chunk_id, message):
    try:
        with open(os.path.join(LOGS, f"{chunk_id}.log"), "a") as log:
            log.write(f"=== {message}\n")
    except OSError:
        pass


def run_render(spec, log_path, tracker):
    chunk_id = spec["chunkId"]
    chunk_dir = os.path.join(RENDERS, chunk_id)
    frames_dir = os.path.join(chunk_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    blender = pick_blender(spec)
    blend = os.path.join(ROOT, "work", "scenes", spec["blendFile"])
    if not os.path.exists(blend):
        raise RuntimeError(f"blend file missing: {blend}")

    def build_cmd(gpu_backend=None):
        # --python-exit-code makes script exceptions FATAL. Without it Blender
        # renders on after a failed -P script (verified on 5.1: exit 0, frame
        # saved), which silently defeats scene guard scripts — e.g. a packed
        # startup block that raises when a required extension is missing would
        # otherwise let black frames encode and download as "complete".
        cmd = [blender, "-b", blend, "-noaudio", "--python-exit-code", str(GUARD_EXIT)]
        if gpu_backend:
            cmd += ["--gpu-backend", gpu_backend]
        cmd += [
            "-P", os.path.join(ROOT, "blender", "run_startup_scripts.py"),
            "-P", os.path.join(ROOT, "blender", "enable_gpu.py"),
        ]
        for expr in spec.get("pythonExprs") or []:
            cmd += ["--python-expr", expr]
        cmd += [
            "-o", os.path.join(frames_dir, "####"),
            "-s", str(spec["frameStart"]),
            "-e", str(spec["frameEnd"]),
        ]
        if step > 1:
            cmd += ["-j", str(step)]
        cmd += list(spec.get("extraArgs") or [])
        cmd += ["-a"]
        return cmd

    step = int(spec.get("frameStep") or 1)
    cmd = build_cmd()

    frames_total = (spec["frameEnd"] - spec["frameStart"]) // step + 1
    state = {
        "status": "rendering",
        "currentFrame": None,
        "framesDone": len(tracker.recorded),
        "framesTotal": frames_total,
        "lastLine": "",
        "exitCode": None,
        "command": " ".join(cmd),
    }
    write_state(chunk_id, state)

    # With many concurrent blender processes, each spawning a full BLAS/OpenMP
    # thread pool thrashes the CPU — pin numeric libraries to one thread per
    # process. Single-slot jobs keep the historical (unpinned) environment.
    env = os.environ.copy()
    if slot_limit(spec) > 2:
        env.update({
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
        })

    def run_once(cmd):
        with open(log_path, "a") as log:
            log.write(f"=== {time.strftime('%F %T')} render start: {' '.join(cmd)}\n")
            log.flush()
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                env=env
            )

            # State heartbeat: the loop below only rewrites the state file
            # when blender emits a LINE, but a funded SDF trace is
            # legitimately silent for 15+ minutes per frame — long enough for
            # the app's stall watchdog to kill a healthy render. Refresh
            # updatedAt every 60s while the process lives, so "stale state"
            # reliably means "process dead", never just "quiet".
            # Never let this thread die: it is a daemon, so an escaping
            # exception would end it silently and take the anti-stall refresh
            # with it — leaving exactly the symptom it was added to prevent.
            def _heartbeat():
                while proc.poll() is None:
                    time.sleep(60)
                    if proc.poll() is None:
                        try:
                            write_state(chunk_id, state)
                        except Exception as e:  # noqa: BLE001
                            log_line(chunk_id, f"[agent] heartbeat write failed: {e}")

            threading.Thread(target=_heartbeat, daemon=True).start()
            last_state_write = 0.0
            for line in proc.stdout:
                log.write(line)
                m = FRA_RE.search(line)
                if m:
                    state["currentFrame"] = int(m.group(1))
                m = SAVED_RE.search(line)
                if m:
                    tracker.saw_saved(m.group(1))
                    state["framesDone"] = len(tracker.recorded) + len(tracker.pending)
                state["lastLine"] = line.strip()[:300]
                now = time.time()
                if now - last_state_write > 2:
                    tracker.flush()
                    state["framesDone"] = len(tracker.recorded)
                    write_state(chunk_id, state)
                    log.flush()
                    last_state_write = now
            code = proc.wait()
            log.write(f"=== render exit code {code}\n")
            return code

    code = run_once(cmd)

    # EEVEE needs a windowing GPU context even in background. Blender >= 5.0
    # defaults to the Vulkan backend, which container nodes often cannot
    # initialise (no ICD for the driver) even when EGL/OpenGL works fine — the
    # process dies before frame 1. If the first attempt produced nothing and
    # didn't fail via the script guard, retry once on the OpenGL backend.
    if (
        code not in (0, GUARD_EXIT)
        and spec.get("engine") == "eevee"
        and len(tracker.recorded) == 0
    ):
        with open(log_path, "a") as log:
            log.write(f"=== retrying with --gpu-backend opengl (first attempt exit {code})\n")
        code = run_once(build_cmd(gpu_backend="opengl"))

    # Catch any frames the log parser missed (or that settled late).
    for _ in range(5):
        tracker.flush(final=True)
        time.sleep(0.5)
    for name in sorted(os.listdir(frames_dir)):
        path = os.path.join(frames_dir, name)
        rel = os.path.relpath(path, os.path.join(RENDERS, chunk_id))
        if rel not in tracker.recorded and size_stable(path, wait=0.5):
            tracker.saw_saved(path)
    tracker.flush(final=True)

    state["framesDone"] = len(tracker.recorded)
    state["exitCode"] = code
    if code != 0:
        state["status"] = "failed"
        write_state(chunk_id, state)
        if code == GUARD_EXIT:
            raise RuntimeError(
                f"python script raised (exit {code}) — scene guard or startup script failed; see log"
            )
        raise RuntimeError(f"blender exited {code}")
    return state


def run_encode(spec, state, log_path):
    chunk_id = spec["chunkId"]
    enc = spec.get("encode")
    if not enc:
        return
    chunk_dir = os.path.join(RENDERS, chunk_id)
    state["status"] = "encoding"
    write_state(chunk_id, state)
    cmd = [
        sys.executable, ENCODE_SCRIPT,
        "--frames-dir", os.path.join(chunk_dir, "frames"),
        "--out-dir", os.path.join(chunk_dir, "previews"),
        "--label", chunk_id,
        "--fps", str(enc.get("fps") or 25),
        "--codec", enc.get("codec") or "hevc",
    ]
    if enc.get("sdr"):
        cmd.append("--sdr")
    if enc.get("hdr"):
        cmd.append("--hdr")
    if enc.get("proxy"):
        cmd.append("--proxy")
    with open(log_path, "a") as log:
        log.write(f"=== {time.strftime('%F %T')} encode start\n")
        log.flush()
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=log, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"encode failed ({r.returncode})")
    # encode_preview prints one JSON object per produced clip.
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            clip = json.loads(line)
        except ValueError:
            continue
        path = os.path.join(chunk_dir, clip["file"])
        if os.path.exists(path):
            append_manifest(
                chunk_dir,
                {
                    "kind": "clip",
                    "file": clip["file"],
                    "size": os.path.getsize(path),
                    "sha256": file_hash(path),
                    "mtime": os.path.getmtime(path),
                    "meta": clip,
                },
            )


def process(spec_path):
    with open(spec_path) as f:
        spec = json.load(f)
    chunk_id = spec["chunkId"]
    log_path = os.path.join(LOGS, f"{chunk_id}.log")
    chunk_dir = os.path.join(RENDERS, chunk_id)
    os.makedirs(chunk_dir, exist_ok=True)

    # Frame format follows the .blend, so EXR is usual but not guaranteed.
    # It decides whether the linear→display conversion applies at all, and
    # whether an HDR live clip is even meaningful.
    worker = PreviewWorker(chunk_id, chunk_dir, spec.get("encode"))
    tracker = FrameTracker(chunk_dir, on_frame=worker.submit)
    if worker.may_run:
        worker.start()
    try:
        state = run_render(spec, log_path, tracker)
        # Stop and join BEFORE the definitive encode: the worker reads the same
        # frames and there is no reason to have both competing for the CPU
        # once the render itself has finished.
        stop_worker(worker)
        run_encode(spec, state, log_path)
        state["status"] = "done"
        write_state(chunk_id, state)
        shutil.move(spec_path, os.path.join(DONE, os.path.basename(spec_path)))
    except Exception as e:  # noqa: BLE001 — agent must never die on a job
        write_state(
            chunk_id,
            {
                "status": "failed",
                "error": str(e),
                "framesDone": len(tracker.recorded),
                "exitCode": None,
            },
        )
        with open(log_path, "a") as log:
            log.write(f"=== FAILED: {e}\n")
        shutil.move(spec_path, os.path.join(FAILED, os.path.basename(spec_path)))
    finally:
        # The failure path never reaches run_encode, so cleanup cannot live
        # there — a failed chunk would leave its worker and scratch behind.
        stop_worker(worker)
        cleanup_live_stream(chunk_dir)


def stop_worker(worker):
    if worker.is_alive():
        worker.stop()
        worker.join(timeout=30)


def cleanup_live_stream(chunk_dir):
    """Drop the accumulated Annex-B stream; the versioned MP4s are the output."""
    try:
        os.unlink(os.path.join(chunk_dir, "previews", "live.h265"))
    except OSError:
        pass


def gpu_vram_mb():
    """Total VRAM of GPU 0 in MB, or None when nvidia-smi is unavailable."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()
        return int(float(out[0])) if out else None
    except Exception:  # noqa: BLE001
        return None


def node_ceiling():
    """Hardware slot ceiling: min(threads/2, vram_gb/1, ram_gb/3, 24).

    The render trace is mostly single-threaded CPU per blender process;
    EEVEE at ~1Kpx measured ~0.5 GB VRAM per process (SDF scenes,
    2026-07-27) — 1 GB/slot keeps 2x headroom. The earlier 1.5 GB assumption
    VRAM-capped 56-thread/12 GB boxes to 8 slots and idled their CPUs.
    """
    cores = os.cpu_count() or 4
    # cores // 2, not cores - 2: os.cpu_count() reports THREADS; one funded
    # trace saturates a physical core, and 14 slots on a 16-thread consumer
    # box measured ~10x per-frame degradation. Half the thread count tracks
    # physical cores closely across the fleet's actual hardware.
    cap = max(1, cores // 2)
    vram = gpu_vram_mb()
    if vram is not None:
        cap = min(cap, max(1, int(vram // 1024)))
    try:
        with open("/proc/meminfo") as f:
            mem_gb = int(f.readline().split()[1]) / 1048576.0
        cap = min(cap, max(1, int(mem_gb // 3)))
    except (OSError, ValueError, IndexError):
        pass
    return min(cap, 24)


def slot_limit(spec):
    """Concurrent render slots this spec asks for.

    Absent / 1 → 1 (the historical behaviour, unchanged for anyone whose app
    doesn't send nodeSlots). "auto"/0 → the hardware ceiling. Explicit N →
    min(N, ceiling).
    """
    raw = spec.get("nodeSlots")
    if raw in (None, "", 1):
        return 1
    if raw in (0, "auto"):
        return node_ceiling()
    return max(1, min(int(raw), node_ceiling()))


def is_exclusive(spec):
    """Must this chunk have the node to itself?

    Set from the job's shareNode flag. The scheduler already refuses to
    co-locate an exclusive chunk, so this is a backstop for the cases it
    cannot cover: a spec landing while the node drains, and stale specs left
    in the inbox by a previous app run.

    Absent → False, so a spec written by an older app keeps its old behaviour
    (which was governed by nodeSlots alone).
    """
    return bool(spec.get("exclusive"))


def main():
    ensure_dirs()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    print(f"noderunner up, watching {INBOX}", flush=True)
    # Multi-slot: up to `slots` chunks render concurrently, each in its own
    # blender subprocess + thread. All chunk state is per-chunkId (log, state
    # json, renders/<chunkId>/ dir, manifest) so workers never share files;
    # the in_progress set stops double-claims within this process.
    in_progress = {}  # spec filename -> (Thread, exclusive)
    while True:
        for name, (t, _excl) in list(in_progress.items()):
            if not t.is_alive():
                del in_progress[name]
        # An exclusive chunk owns the whole node while it runs.
        holding_exclusive = any(excl for _t, excl in in_progress.values())
        # FIFO by spec mtime, not filename: alphabetical order starves jobs
        # whose ids sort late whenever the inbox holds more specs than slots.
        def spec_mtime(name):
            try:
                return os.path.getmtime(os.path.join(INBOX, name))
            except OSError:
                return 0.0

        specs = sorted(
            (p for p in os.listdir(INBOX) if p.endswith(".json") and not p.endswith(".tmp.json")),
            key=spec_mtime,
        )
        slots = 1
        parsed = []  # (name, exclusive)
        for name in specs:
            if name in in_progress:
                continue
            try:
                with open(os.path.join(INBOX, name)) as f:
                    spec = json.load(f)
            except (OSError, ValueError):
                continue  # mid-write or corrupt — retry next scan
            parsed.append((name, is_exclusive(spec)))
            slots = max(slots, slot_limit(spec))
        launched = False
        for name, exclusive in parsed:
            # Nothing starts alongside an exclusive chunk, and an exclusive
            # chunk starts only on an empty node. Both directions matter: the
            # first keeps a GPU-saturating render from being joined, the
            # second keeps it from joining others. Staying in FIFO order (a
            # `break`, not a `continue`) means the exclusive chunk at the head
            # waits for the node to drain rather than being passed over
            # forever by lighter work behind it.
            if holding_exclusive:
                break
            if exclusive and in_progress:
                break
            if len(in_progress) >= slots:
                break
            t = threading.Thread(target=process, args=(os.path.join(INBOX, name),), daemon=True)
            in_progress[name] = (t, exclusive)
            if exclusive:
                holding_exclusive = True
            t.start()
            launched = True
            print(
                f"slot start {name} ({len(in_progress)}/{1 if exclusive else slots})"
                + (" exclusive" if exclusive else ""),
                flush=True,
            )
        if not launched:
            time.sleep(2)


if __name__ == "__main__":
    main()

