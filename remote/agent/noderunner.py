#!/usr/bin/env python3
"""Node agent — runs ON the rented instance under tmux, stdlib only.

Contract with the app (all under ~/vastai/):
  jobs/inbox/<chunkId>.json   job specs, SFTP-written by the app (atomic move)
  jobs/done/  jobs/failed/    specs move here on completion/failure
  logs/<chunkId>.log          full blender stdout/stderr
  state/<chunkId>.json        durable progress; see "Chunk state" below
  state/heartbeat             touched every 10s. provisioner.ts agentAlive()
                              reads it, but nothing in the app calls that yet
  renders/<chunkId>/frames/   render output
  renders/<chunkId>/manifest.jsonl
                              one JSON line per completed artefact:
                              {"kind":"frame"|"clip", "file":<relative>,
                               "size":N, "sha256":hex, "mtime":N, ...}

The manifest is the ONLY thing the app trusts for downloads — a file is listed
only after it is size-stable, so partially-written frames are never pulled.
Size-stable is not enough on its own (a file whose writer was killed is stable
too), so a frame is listed only once Blender announced it with "Saved:", or
when the end-of-render sweep finds it after a CLEAN run: exit 0 and no write
errors — see run_render.

Job spec:
  { "chunkId": str, "blendFile": str (under work/scenes/),
    "blenderVersion": "4.5.3", "engine": "cycles"|"eevee"|"octane",
    "frameStart": int, "frameEnd": int, "frameStep": int,
    "extraArgs": [str], "pythonExprs": [str],
    "nodeSlots": int, "exclusive": bool,
    "lanes": int (exclusive chunks that may run side by side; absent = 1),
    "pinGpus": bool (pin each render to one GPU; absent = false),
    "encode": null | {"sdr": bool, "hdr": bool, "proxy": bool,
                       "codec": "hevc"|"av1", "fps": float,
                       "thumbs": bool, "thumbWidth": int} }

Every `encode` sub-key is optional and absent means off, so an old app talking
to a new agent (and vice versa) both degrade to the behaviour they knew.

Chunk state (state/<chunkId>.json, rewritten atomically; fields are only ever
added, so an older app reads a newer agent's state):
  { "status": "rendering"|"encoding"|"done"|"failed",
    "currentFrame": int|null, "framesDone": int, "framesTotal": int,
    "lastLine": str, "command": str,
    "exitCode": int|null      Blender's exit code; null until it exits, and
                              in a failed state null only if it never ran,
    "gpu": int|null           the GPU the render is pinned to,
    "updatedAt": float        epoch s of the last write; the 60 s heartbeat
                              refreshes it while Blender lives, so it says
                              the process is alive, not that it is working,
    "lastProgressAt": float   epoch s of the last progress: when this
                              attempt's Blender started, then each saved
                              frame and each "Fra:" naming a new frame. The
                              heartbeat never moves it, so a hung Blender
                              shows it falling behind updatedAt. Rendering
                              only: encoding makes no frame progress }
  A failed state keeps every field it had and adds:
    "error": str              one readable line,
    "errorKind": "scene"|"job"|"machine"|"transient"   see ERROR_KINDS,
    "logTail": [str]          the chunk log's last ~40 lines
"""

import errno
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
# Blender's line for a frame it failed to write: "Render error (No space left
# on device) cannot save: '<path>'". It then stops the animation but may still
# exit 0, and the partial file it leaves has a fresh mtime and sits on the grid.
SAVE_FAILED_RE = re.compile(r"cannot save: '(.+?)'")
# What `-o frames/####` produces: the zero-padded frame number and an extension.
FRAME_NAME_RE = re.compile(r"^(\d+)\.\w+$")

# Exit code Blender returns when any Python script raises (--python-exit-code).
# Distinguishes "a scene/startup guard aborted the render" from render crashes.
GUARD_EXIT = 32
# Blender's own line when a -P script or a --python-expr raised under
# --python-exit-code: "Error: script failed, file: '<path>', exiting." or
# "Error: script failed, expr: '<code>', exiting."
SCRIPT_FAILED_RE = re.compile(r"script failed, (file|expr): '")

