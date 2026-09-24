#!/bin/bash
# Node provisioning — run ON the rented instance (root). Idempotent; safe to
# re-run after app updates. Shipped verbatim over SFTP to ~/vastai/ by the app.
#
# Usage:
#   provision.sh deps [--force]            # dirs + apt deps + static ffmpeg; the installs are
#                                          #   skipped when this build already ran them
#   provision.sh restart-agent [--force]   # restart the agent under tmux only when its code
#                                          #   changed or it is dead; --force always does
#   provision.sh agent-status              # one JSON line: agent hash, heartbeat age, Blender
#                                          #   processes, inbox specs, what restart-agent would do
#   provision.sh base                      # deps + restart-agent --force (the pre-split command)
#   provision.sh install-blender <version> # e.g. 4.5.3 → ~/vastai/blender/4.5.3/
#   provision.sh probe-eevee <version>     # 1-frame EEVEE render capability probe
#   provision.sh ensure-optix              # add OptiX libs when the container lacks them
set -euo pipefail

VASTAI_HOME="${VASTAI_HOME:-$HOME/vastai}"
BLENDER_ROOT="$VASTAI_HOME/blender"
STATE_DIR="$VASTAI_HOME/state"
# Hash of the shipped tree whose deps are installed, written only once they all are.
DEPS_STAMP="$STATE_DIR/deps.sha256"
# Hash of the agent code the running agent was started from. The files on disk
# can be newer: the app uploads its tree before every provision, while the
# agent process keeps running what it loaded.
AGENT_HASH_FILE="$STATE_DIR/agent.sha256"
# Touched every 10 s by noderunner.py's heartbeat_loop.
HEARTBEAT="$STATE_DIR/heartbeat"
# Six missed beats. A false "stale" kills paid renders, while a false "fresh"
# only leaves a dead agent to the app's liveness checks, so err towards fresh.
AGENT_STALE_S=60
# How long a restarted agent has to write its first heartbeat, which main()
# does before anything else. (Tests shorten it.)
AGENT_START_WAIT_S="${AGENT_START_WAIT_S:-30}"
# Where the container's system libraries are, and ensure-optix installs the
# OptiX ones. (Tests point it at a temp dir.)
OPTIX_LIBDIR="${OPTIX_LIBDIR:-/usr/lib/x86_64-linux-gnu}"

log() { echo "[provision] $*"; }

# Take the node-wide lock <name> (fd 9) and hold it until this script exits,
# waiting up to $2 seconds (0: not at all) for a copy of the step already
# running; returns 1 if that copy still runs. Anything started here to
# outlive the script gets 9>&-, or it would hold the lock for life. flock is
# util-linux, on every Ubuntu image; without it the step runs unlocked, as it
# always did.
take_lock() {
  if ! command -v flock > /dev/null 2>&1; then
    log "flock missing — $1 runs unlocked"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  exec 9> "$STATE_DIR/$1.lock"
  if [ "$2" = 0 ]; then flock -n 9; else flock -w "$2" 9; fi
}

make_dirs() {
  mkdir -p "$VASTAI_HOME"/{jobs/inbox,jobs/done,jobs/failed,logs,state,renders,control,work/scenes,work/extensions,bin}
}

# sha256 over the listed files' relative paths and contents, in a fixed order,
# so one tree hashes the same on every node whatever order SFTP wrote it in.
# $1 names the lister. Never fails: agent-status must always answer.
content_hash() {
  (
    cd "$VASTAI_HOME" 2> /dev/null || exit 0
    { "$1" || true; } | LC_ALL=C sort | while IFS= read -r f; do
      sha256sum "$f" 2> /dev/null || true
    done
  ) | sha256sum | cut -d' ' -f1
}

