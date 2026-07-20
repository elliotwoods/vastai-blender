#!/bin/bash
# Octane node setup — installs a minimal X11/VNC desktop and launches
# OctaneServer inside it. Adapted from the legacy pipeline, hardened:
#   - VNC password is GENERATED per node (passed in, never hardcoded)
#   - VNC binds to localhost only; the app reaches it through an SSH tunnel
#   - OTOY credentials arrive via environment (never written to disk here)
#
# Usage:
#   setup_octane.sh install                      # apt deps (idempotent)
#   setup_octane.sh start-vnc <password>         # (re)start VNC on :0, localhost-only
#   setup_octane.sh start-server                 # launch OctaneServer in DISPLAY=:0
#                                                #   env: OCTANE_USER / OCTANE_PASS (optional)
#   setup_octane.sh stop-server                  # SIGTERM OctaneServer, wait for exit
#                                                #   (clean exit releases the floating license)
set -euo pipefail

VASTAI_HOME="${VASTAI_HOME:-$HOME/vastai}"
VNC_DIR="$HOME/.vnc"

log() { echo "[octane] $*"; }

cmd_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    tightvncserver openbox xterm dbus-x11 x11-xserver-utils \
    libglu1-mesa libgtk2.0-0 libgtk-3-0 \
    libxrandr2 libxss1 libxcursor1 libxcomposite1 libasound2 \
    libxi6 libxtst6 \
    xfonts-base xfonts-100dpi xfonts-75dpi > /dev/null
  log "X11/VNC packages installed"
}

cmd_start_vnc() {
  local password="$1"
  [ -n "$password" ] || { echo "missing vnc password"; exit 1; }
  mkdir -p "$VNC_DIR"
  echo "$password" | vncpasswd -f > "$VNC_DIR/passwd"
  chmod 600 "$VNC_DIR/passwd"
  cat > "$VNC_DIR/xstartup" <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
openbox-session &
xterm &
EOF
  chmod +x "$VNC_DIR/xstartup"
  vncserver -kill :0 >/dev/null 2>&1 || true
  # -localhost: only reachable via the SSH tunnel the app opens.
  vncserver :0 -localhost -geometry 1280x800 -depth 24 \
    -fp /usr/share/fonts/X11/misc/,/usr/share/fonts/X11/100dpi/,/usr/share/fonts/X11/75dpi/
  log "VNC on :0 (localhost:5900, tunnel required)"
}

cmd_start_server() {
  export DISPLAY=:0
  mkdir -p "$VASTAI_HOME/logs"
  # Probe for scriptable sign-in flags — Octane builds differ; fall back to
  # plain launch (manual sign-in over VNC) when none are recognised.
  local extra=()
  if [ -n "${OCTANE_USER:-}" ] && [ -n "${OCTANE_PASS:-}" ]; then
    if OctaneServer --help 2>&1 | grep -qiE 'username|login'; then
      extra=(--username "$OCTANE_USER" --password "$OCTANE_PASS")
      log "launching with scripted credentials"
    else
      log "no credential flags detected — manual VNC sign-in may be needed"
    fi
  fi
  nohup OctaneServer "${extra[@]}" > "$VASTAI_HOME/logs/octane-server.log" 2>&1 &
  echo $! > "$VASTAI_HOME/state/octane-server.pid"
  log "OctaneServer launched (pid $(cat "$VASTAI_HOME/state/octane-server.pid"))"
}

cmd_stop_server() {
  local pidfile="$VASTAI_HOME/state/octane-server.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid"
      # Clean exit releases the floating license slot — wait up to 30s.
      for _ in $(seq 30); do
        kill -0 "$pid" 2>/dev/null || { log "OctaneServer exited cleanly"; rm -f "$pidfile"; return 0; }
        sleep 1
      done
      log "OctaneServer did not exit in 30s — killing"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  else
    pkill -TERM OctaneServer 2>/dev/null || true
  fi
}

case "${1:-}" in
  install) cmd_install ;;
  start-vnc) cmd_start_vnc "${2:-}" ;;
  start-server) cmd_start_server ;;
  stop-server) cmd_stop_server ;;
  *) echo "usage: setup_octane.sh install|start-vnc <password>|start-server|stop-server"; exit 1 ;;
esac
