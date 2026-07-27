#!/bin/bash
# Node provisioning — run ON the rented instance (root). Idempotent; safe to
# re-run after app updates. Shipped verbatim over SFTP to ~/vastai/ by the app.
#
# Usage:
#   provision.sh base                      # apt deps + dirs + agent under tmux
#   provision.sh install-blender <version> # e.g. 4.5.3 → ~/vastai/blender/4.5.3/
#   provision.sh probe-eevee <version>     # 1-frame EEVEE render capability probe
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
  mkdir -p "$VASTAI_HOME"/{jobs/inbox,jobs/done,jobs/failed,logs,state,renders,work/scenes,work/extensions,bin}

  # Modern static ffmpeg: the apt build (4.4 on Ubuntu 22.04) cannot decode
  # DWAA-compressed EXRs and may lack zscale — both required by the encode
  # contract. Fall back to apt ffmpeg only if the download fails.
  if [ ! -x "$VASTAI_HOME/bin/ffmpeg" ]; then
    log "downloading static ffmpeg…"
    if curl -fsSL --retry 3 -o /tmp/ffmpeg.tar.xz \
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"; then
      tar -xJf /tmp/ffmpeg.tar.xz -C /tmp
      cp /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg "$VASTAI_HOME/bin/"
      cp /tmp/ffmpeg-master-latest-linux64-gpl/bin/ffprobe "$VASTAI_HOME/bin/"
      rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-master-latest-linux64-gpl
    else
      log "static ffmpeg download failed — falling back to apt ffmpeg"
      apt-get install -y -qq ffmpeg > /dev/null
      ln -sf "$(command -v ffmpeg)" "$VASTAI_HOME/bin/ffmpeg"
      ln -sf "$(command -v ffprobe)" "$VASTAI_HOME/bin/ffprobe"
    fi
  fi
  log "ffmpeg: $("$VASTAI_HOME/bin/ffmpeg" -version | head -1)"
  log "starting agent…"
  tmux kill-session -t vr-agent 2>/dev/null || true
  # Kill stray render processes from a previous agent (SIGHUP from the tmux
  # kill does not reliably reach detached blender children) — a zombie
  # blender writing into a chunk dir alongside the fresh agent's own render
  # corrupts progress accounting. Manifested frames survive; the fresh agent
  # re-renders only what is missing from the manifest… of unfinished chunks.
  pkill -f "$VASTAI_HOME/blender/" 2>/dev/null || true
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
  local url="https://download.blender.org/release/Blender${major_minor}/blender-${version}-linux-x64.tar.xz"
  log "downloading $url"
  mkdir -p "$BLENDER_ROOT"
  local tmp="$BLENDER_ROOT/.dl-$version.tar.xz"
  curl -fsSL --retry 3 -o "$tmp" "$url"
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

case "${1:-}" in
  base) cmd_base ;;
  install-blender) cmd_install_blender "$2" ;;
  probe-eevee) cmd_probe_eevee "$2" ;;
  *) echo "usage: provision.sh base|install-blender <ver>|probe-eevee <ver>"; exit 1 ;;
esac