# What the app ships: uploadTree copies its remote/ tree here. blender/ is
# read one level deep and .py only, because install-blender unpacks whole
# Blender builds under it too. __pycache__ is written on the node, not shipped.
list_shipped() {
  find provision.sh agent encode octane -type f ! -name '*.pyc' ! -path '*/__pycache__/*' 2> /dev/null
  find blender -maxdepth 1 -type f -name '*.py' 2> /dev/null
}
# The code the agent process loads. Everything else it runs (blender/,
# encode/) is read afresh by each render, so a change there needs no restart.
list_agent() {
  find agent -type f ! -name '*.pyc' ! -path '*/__pycache__/*' 2> /dev/null
}

deps_current() {
  [ -f "$DEPS_STAMP" ] && [ "$(cat "$DEPS_STAMP")" = "$1" ] \
    && [ -x "$VASTAI_HOME/bin/ffmpeg" ] && command -v tmux > /dev/null 2>&1
}

# Seconds since the agent last beat, or nothing when it never has.
heartbeat_age() {
  local now mt age
  [ -f "$HEARTBEAT" ] || return 0
  now="$(date +%s)"
  mt="$(date -r "$HEARTBEAT" +%s 2> /dev/null)" || return 0
  age=$((now - mt))
  [ "$age" -ge 0 ] || age=0
  echo "$age"
}

agent_session() { tmux has-session -t vr-agent 2> /dev/null; }

# Every Blender the agent starts, OctaneBlender included, runs a script from
# $VASTAI_HOME/blender/: the pattern the restart below kills by.
blender_procs() {
  { pgrep -f "$VASTAI_HOME/blender/" 2> /dev/null || true; } | wc -l | tr -d ' '
}

