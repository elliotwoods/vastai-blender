#!/bin/bash
# Node provisioning — run ON the rented instance (root). Idempotent; safe to
# re-run after app updates. Shipped verbatim over SFTP to ~/vastai/ by the app.
#
# Usage:
#   provision.sh base                      # apt deps + dirs + agent under tmux
#   provision.sh install-blender <version> # e.g. 4.5.3 → ~/vastai/blender/4.5.3/
#   provision.sh probe-eevee <version>     # 1-frame EEVEE render capability probe
#   provision.sh ensure-optix              # add OptiX libs when the container lacks them
set -euo pipefail

VASTAI_HOME="${VASTAI_HOME:-$HOME/vastai}"
BLENDER_ROOT="$VASTAI_HOME/blender"

log() { echo "[provision] $*"; }

cmd_base() {
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

  log "directories…"
  mkdir -p "$VASTAI_HOME"/{jobs/inbox,jobs/done,jobs/failed,logs,state,renders,control,work/scenes,work/extensions,bin}

  # Modern static ffmpeg: the apt build (4.4 on Ubuntu 22.04) cannot decode
  # DWAA-compressed EXRs and may lack zscale — both required by the encode
  # contract. Fall back to apt ffmpeg only if the download fails.
  if [ ! -x "$VASTAI_HOME/bin/ffmpeg" ]; then
    log "downloading static ffmpeg…"
    # Bounded: this blocks base provisioning (no agent yet, node billing), and
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
  # Background (fully detached): ~300-400 MB download that overlaps the Blender
  # install + EEVEE probe. A chunk that starts before it lands renders on CUDA.
  setsid nohup bash "$VASTAI_HOME/provision.sh" ensure-optix \
    > "$VASTAI_HOME/logs/ensure_optix.log" 2>&1 < /dev/null &
  log "ensure-optix started in background (logs/ensure_optix.log)"
  log "starting agent…"
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
  # So a re-provision mid-render pays again for the frames its in-flight
  # chunks had already finished.
  pkill -f "$VASTAI_HOME/blender/" 2>/dev/null || true
  # Clear the job inbox: after an app restart every non-complete chunk is
  # re-dispatched with a fresh spec to whichever node the scheduler picks —
  # stale specs left here render chunks now assigned to OTHER nodes,
  # producing frames the app never collects (observed: 44 specs queued on a
  # 12-slot node, slots burned on invisible duplicate work).
  rm -f "$VASTAI_HOME"/jobs/inbox/*.json
  tmux new-session -d -s vr-agent "python3 '$VASTAI_HOME/agent/noderunner.py' >> '$VASTAI_HOME/logs/agent.log' 2>&1"
  log "base provisioning complete"
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
  local libdir=/usr/lib/x86_64-linux-gnu
  if [ -e "$libdir/libnvoptix.so.1" ]; then
    log "optix: already present"
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

case "${1:-}" in
  base) cmd_base ;;
  ensure-optix) cmd_ensure_optix ;;
  install-blender) cmd_install_blender "$2" ;;
  probe-eevee) cmd_probe_eevee "$2" ;;
  *) echo "usage: provision.sh base|install-blender <ver>|probe-eevee <ver>"; exit 1 ;;
esac