# Why a chunk failed. Every failed state carries one as errorKind, so the app's
# retry policy (plan 1.17) decides from a fact rather than from the wording:
#   "scene"      the .blend cannot render right on any node: a scene guard or a
#                startup script in it raised. Retrying elsewhere only pays for
#                the same failure again.
#   "job"        the job asks for something no node can give it: one of the
#                job's own python expressions raised.
#   "machine"    this node cannot render it: its disk is full or failing, it has
#                no Blender. Another node may.
#   "transient"  anything else: a crash, a kill, an exit nothing explains.
#                Retrying may work, which is how the app treated every failure
#                before errorKind existed.
ERROR_KINDS = ("scene", "job", "machine", "transient")
# OSErrors that are this node's disk failing, not the job.
MACHINE_ERRNOS = {errno.ENOSPC, errno.EDQUOT, errno.EROFS, errno.EIO}
# Lines of the chunk log a failed state carries as logTail, so the app can show
# why without another round trip to the node.
LOG_TAIL_LINES = 40

# Pause between run_render's end-of-render settle passes, taken only while an
# announced frame is still not size-stable. selfcheck shortens it.
SETTLE_PAUSE = 0.5


class ChunkFailed(RuntimeError):
    """A chunk failure whose errorKind (one of ERROR_KINDS) is known.

    `exit_code` is Blender's, or None when the failure came before Blender ran.
    Any other exception out of a chunk is "transient", or "machine" for a disk
    errno; see failure_kind.
    """

    def __init__(self, message, kind, exit_code=None):
        super().__init__(message)
        self.kind = kind
        self.exit_code = exit_code


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
    raise ChunkFailed("no blender installation found", "machine")


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

    def forget_pending(self):
        """Drop announcements not yet recorded, before a new attempt starts.

        run_render settles the attempt being replaced first, so every announced
        frame that is complete has been recorded and is kept. What is left here
        was announced but never became size-stable (empty, or gone). Its file is
        about to be deleted by discard_unmanifested and rendered again, and a
        later flush would record whatever is on disk at that moment under the
        OLD announcement: a half-written file, if the new attempt dies mid-write
        on it. The new attempt announces every frame it finishes itself.
        """
        with self.lock:
            self.pending = []

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


def log_tail(path, lines=LOG_TAIL_LINES, max_bytes=32768):
    """The last `lines` lines of a chunk log, for a failed state's logTail.

    Read from the end, so a day-long render's log costs what a short one's
    does, and each line is capped: the app reads the state file every few
    seconds, and one runaway line must not make it huge.
    """
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            text = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return []
    if size > max_bytes:
        text = text[1:]  # the seek cut the first line
    return [line[:400] for line in text[-lines:]]


def failure_kind(err):
    """(errorKind, exitCode) for an exception out of a chunk. See ERROR_KINDS."""
    if isinstance(err, ChunkFailed):
        return err.kind, err.exit_code
    if isinstance(err, OSError) and err.errno in MACHINE_ERRNOS:
        return "machine", None
    return "transient", None


def record_failure(chunk_id, state, err, log_path, frames_done):
    """Publish a failed state that says why. Never raises.

    The failure is added to the state the render was writing, not written in
    place of it, so the app still sees the frame, command and GPU it failed
    on. It gains errorKind, exitCode (Blender's, or None if Blender never ran;
    the old failure dict always said None, even for a crash) and logTail.
    A state write that fails is only logged: the caller must still move the
    spec out of the inbox, or the main loop would launch it again, forever.
    """
    kind, code = failure_kind(err)
    log_line(chunk_id, f"FAILED ({kind}): {err}")
    state.update({
        "status": "failed",
        "error": str(err),
        "errorKind": kind,
        "exitCode": code if code is not None else state.get("exitCode"),
        "framesDone": frames_done,
        "logTail": log_tail(log_path),
    })
    try:
        write_state(chunk_id, state)
    except Exception as e:  # noqa: BLE001
        print(f"[agent] could not write the failed state of {chunk_id}: {e}", flush=True)