inbox_specs() {
  local n=0 f
  for f in "$VASTAI_HOME"/jobs/inbox/*.json; do
    [ -e "$f" ] || continue
    case "$f" in *.tmp.json) continue ;; esac
    n=$((n + 1))
  done
  echo "$n"
}

running_agent_hash() {
  local h
  h="$(cat "$AGENT_HASH_FILE" 2> /dev/null || true)"
  case "$h" in *[!0-9a-f]*) h="" ;; esac
  echo "$h"
}

# Why the agent has to be restarted, or nothing when the one running is alive
# and runs the shipped code, and must be left alone with its renders and inbox.
agent_restart_reason() {
  local age running
  if ! agent_session; then echo "no agent session"; return 0; fi
  age="$(heartbeat_age)"
  if [ -z "$age" ]; then echo "no heartbeat"; return 0; fi
  if [ "$age" -gt "$AGENT_STALE_S" ]; then echo "heartbeat stale (${age}s)"; return 0; fi
  running="$(running_agent_hash)"
  if [ -z "$running" ]; then echo "agent code unknown (started before its hash was kept)"; return 0; fi
  if [ "$running" != "$(content_hash list_agent)" ]; then echo "agent code changed"; return 0; fi
}

# Installs, skipped when this exact build has already run them: the stamp is
# the shipped tree's hash, so an app update runs them again. Resuming a node,
# or provisioning it a second time, then costs a hash instead of an apt-get
# update and the ffmpeg check, which are minutes of a billing node rendering
# nothing.
cmd_deps() {
  local want
  log "directories…"
  make_dirs
  want="$(content_hash list_shipped)"
  if [ "${1:-}" != "--force" ] && deps_current "$want"; then
    log "deps already installed for this build (${want:0:12}) — skipping apt and ffmpeg"
    start_ensure_optix
    return 0
  fi
  log "apt packages…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # EGL/X libs so EEVEE (and Blender's GPU module) can run headless; tmux to
  # keep the agent alive across SSH drops. libvulkan1 is the Vulkan LOADER —
  # Blender >= 5.0 defaults to the Vulkan backend and the nvidia container
  # runtime only supplies the driver ICD, not the loader. (Deliberately NOT
  # mesa-vulkan-drivers: a software lavapipe device would be silently picked
  # over the OpenGL fallback and render EEVEE on CPU.)
  apt-get install -y -qq \
    tmux curl xz-utils \
    libegl1 libgl1 libgles2 libglu1-mesa libvulkan1 \
    libxi6 libxrender1 libxkbcommon0 libsm6 libxfixes3 libxxf86vm1 \
    > /dev/null

  # Modern static ffmpeg: the apt build (4.4 on Ubuntu 22.04) cannot decode
  # DWAA-compressed EXRs and may lack zscale — both required by the encode
  # contract. Fall back to apt ffmpeg only if the download fails.
  if [ ! -x "$VASTAI_HOME/bin/ffmpeg" ]; then
    log "downloading static ffmpeg…"
    # Bounded: this blocks provisioning (no agent yet, node billing), and
    # a stalled or trickling server would otherwise hang it forever. Same
    # guards as the other downloads: 20 s connect, abort below 100 kB/s for
    # 60 s, retry any error, a 30 min ceiling per attempt and no new attempt
    # after 30 min. The stall guard catches a dead link; the ceiling is sized
    # so a slow one that is still moving finishes (~130 MB takes ~22 min at the
    # 100 kB/s floor), because the apt fallback below cannot decode DWAA EXRs.
    # Worst case, a failure just short of 30 min and a full retry: ~1 h.
    if curl -fsSL --connect-timeout 20 --speed-limit 100000 --speed-time 60 \
         --max-time 1800 --retry 2 --retry-delay 3 --retry-all-errors --retry-max-time 1800 \
         -o /tmp/ffmpeg.tar.xz \
         "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"; then
      tar -xJf /tmp/ffmpeg.tar.xz -C /tmp
      cp /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg "$VASTAI_HOME/bin/"
      cp /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffprobe "$VASTAI_HOME/bin/"
      rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-master-latest-linux64-gpl
    else
      # curl's exit code tells a ceiling (28) from a stall or an HTTP error, so
      # a node left on the degraded apt build can be traced from this line.
      log "static ffmpeg download failed (curl exit $?) — falling back to apt ffmpeg"
      apt-get install -y -qq ffmpeg > /dev/null
      ln -sf "$(command -v ffmpeg)" "$VASTAI_HOME/bin/ffmpeg"
      ln -sf "$(command -v ffprobe)" "$VASTAI_HOME/bin/ffprobe"
    fi
  fi
  log "ffmpeg: $("$VASTAI_HOME/bin/ffmpeg" -version | head -1)"
  start_ensure_optix
  printf '%s\n' "$want" > "$DEPS_STAMP.tmp" && mv -f "$DEPS_STAMP.tmp" "$DEPS_STAMP"
  log "deps installed"
}

# Background (fully detached): ~300-400 MB download that overlaps the Blender
# install + EEVEE probe. A chunk that starts before it lands renders on CUDA.
# Started by every deps run, the skipped ones too, until the libraries are in:
# otherwise a first try that failed on a download blip would leave the node on
# CUDA, ~1.5x slower, for its whole paid life. A try already under way is
# left to finish (cmd_ensure_optix's lock), and its log is appended to, not
# cut from under it.
start_ensure_optix() {
  if [ -e "$OPTIX_LIBDIR/libnvoptix.so.1" ]; then
    log "optix: already present"
    return 0
  fi
  setsid nohup bash "$VASTAI_HOME/provision.sh" ensure-optix \
    >> "$VASTAI_HOME/logs/ensure_optix.log" 2>&1 < /dev/null 9>&- &
  log "ensure-optix started in background (logs/ensure_optix.log)"
}

# Restarting the agent kills every render on the node and empties its inbox,
# so without --force it happens only when the agent is dead (no tmux session,
# or no heartbeat for AGENT_STALE_S) or runs other code than the app shipped.
# A live, current agent is left alone. The last line says which happened
# (AGENT_KEPT, or AGENT_RESTARTED <reason>), because the caller has to forget
# its runs on this node exactly when they were killed: a check it made
# beforehand with agent-status can go stale in between.
cmd_restart_agent() {
  local reason waited=0
  make_dirs
  if [ "${1:-}" = "--force" ]; then
    reason="forced"
  else
    reason="$(agent_restart_reason)"
    if [ -z "$reason" ]; then
      log "agent alive and current — left running with its $(blender_procs) Blender process(es) and $(inbox_specs) inbox spec(s)"
      echo "AGENT_KEPT"
      return 0
    fi
  fi
  log "starting agent ($reason)…"
  tmux kill-session -t vr-agent 2>/dev/null || true
  # Kill stray render processes from a previous agent (SIGHUP from the tmux
  # kill does not reliably reach detached blender children) — a zombie
  # blender writing into a chunk dir alongside the fresh agent's own render
  # corrupts progress accounting. Nothing resumes the renders killed here.
  # Their frames and manifest stay on disk, but the app re-dispatches each
  # unfinished chunk with its full frame range (to whichever node it picks),
  # and the agent renders that whole -s/-e range again. On the same node that
  # overwrites the frames already there, while their manifest lines keep the
  # old size and sha256. (A .blend saved with Output > Overwrite off skips
  # frames already on disk instead; the agent leaves that setting as saved.)
  # So a restart mid-render pays again for the frames its in-flight chunks
  # had already finished.
  pkill -f "$VASTAI_HOME/blender/" 2>/dev/null || true
  # Clear the job inbox: after an app restart every non-complete chunk is
  # re-dispatched with a fresh spec to whichever node the scheduler picks —
  # stale specs left here render chunks now assigned to OTHER nodes,
  # producing frames the app never collects (observed: 44 specs queued on a
  # 12-slot node, slots burned on invisible duplicate work).
  rm -f "$VASTAI_HOME"/jobs/inbox/*.json
  # The old agent's last beat must not vouch for the new one.
  rm -f "$HEARTBEAT"
  content_hash list_agent > "$AGENT_HASH_FILE.tmp" && mv -f "$AGENT_HASH_FILE.tmp" "$AGENT_HASH_FILE"
  tmux new-session -d -s vr-agent "python3 '$VASTAI_HOME/agent/noderunner.py' >> '$VASTAI_HOME/logs/agent.log' 2>&1"
  # An agent that cannot start must fail provisioning here. Otherwise the node
  # goes 'ready', bills, and every chunk sent to it waits on a state file
  # nothing will ever write.
  while [ ! -f "$HEARTBEAT" ]; do
    if ! agent_session; then
      log "agent exited at startup; logs/agent.log ends:"
      tail -5 "$VASTAI_HOME/logs/agent.log" 2>/dev/null || true
      exit 1
    fi
    if [ "$waited" -ge $((AGENT_START_WAIT_S * 2)) ]; then
      log "agent wrote no heartbeat within ${AGENT_START_WAIT_S}s of starting"
      exit 1
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  echo "AGENT_RESTARTED $reason"
}

# One JSON line on stdout and nothing else, so the app can decide before it
# provisions: whether a restart would happen (restartNeeded, the same test
# restart-agent makes) and what it would kill. agentHash is the code the
# running agent loaded ("" when unknown), shippedAgentHash the code on disk;
# heartbeatAgeS is null when the agent never beat.
cmd_agent_status() {
  local running shipped age age_json stale session reason restart deps
  running="$(running_agent_hash)"
  shipped="$(content_hash list_agent)"
  age="$(heartbeat_age)"
  if [ -n "$age" ]; then age_json="$age"; else age_json="null"; fi
  if [ -z "$age" ] || [ "$age" -gt "$AGENT_STALE_S" ]; then stale=true; else stale=false; fi
  if agent_session; then session=true; else session=false; fi
  reason="$(agent_restart_reason)"
  if [ -n "$reason" ]; then restart=true; else restart=false; fi
  if deps_current "$(content_hash list_shipped)"; then deps=true; else deps=false; fi
  printf '{"agentHash":"%s","shippedAgentHash":"%s","agentCurrent":%s,"agentSession":%s,"heartbeatAgeS":%s,"heartbeatStale":%s,"blenderProcs":%s,"inboxSpecs":%s,"depsCurrent":%s,"restartNeeded":%s,"restartReason":"%s"}\n' \
    "$running" "$shipped" "$([ "$running" = "$shipped" ] && echo true || echo false)" \
    "$session" "$age_json" "$stale" "$(blender_procs)" "$(inbox_specs)" "$deps" "$restart" "$reason"
}

cmd_install_blender() {
  local version="$1"
  local dest="$BLENDER_ROOT/$version"
  if [ -x "$dest/blender" ]; then
    log "blender $version already installed"
    "$dest/blender" --version | head -1
    return 0
  fi
  local major_minor
  major_minor="$(echo "$version" | cut -d. -f1-2)"
  local file="blender-${version}-linux-x64.tar.xz"
  local rel="release/Blender${major_minor}/$file"
  # download.blender.org answers some hosts with 4xx (seen: "exit 22" on a Vast
  # node), and curl --retry doesn't retry those, so fall back through mirrors.
  local urls=(
    "https://download.blender.org/$rel"
    "https://mirrors.ocf.berkeley.edu/blender/$rel"
    "https://ftp.halifax.rwth-aachen.de/blender/$rel"
    "https://mirror.clarkson.edu/blender/$rel"
  )
  mkdir -p "$BLENDER_ROOT"
  local tmp="$BLENDER_ROOT/.dl-$version.tar.xz"
  local ok=0 url attempt
  for attempt in 1 2; do
    for url in "${urls[@]}"; do
      log "downloading $url (attempt $attempt)"
      rm -f "$tmp"
      # stall guard: abort if <100 kB/s for 60 s; retry transient failures on the same URL.
      # Ceiling: 30 min per attempt and no new attempt after 30 min, as for the
      # other downloads. This runs at dispatch inside the app's per-node prep
      # lock, so a mirror trickling just above the stall guard (~67 min for
      # ~400 MB) would hold up every dispatch to this billing node. A mirror
      # that cannot deliver in 30 min (~220 kB/s) is dropped for the next one.
      if curl -fsSL --connect-timeout 20 --speed-limit 100000 --speed-time 60 \
           --max-time 1800 --retry 2 --retry-delay 3 --retry-all-errors --retry-max-time 1800 \
           -o "$tmp" "$url" \
         && xz -t "$tmp" 2>/dev/null; then
        ok=1; break 2
      fi
      log "download failed or archive corrupt from $url"
    done
    sleep 5
  done
  [ "$ok" = 1 ] || { log "all Blender mirrors failed for $version"; exit 22; }
  log "extracting…"
  local extract_dir="$BLENDER_ROOT/.extract-$version"
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  tar -xJf "$tmp" -C "$extract_dir"
  mv "$extract_dir"/blender-* "$dest"
  rm -rf "$tmp" "$extract_dir"
  # Sanity: must run headless.
  "$dest/blender" -b -noaudio --version | head -1
  log "blender $version installed"
}

cmd_probe_eevee() {
  local version="$1"
  local blender="$BLENDER_ROOT/$version/blender"
  [ -x "$blender" ] || { echo "PROBE_FAIL no blender $version"; exit 1; }
  # Render one frame of the default cube with EEVEE. Success → GPU/EGL OK.
  # The identifier moved between releases: EEVEE Next is BLENDER_EEVEE_NEXT in 4.2-4.5
  # but plain BLENDER_EEVEE from 5.0 on (legacy EEVEE was removed, so the enum is just
  # BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES). Hardcoding either raises TypeError on the
  # other and reports a perfectly GPU-capable node as EEVEE-incapable, so pick whichever
  # identifier this build actually exposes.
  # --python-exit-code: without it a failed engine-switch expr is swallowed and
  # the probe "passes" by rendering with whatever the default engine is.
  local expr="import bpy; ids=[i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]; bpy.context.scene.render.engine=('BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in ids else 'BLENDER_EEVEE')"
  if "$blender" -b -noaudio --factory-startup --python-exit-code 32 \
      --python-expr "$expr" \
      -o /tmp/eevee_probe_#### -f 1 > /tmp/eevee_probe.log 2>&1; then
    echo "PROBE_OK"
  # Blender >= 5.0 defaults to the Vulkan backend, which may be unavailable in
  # the container while EGL/OpenGL works — mirror the render-time fallback.
  elif "$blender" -b -noaudio --factory-startup --python-exit-code 32 --gpu-backend opengl \
      --python-expr "$expr" \
      -o /tmp/eevee_probe_#### -f 1 > /tmp/eevee_probe_gl.log 2>&1; then
    echo "PROBE_OK (opengl fallback)"
  else
    tail -5 /tmp/eevee_probe.log
    tail -5 /tmp/eevee_probe_gl.log 2>/dev/null
    echo "PROBE_FAIL"
  fi
}

# Some hosts' container runtime mounts libcuda but NOT the OptiX libraries
# (libnvoptix / libnvidia-rtcore), so Cycles logs "OptiX initialization failed
# with error code 7804" and enable_gpu.py falls back to CUDA — measured ~1.5x
# slower sampling on an RTX 4090 (2026-09-24). Fetch the driver package that
# matches the host kernel module and install just those libraries. Best
# effort: any failure leaves the node on CUDA, exactly as before.
cmd_ensure_optix() {
  local libdir="$OPTIX_LIBDIR"
  if [ -e "$libdir/libnvoptix.so.1" ]; then
    log "optix: already present"
    return 0
  fi
  # One at a time: a second try would rm -rf the first's download from under
  # it, and both would fail.
  if ! take_lock ensure-optix 0; then
    log "optix: another ensure-optix is already fetching — left to it"
    return 0
  fi
  local ver
  # nvidia-smi first; /proc fallback covers both "Kernel Module  550.142" and
  # "Open Kernel Module for x86_64  580.159.03".
  ver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || true)"
  if ! [[ "$ver" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
    ver="$(grep -oE '[0-9]{3}\.[0-9]+(\.[0-9]+)?' /proc/driver/nvidia/version 2>/dev/null | head -1 || true)"
  fi
  [ -n "$ver" ] || { log "optix: driver version unknown — staying on CUDA"; return 0; }
  local tmp=/tmp/optix-$ver
  rm -rf "$tmp"; mkdir -p "$tmp"
  log "optix: fetching driver $ver libraries"
  # Bounded with the same guards as the other downloads (20 s connect, abort
  # below 100 kB/s for 60 s, retry any error, 30 min per attempt and no new
  # attempt after 30 min; 300-400 MB needs only ~220 kB/s to fit). This runs in
  # the background and blocks nothing; the ceiling exists so a trickling
  # server can't leave this process hanging for the node's life.
  if ! curl -fsSL --connect-timeout 20 --speed-limit 100000 --speed-time 60 \
       --max-time 1800 --retry 2 --retry-delay 3 --retry-all-errors --retry-max-time 1800 \
       -o "$tmp/drv.run" \
       "https://us.download.nvidia.com/XFree86/Linux-x86_64/$ver/NVIDIA-Linux-x86_64-$ver.run"; then
    log "optix: driver $ver download failed — staying on CUDA"; rm -rf "$tmp"; return 0
  fi
  if ! sh "$tmp/drv.run" --extract-only --target "$tmp/x" > /dev/null 2>&1; then
    log "optix: extract failed — staying on CUDA"; rm -rf "$tmp"; return 0
  fi
  [ -f "$tmp/x/libnvoptix.so.$ver" ] || { log "optix: no libnvoptix in package"; rm -rf "$tmp"; return 0; }

  # VERIFY BEFORE ACTIVATING. Libraries that load are not libraries that work:
  # on an open-kernel-module 580.159.03 host they loaded, then every Cycles
  # render died with OPTIX_ERROR_INTERNAL_COMPILER_ERROR (exit 1) — worse than
  # CUDA. So stage them in a private dir, prove a real OptiX render passes via
  # LD_LIBRARY_PATH, and only then expose them system-wide.
  local stage="$tmp/stage" f
  mkdir -p "$stage"
  for f in libnvidia-rtcore.so.$ver libnvoptix.so.$ver; do
    [ -f "$tmp/x/$f" ] && cp "$tmp/x/$f" "$stage/"
  done
  ln -sf "libnvoptix.so.$ver" "$stage/libnvoptix.so.1"
  local blender="" i
  for i in $(seq 1 60); do  # Blender is installed in parallel; wait up to 10 min
    blender="$(ls -d "$BLENDER_ROOT"/*/blender 2>/dev/null | head -1 || true)"
    [ -n "$blender" ] && [ -x "$blender" ] && break
    sleep 10
  done
  [ -x "$blender" ] || { log "optix: no blender to verify with — staying on CUDA"; rm -rf "$tmp"; return 0; }
  local expr="import bpy
