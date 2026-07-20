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
                       "codec": "hevc"|"av1", "fps": float} }
"""

import hashlib
import json
import os
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
BLENDER_ROOT = os.path.join(ROOT, "blender")
OCTANE_BLENDER = "/usr/local/OctaneBlender/blender"
ENCODE_SCRIPT = os.path.join(ROOT, "encode", "encode_preview.py")

FRA_RE = re.compile(r"^Fra:(\d+)")
SAVED_RE = re.compile(r"Saved: '(.+?)'")


def ensure_dirs():
    for d in (INBOX, DONE, FAILED, LOGS, STATE, RENDERS):
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


def write_state(chunk_id, state):
    state["updatedAt"] = time.time()
    path = os.path.join(STATE, f"{chunk_id}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


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


def manifest_files(chunk_dir):
    """Relative paths already recorded in the manifest."""
    seen = set()
    try:
        with open(os.path.join(chunk_dir, "manifest.jsonl")) as f:
            for line in f:
                try:
                    seen.add(json.loads(line)["file"])
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

    def __init__(self, chunk_dir):
        self.chunk_dir = chunk_dir
        self.pending = []  # absolute paths reported by "Saved:" lines
        self.recorded = manifest_files(chunk_dir)
        self.lock = threading.Lock()

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
            else:
                still.append(path)
        with self.lock:
            self.pending = still + [p for p in self.pending if p not in pending]
        return count


def run_render(spec, log_path, tracker):
    chunk_id = spec["chunkId"]
    chunk_dir = os.path.join(RENDERS, chunk_id)
    frames_dir = os.path.join(chunk_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)

    blender = pick_blender(spec)
    blend = os.path.join(ROOT, "work", "scenes", spec["blendFile"])
    if not os.path.exists(blend):
        raise RuntimeError(f"blend file missing: {blend}")

    cmd = [
        blender, "-b", blend, "-noaudio",
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
    step = int(spec.get("frameStep") or 1)
    if step > 1:
        cmd += ["-j", str(step)]
    cmd += list(spec.get("extraArgs") or [])
    cmd += ["-a"]

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

    with open(log_path, "a") as log:
        log.write(f"=== {time.strftime('%F %T')} render start: {' '.join(cmd)}\n")
        log.flush()
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
        )
        last_state_write = 0.0
        for line in proc.stdout:
            log.write(line)
            m = FRA_RE.match(line)
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
    tracker = FrameTracker(chunk_dir)
    try:
        state = run_render(spec, log_path, tracker)
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


def main():
    ensure_dirs()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    print(f"noderunner up, watching {INBOX}", flush=True)
    while True:
        specs = sorted(
            p for p in os.listdir(INBOX) if p.endswith(".json") and not p.endswith(".tmp.json")
        )
        if specs:
            process(os.path.join(INBOX, specs[0]))
        else:
            time.sleep(2)


if __name__ == "__main__":
    main()