def discard_unmanifested(chunk_id, chunk_dir, recorded):
    """Delete every file in frames/ the manifest does not list.

    Runs before each attempt, and again after a run that ended unclean. An
    unlisted file is untrusted by definition: the frame a killed Blender was
    mid-write on (provision.sh's `pkill` on every app restart, a cancel, an OOM
    kill), or one a failed attempt left behind. Left in place it is a hazard
    twice over: a .blend with Overwrite unchecked makes Blender skip any frame
    already on disk, so it is never replaced, and the end-of-render sweep then
    finds it and manifests it with a hash over the truncated bytes, which the
    app verifies against and accepts.

    Manifested frames are kept: the app may not have downloaded them yet, and
    their size and hash are already promised to it. This is the one place the
    agent deletes paid-for output, so it errs towards keeping: files are matched
    by NAME, not by the manifest's relative path, so a path spelled differently
    cannot cost a finished frame; and `recorded` is unioned with a fresh
    manifest read, since manifest_files returns nothing on a failed read.
    """
    frames_dir = os.path.join(chunk_dir, "frames")
    keep = {
        os.path.basename(f)
        for f in set(recorded) | manifest_files(chunk_dir, kind="frame")
    }
    try:
        names = sorted(os.listdir(frames_dir))
    except OSError:
        return []
    removed = []
    for name in names:
        path = os.path.join(frames_dir, name)
        if name in keep or not os.path.isfile(path):
            continue
        try:
            os.remove(path)
            removed.append(name)
        except OSError as e:
            # Not fatal: the sweep's mtime filter still keeps it out of the manifest.
            log_line(chunk_id, f"could not discard unmanifested frames/{name}: {e}")
    if removed:
        shown = ", ".join(removed[:10]) + (" ..." if len(removed) > 10 else "")
        log_line(chunk_id, f"discarded {len(removed)} unmanifested file(s) from frames/: {shown}")
    return removed


def unannounced_frames(frames_dir, spec, since, recorded):
    """Files this attempt wrote to frames/ whose "Saved:" line the parser missed.

    The end-of-render safety net. Deliberately narrow, because whatever it
    returns goes into the manifest with a hash over the bytes on disk:
      * only `NNNN.ext` names, which is what `-o frames/####` produces;
      * only frame numbers on the spec's start..end/step grid, so a leftover
        from the wider chunk this one was split from cannot ride along;
      * only files modified since this attempt started, so nothing an earlier,
        killed attempt left behind (if discard_unmanifested could not delete
        it) passes as this attempt's output.
    Only ever call it after a CLEAN run (exit 0, no "cannot save" line): the
    frame a crashed Blender died writing, or one it failed to write, passes
    every one of these tests.
    """
    start, end = int(spec["frameStart"]), int(spec["frameEnd"])
    step = int(spec.get("frameStep") or 1)
    chunk_dir = os.path.dirname(frames_dir)
    try:
        names = sorted(os.listdir(frames_dir))
    except OSError:
        return []
    found = []
    for name in names:
        m = FRAME_NAME_RE.match(name)
        if not m:
            continue
        n = int(m.group(1))
        if n < start or n > end or (n - start) % step:
            continue
        path = os.path.join(frames_dir, name)
        if os.path.relpath(path, chunk_dir) in recorded:
            continue
        try:
            if not os.path.isfile(path) or os.path.getmtime(path) < since:
                continue
        except OSError:
            continue
        found.append(path)
    return found


def scan_line(line, state, seen, now=None):
    """Fold one line of Blender's output into the chunk's state.

    `state` is what the app reads; `seen` collects what only the failure
    classification needs. Returns (saved, save_failed): the path of a frame
    Blender announced with "Saved:" or reported it could not write, or None.

    lastProgressAt moves only on real progress: a saved frame, or a "Fra:"
    line naming a frame other than the last one. Blender repeats "Fra:" for
    every sample of the same frame, so counting those, like the updatedAt
    the heartbeat refreshes, would make a hung render look busy (#77).
    """
    now = time.time() if now is None else now
    saved = save_failed = None
    m = FRA_RE.search(line)
    if m:
        frame = int(m.group(1))
        if frame != state.get("currentFrame"):
            state["lastProgressAt"] = now
        state["currentFrame"] = frame
    m = SAVED_RE.search(line)
    if m:
        saved = m.group(1)
        state["lastProgressAt"] = now
    m = SAVE_FAILED_RE.search(line)
    if m:
        save_failed = m.group(1)
    m = SCRIPT_FAILED_RE.search(line)
    if m:
        seen["scriptFailed"] = m.group(1)
    state["lastLine"] = line.strip()[:300]
    return saved, save_failed