p=bpy.context.preferences.addons['cycles'].preferences
p.compute_device_type='OPTIX'; p.refresh_devices()
d=[x for x in p.devices if x.type=='OPTIX']
assert d, 'no OptiX device'
for x in p.devices: x.use = x.type=='OPTIX'
s=bpy.context.scene; s.render.engine='CYCLES'; s.cycles.device='GPU'; s.cycles.samples=1
s.render.resolution_x=s.render.resolution_y=32; s.render.filepath='$tmp/verify.png'
bpy.ops.render.render(write_still=True)"
  if LD_LIBRARY_PATH="$stage" "$blender" -b --factory-startup -noaudio --python-exit-code 1 \
       --python-expr "$expr" > "$tmp/verify.log" 2>&1 \
     && ! grep -qE "Failed to load OptiX|OPTIX_ERROR|OptiX initialization failed" "$tmp/verify.log" \
     && [ -s "$tmp/verify.png" ]; then
    log "optix: verified with $blender"
  else
    log "optix: verification FAILED — staying on CUDA:"
    grep -E "OptiX|OPTIX|Error|assert" "$tmp/verify.log" | head -5 || true
    rm -rf "$tmp"; return 0
  fi

  # Activate. Stage-then-rename so a render starting mid-install never
  # dlopens a half-written library.
  for f in libnvidia-rtcore.so.$ver libnvoptix.so.$ver; do
    [ -f "$stage/$f" ] || continue
    [ -e "$libdir/$f" ] && continue
    cp "$stage/$f" "$libdir/.$f.tmp" && mv -f "$libdir/.$f.tmp" "$libdir/$f"
  done
  # (nvoptix.bin deliberately not installed: activate exactly what was verified.)
  if [ "${OPTIX_VERIFY_ONLY:-0}" = 1 ]; then
    log "optix: verify-only mode — not activating"; rm -rf "$tmp"; return 0
  fi
  ln -sf "libnvoptix.so.$ver" "$libdir/.libnvoptix.so.1.tmp" && mv -f "$libdir/.libnvoptix.so.1.tmp" "$libdir/libnvoptix.so.1"
  ldconfig || true
  rm -rf "$tmp"
  log "optix: installed driver $ver OptiX libraries"
}

usage() {
  echo "usage: provision.sh deps [--force]|restart-agent [--force]|agent-status|base|install-blender <ver>|probe-eevee <ver>|ensure-optix"
  exit 1
}

case "${1:-}" in
  deps | restart-agent)
    case "${2:-}" in '' | --force) ;; *) usage ;; esac
    if [ "$1" = deps ]; then cmd_deps "${2:-}"; else cmd_restart_agent "${2:-}"; fi
    ;;
  agent-status) cmd_agent_status ;;
  # What every app build before the split runs, and it must keep meaning what
  # it did: those builds reset every in-flight chunk to pending at launch and
  # dispatch it anew, to any node. A render left running under them would be
  # duplicate work the app cannot see, packed on top of the slots it plans.
  # So base still always restarts; only its installs are skipped when current.
  base)
    cmd_deps
    cmd_restart_agent --force
    log "base provisioning complete"
    ;;
  ensure-optix) cmd_ensure_optix ;;
  install-blender) cmd_install_blender "$2" ;;
  probe-eevee) cmd_probe_eevee "$2" ;;
  *) usage ;;
esac