def classify_exit(code, save_failed, seen):
    """(errorKind, message) for a render that ended unclean. See ERROR_KINDS."""
    if code == GUARD_EXIT:
        if seen.get("scriptFailed") == "expr":
            # The job's own --python-expr (an extension's register call),
            # the same on every node.
            return "job", f"a python expression of the job raised (exit {code}); see log"
        return "scene", (
            f"python script raised (exit {code}) — scene guard or startup script failed; see log"
        )
    if save_failed:
        return "machine", (
            f"blender could not save {os.path.basename(save_failed[0])} (exit {code})"
            " — disk full or I/O error; see log"
        )
    return "transient", f"blender exited {code}"


def run_render(spec, log_path, tracker, gpu=None, state=None):
    chunk_id = spec["chunkId"]
    chunk_dir = os.path.join(RENDERS, chunk_id)
    frames_dir = os.path.join(chunk_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    blender = pick_blender(spec)
    blend = os.path.join(ROOT, "work", "scenes", spec["blendFile"])
    if not os.path.exists(blend):
        # The app uploads it during node prep, and a re-dispatch uploads it
        # again.
        raise ChunkFailed(f"blend file missing: {blend}", "transient")

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
    # Filled in place: process() owns the dict, and adds a failure to it
    # rather than replacing it (record_failure).
    if state is None:
        state = {}
    state.update({
        "status": "rendering",
        "currentFrame": None,
        "framesDone": len(tracker.recorded),
        "framesTotal": frames_total,
        "lastLine": "",
        "exitCode": None,
        "command": " ".join(cmd),
        # The GPU this render is pinned to (nvidia-smi index), or None. The app
        # shows it per slot on the Fleet screen.
        "gpu": gpu,
        # Reset again as each attempt's Blender starts; see scan_line.
        "lastProgressAt": time.time(),
    })
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
    if gpu is not None:
        env.update(gpu_env(gpu))
        log_line(chunk_id, f"pinned to GPU {gpu} ({env.get('VR_GPU_BUS') or 'bus id unknown'})")

    # When the current attempt launched Blender; the end-of-render sweep only
    # adopts files modified since. Set by run_once.
    attempt_started = time.time()
    # Paths Blender said it could not save (SAVE_FAILED_RE), over all attempts.
    # Any one makes the render unclean, exactly like a non-zero exit.
    save_failed = []
    # What scan_line saw that only the failure's errorKind needs.
    seen = {}

    def run_once(cmd):
        nonlocal attempt_started
        # Each attempt starts from a frames/ holding only manifested frames, and
        # with no announcements carried over from the attempt it replaces. See
        # forget_pending and discard_unmanifested.
        tracker.forget_pending()
        discard_unmanifested(chunk_id, chunk_dir, tracker.recorded)
        attempt_started = time.time()
        # A new Blender has made no progress yet, and the app's watchdog times
        # its scene load and first frame from here.
        state["lastProgressAt"] = attempt_started
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
            # reliably means "process dead", never just "quiet". It leaves
            # lastProgressAt alone: that is what tells a hung Blender, alive
            # but making no frames, from a slow one.
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
                saved, failed = scan_line(line, state, seen)
                if saved:
                    tracker.saw_saved(saved)
                    state["framesDone"] = len(tracker.recorded) + len(tracker.pending)
                if failed:
                    save_failed.append(failed)
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

    def settle():
        # Record the frames Blender announced. It prints "Saved:" only once the
        # write succeeded, so these are complete whatever the exit code. Another
        # pass only helps a file whose size is still changing.
        for _ in range(5):
            tracker.flush(final=True)
            if not tracker.pending:
                break
            time.sleep(SETTLE_PAUSE)

    recorded_before = len(tracker.recorded)
    code = run_once(cmd)
    # Settle BEFORE deciding on a retry. The in-loop flush runs at most every
    # 2 s, so a frame announced just before the exit can still be pending, and
    # the retry would delete it (forget_pending, discard_unmanifested): a
    # finished, paid-for frame thrown away, and lost for good if the retry then
    # fails at startup.
    settle()

    # EEVEE needs a windowing GPU context even in background. Blender >= 5.0
    # defaults to the Vulkan backend, which container nodes often cannot
    # initialise (no ICD for the driver) even when EGL/OpenGL works fine — the
    # process dies before frame 1. If the first attempt produced no frame,
    # didn't fail via the script guard and hit no write error (a full disk is
    # not a backend problem), retry once on the OpenGL backend. "No frame" is
    # measured against the manifest as it stood before: a chunk re-dispatched
    # to this node after a restart starts with frames recorded, and its Vulkan
    # failure is just as retryable.
    if (
        code not in (0, GUARD_EXIT)
        and spec.get("engine") == "eevee"
        and len(tracker.recorded) == recorded_before
        and not save_failed
    ):
        with open(log_path, "a") as log:
            log.write(f"=== retrying with --gpu-backend opengl (first attempt exit {code})\n")
        code = run_once(build_cmd(gpu_backend="opengl"))
        settle()

    clean = code == 0 and not save_failed
    if clean:
        # Catch frames the log parser missed, but ONLY after a clean run. After
        # a crash, a kill or a failed write, an unannounced file is the frame
        # Blender died writing or could not finish: size_stable passes it (a
        # dead writer's size never changes), and it used to be manifested with
        # a hash over the truncated bytes, so the app verified it, marked it
        # downloaded and never rendered it again.
        for path in unannounced_frames(frames_dir, spec, attempt_started, tracker.recorded):
            if size_stable(path, wait=0.5):
                tracker.saw_saved(path)
        tracker.flush(final=True)
    else:
        # Unclean: delete every unlisted file in frames/ now, that partial frame
        # included. Leaving it to this chunk's next attempt here is not enough:
        # the app may re-dispatch the chunk to another node, and the file would
        # then take up this disk for the life of the instance.
        discard_unmanifested(chunk_id, chunk_dir, tracker.recorded)

    state["framesDone"] = len(tracker.recorded)
    state["exitCode"] = code
    if not clean:
        # process() publishes the failed state, once, with its errorKind.
        kind, message = classify_exit(code, save_failed, seen)
        raise ChunkFailed(message, kind, code)
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


def process(spec_path, gpu=None):
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
    # The chunk's one state dict: run_render fills it in, and a failure is
    # added to it (record_failure). The heartbeat thread writes this same
    # object, so a late heartbeat can never put back a state the failure
    # already replaced.
    state = {"gpu": gpu}
    try:
        run_render(spec, log_path, tracker, gpu, state)
        # Stop and join BEFORE the definitive encode: the worker reads the same
        # frames and there is no reason to have both competing for the CPU
        # once the render itself has finished.
        stop_worker(worker)
        run_encode(spec, state, log_path)
        state["status"] = "done"
        write_state(chunk_id, state)
        shutil.move(spec_path, os.path.join(DONE, os.path.basename(spec_path)))
    except Exception as e:  # noqa: BLE001 — agent must never die on a job
        record_failure(chunk_id, state, e, log_path, len(tracker.recorded))
        # Even when the state could not be written (a full disk): a spec left
        # in the inbox is launched again by the next scan, and fails again.
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
    """Total VRAM summed over every GPU in MB, or None without nvidia-smi.

    Summed, not GPU 0's: the app's hardCap() sums nvidia-smi's rows, and the two
    ceilings must agree or the agent silently runs fewer chunks than the
    scheduler believes it dispatched. (GPU 0 alone capped a 4-GPU node at a
    quarter of its VRAM.)
    """
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()
        vals = [int(float(x)) for x in out if x.strip()]
        return sum(vals) if vals else None
    except Exception:  # noqa: BLE001
        return None


_GPUS = None


def gpu_list():
    """[(index, pci_bus_id)] from nvidia-smi, cached; [] when unavailable.

    nvidia-smi enumerates in PCI bus order, and gpu_env() sets
    CUDA_DEVICE_ORDER=PCI_BUS_ID so CUDA's index i is the same card as
    nvidia-smi's index i — which is what lets the app match a slot's GPU to its
    per-GPU telemetry.
    """
    global _GPUS
    if _GPUS is not None:
        return _GPUS
    gpus = []
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,pci.bus_id", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()
        for line in out:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2 and parts[0].isdigit():
                gpus.append((int(parts[0]), parts[1]))
    except Exception:  # noqa: BLE001
        pass
    _GPUS = gpus
    return gpus


def gpu_env(gpu):
    """Environment that confines one Blender to GPU `gpu`.

    CUDA_VISIBLE_DEVICES hides every other card from CUDA and OptiX alike, so
    Cycles lists just this one (once as CUDA, once as OPTIX). VR_GPU_* tell
    enable_gpu.py which card was meant, as a backstop should the variable not
    take effect.
    """
    bus = dict(gpu_list()).get(gpu, "")
    return {
        "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
        "CUDA_VISIBLE_DEVICES": str(gpu),
        "VR_GPU_INDEX": str(gpu),
        "VR_GPU_BUS": bus,
    }


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


def lane_limit(spec):
    """Exclusive chunks this spec allows side by side — the node's GPU lanes.

    Absent → 1: an exclusive chunk holds the whole node, as before.
    """
    try:
        return max(1, min(int(spec.get("lanes") or 1), 32))
    except (TypeError, ValueError):
        return 1


def pick_gpu(running_gpus, gpu_count):
    """Least-loaded GPU index (ties → lowest) given the GPUs already in use."""
    counts = [0] * gpu_count
    for g in running_gpus:
        if g is not None and 0 <= g < gpu_count:
            counts[g] += 1
    return min(range(gpu_count), key=lambda i: (counts[i], i))


def plan_launches(parsed, running, gpu_count, slots):
    """Which queued specs to start now, and on which GPU. Pure.

    parsed:  [(name, spec)] waiting in the inbox, FIFO order
    running: [(exclusive, gpu)] renders already in progress
    slots:   shared-work concurrency (max slot_limit over the queue)

    Rules (identical to the old loop whenever lanes = 1 and nothing is pinned):
      * exclusive and shared work never run together;
      * exclusive chunks run up to `lanes` at once (one per GPU lane);
      * shared chunks run up to `slots` at once;
      * FIFO: the head waits rather than being overtaken (`break`, not
        `continue`), so an exclusive chunk is never starved by lighter work.
    Pinned specs go to the least-loaded GPU.
    """
    running = list(running)
    launches = []
    for name, spec in parsed:
        exclusive = is_exclusive(spec)
        n_excl = sum(1 for e, _g in running if e)
        n_shared = len(running) - n_excl
        if exclusive:
            if n_shared or n_excl >= lane_limit(spec):
                break
        else:
            if n_excl or len(running) >= slots:
                break
        gpu = None
        if spec.get("pinGpus") and gpu_count > 1:
            gpu = pick_gpu([g for _e, g in running], gpu_count)
        running.append((exclusive, gpu))
        launches.append((name, gpu))
    return launches


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
    in_progress = {}  # spec filename -> (Thread, exclusive, gpu)
    while True:
        for name, (t, _excl, _gpu) in list(in_progress.items()):
            if not t.is_alive():
                del in_progress[name]
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
        parsed = []  # (name, spec)
        for name in specs:
            if name in in_progress:
                continue
            try:
                with open(os.path.join(INBOX, name)) as f:
                    spec = json.load(f)
            except (OSError, ValueError):
                continue  # mid-write or corrupt — retry next scan
            parsed.append((name, spec))
            slots = max(slots, slot_limit(spec))
        # Exclusive and shared work never mix; exclusive chunks take one GPU
        # lane each (the whole node when lanes = 1). See plan_launches.
        running = [(excl, gpu) for _t, excl, gpu in in_progress.values()]
        launched = False
        specs_by_name = dict(parsed)
        for name, gpu in plan_launches(parsed, running, len(gpu_list()), slots):
            exclusive = is_exclusive(specs_by_name[name])
            t = threading.Thread(
                target=process, args=(os.path.join(INBOX, name), gpu), daemon=True
            )
            in_progress[name] = (t, exclusive, gpu)
            t.start()
            launched = True
            limit = lane_limit(specs_by_name[name]) if exclusive else slots
            print(
                f"slot start {name} ({len(in_progress)}/{limit})"
                + (" exclusive" if exclusive else "")
                + (f" gpu {gpu}" if gpu is not None else ""),
                flush=True,
            )
        if not launched:
            time.sleep(2)


if __name__ == "__main__":
    main()

