#!/bin/bash
# Octane node setup — installs a minimal X11/VNC desktop and launches
# OctaneServer inside it. Adapted from the legacy pipeline, hardened:
#   - VNC password is GENERATED per node by the app, never hardcoded
#   - VNC binds to localhost only; the app reaches it through an SSH tunnel
#   - The default sign-in is by hand, over that tunnel. A scripted sign-in is
#     the user's opt-in: the OTOY credentials arrive on this script's stdin and
#     go on to OctaneServer's stdin, never into argv, the environment or a
#     file. That keeps them out of `ps`, /proc/<pid>/environ and error text,
#     but not from root on the host, who can read the server's memory. Any
#     credential used on a rented node is disclosed to its owner.
#   - Safe to repeat: a second setup never kills or duplicates a running VNC
#     or OctaneServer. Only stop-server stops the server.
#
# Usage:
#   setup_octane.sh install                          # apt deps; skipped when installed
#   setup_octane.sh start-vnc <password>             # set the VNC password, then start VNC on
#   setup_octane.sh start-vnc --password-stdin       #   :0 (localhost-only) unless it runs
#   setup_octane.sh start-server                     # launch OctaneServer in DISPLAY=:0 unless
#                                                    #   it runs; sign in by hand over VNC
#   setup_octane.sh start-server --credentials-stdin # the same, with "<user>\n<password>\n"
#                                                    #   read from stdin for the server
#   setup_octane.sh status                           # OCTANE_STATE none|serverRunning|
#                                                    #   licensed|needsLogin
#   setup_octane.sh stop-server                      # SIGTERM, 30 s, then SIGKILL; prints
#                                                    #   OCTANE_STOPPED none|clean|killed
#                                                    #   (a clean exit releases the floating license)
set -euo pipefail

VASTAI_HOME="${VASTAI_HOME:-$HOME/vastai}"
VNC_DIR="$HOME/.vnc"
PIDFILE="$VASTAI_HOME/state/octane-server.pid"
SERVER_LOG="$VASTAI_HOME/logs/octane-server.log"
# Where X servers keep .X0-lock and the .X11-unix socket. (Tests point it at a
# temp dir.)
X_TMPDIR="${X_TMPDIR:-/tmp}"

# Credentials go on stdin only. An app build from before this rule sends them
# as env assignments on the command; drop them so no child inherits them.
unset OCTANE_USER OCTANE_PASS

# What OctaneServer logs about its license, for `status`. A failure pattern is
# always tested first: "Failed to acquire license" or "not activated" also
# contain the words a success line does, and the old check read them as a
# license (octaneLicense.ts). Only the LAST line that matches either is read,
# so a sign-in by hand after a failed scripted one does count. These phrases
# have NOT yet been checked against a real OctaneServer log: add the exact
# lines when plan 1.18's run with an OTOY account shows them. Until then a
# server that logs neither reads as serverRunning, never as licensed.
LOGIN_FAILED_RE='not (activated|licensed|logged in|signed in)|(activation|login|log in|sign-in|sign in|authentication|license check|license request) (has )?(failed|error|denied|refused|unsuccessful)|(failed|unable|could not|couldn.t|cannot|can.t) (to )?(activate|log ?in|sign ?in|authenticate|acquire|obtain|check ?out)|invalid (user ?name|password|credentials|login|e-?mail)|licen[cs]es? (is |are )?(already )?in use|no (free |available |valid )?licen[cs]es?|licen[cs]e (has )?expired|deactivated|logged out|signed out'
LICENSED_RE='(activation|login|log in|sign-in|sign in|authentication) (was )?(succeeded|successful|complete)|successfully (activated|logged in|signed in|authenticated)|licen[cs]e (acquired|activated|checked out|granted|obtained)|(acquired|obtained|checked out) (a |the )?licen[cs]e|(logged|signed) in as|activated successfully|(is|has been) activated'

OCTANE_PKGS=(
  tightvncserver openbox xterm dbus-x11 x11-xserver-utils
  libglu1-mesa libgtk2.0-0 libgtk-3-0
  libxrandr2 libxss1 libxcursor1 libxcomposite1 libasound2
  libxi6 libxtst6
  xfonts-base xfonts-100dpi xfonts-75dpi
)

log() { echo "[octane] $*"; }

# A process's start time, which with its pid names it: a pid alone is only a
# number the kernel hands out again once its process is gone.
proc_start() { ps -p "$1" -o lstart= 2> /dev/null | awk '{$1=$1; print}'; }
proc_args() { ps -p "$1" -o args= 2> /dev/null || true; }

record_server_pid() {
  printf '%s\n%s\n' "$1" "$(proc_start "$1")" > "$PIDFILE.tmp" && mv -f "$PIDFILE.tmp" "$PIDFILE"
}

# The pid in the pidfile while that process is still the OctaneServer this
# script launched, else nothing. After the server dies its pid can go to a
# Blender render or the agent, and stop-server must never signal those.
server_pid() {
  local pid="" started=""
  [ -f "$PIDFILE" ] || return 0
  { IFS= read -r pid || true; IFS= read -r started || true; } < "$PIDFILE"
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2> /dev/null || return 0
  if [ -n "$started" ]; then
    [ "$(proc_start "$pid")" = "$started" ] || return 0
  else
    # A pidfile written before start times were kept: go by the name.
    case "$(proc_args "$pid")" in *OctaneServer*) ;; *) return 0 ;; esac
  fi
  echo "$pid"
}

# OctaneServer processes, whether or not the pidfile knows them: earlier
# builds launched a second server on every setup and kept only the newest pid.
all_server_pids() { pgrep -x OctaneServer 2> /dev/null || true; }

# The live process whose pid file $1 holds, if its command line looks like an
# X or VNC server. X servers write .X0-lock as a space-padded pid.
live_display_pid_in() {
  local pid=""
  [ -f "$1" ] || return 0
  IFS= read -r pid < "$1" || true
  pid="${pid//[[:space:]]/}"
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2> /dev/null || return 0
  case "$(proc_args "$pid")" in *vnc* | *Xorg* | *Xvfb* | *Xwayland*) echo "$pid" ;; esac
}

# pid of the X server on :0: TightVNC's own pid file ($HOME/.vnc/<host>:0.pid),
# else the X lock, so a VNC started some other way is never started over.
display_pid() {
  local f pid
  for f in "$VNC_DIR"/*:0.pid; do
    pid="$(live_display_pid_in "$f")"
    if [ -n "$pid" ]; then echo "$pid"; return 0; fi
  done
  live_display_pid_in "$X_TMPDIR/.X0-lock"
}

cmd_install() {
  local installed
  # shellcheck disable=SC2016 # ${Status} is dpkg-query's field, not a shell variable
  installed="$(dpkg-query -W -f='${Status}\n' "${OCTANE_PKGS[@]}" 2> /dev/null | grep -c 'install ok installed' || true)"
  if [ "$installed" = "${#OCTANE_PKGS[@]}" ]; then
    log "X11/VNC packages already installed"
    return 0
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${OCTANE_PKGS[@]}" > /dev/null
  log "X11/VNC packages installed"
}

cmd_start_vnc() {
  local password="" pid lock_pid
  if [ "${1:-}" = "--password-stdin" ]; then
    IFS= read -r -t 15 password || true
  else
    password="${1:-}"
  fi
  [ -n "$password" ] || { echo "missing vnc password"; exit 1; }
  mkdir -p "$VNC_DIR"
  # Written even while VNC runs: Xvnc reads this file at each authentication,
  # so the password the app now holds works for the next login, and a session
  # already open (the user mid sign-in) is untouched.
  (umask 077 && printf '%s\n' "$password" | vncpasswd -f > "$VNC_DIR/passwd.tmp")
  mv -f "$VNC_DIR/passwd.tmp" "$VNC_DIR/passwd"
  cat > "$VNC_DIR/xstartup" <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
openbox-session &
xterm &
EOF
  chmod +x "$VNC_DIR/xstartup"
  pid="$(display_pid)"
  if [ -n "$pid" ]; then
    # Never killed here: it may be the session the user is signing in on.
    log "VNC already running on :0 (pid $pid) — left as is"
    return 0
  fi
  # What a crashed server left would only make vncserver refuse :0 ("A VNC
  # server is already running as :0"). A lock whose process still lives is
  # somebody's, whatever its name, and stays: vncserver then fails, loudly.
  rm -f "$VNC_DIR"/*:0.pid
  lock_pid=""
  if [ -f "$X_TMPDIR/.X0-lock" ]; then
    IFS= read -r lock_pid < "$X_TMPDIR/.X0-lock" || true
    lock_pid="${lock_pid//[[:space:]]/}"
  fi
  case "$lock_pid" in
    '' | *[!0-9]*) rm -f "$X_TMPDIR/.X0-lock" "$X_TMPDIR/.X11-unix/X0" ;;
    *) kill -0 "$lock_pid" 2> /dev/null || rm -f "$X_TMPDIR/.X0-lock" "$X_TMPDIR/.X11-unix/X0" ;;
  esac
  # -localhost: only reachable via the SSH tunnel the app opens.
  vncserver :0 -localhost -geometry 1280x800 -depth 24 \
    -fp /usr/share/fonts/X11/misc/,/usr/share/fonts/X11/100dpi/,/usr/share/fonts/X11/75dpi/
  log "VNC on :0 (localhost:5900, tunnel required)"
}

cmd_start_server() {
  local user="" pass="" pid p
  if [ "${1:-}" = "--credentials-stdin" ]; then
    # IFS= and -r keep every character: spaces at either end and backslashes
    # are part of a password. Bounded, in case the caller never sends EOF.
    IFS= read -r -t 15 user || true
    IFS= read -r -t 15 pass || true
  fi
  mkdir -p "$VASTAI_HOME/logs" "$VASTAI_HOME/state"
  pid="$(server_pid)"
  if [ -z "$pid" ]; then
    for p in $(all_server_pids); do
      pid="$p"
      record_server_pid "$pid"
      log "adopted an OctaneServer the pidfile had lost (pid $pid)"
      break
    done
  fi
  if [ -n "$pid" ]; then
    # A second server would take a second floating license, and its launch
    # truncates the log the license check reads.
    user="" pass=""
    log "OctaneServer already running (pid $pid) — left as is"
    cmd_status
    return 0
  fi
  if [ -z "$(display_pid)" ]; then
    user="" pass=""
    log "no X display on :0 for OctaneServer — run start-vnc first"
    echo "OCTANE_STATE none"
    exit 1
  fi
  export DISPLAY=:0
  if [ -n "$user" ] && [ -n "$pass" ]; then
    # OctaneServer's stdin is the one way in left that is not argv, the
    # environment or disk (printf is a builtin: no process carries them as
    # arguments). Whether a build reads a sign-in there is unverified: one
    # that does not just reports needsLogin, and the VNC sign-in remains.
    log "launching OctaneServer, sign-in on its stdin"
    printf '%s\n%s\n' "$user" "$pass" | nohup OctaneServer > "$SERVER_LOG" 2>&1 &
  else
    log "launching OctaneServer — sign in by hand over VNC"
    nohup OctaneServer < /dev/null > "$SERVER_LOG" 2>&1 &
  fi
  pid=$!
  user="" pass=""
  record_server_pid "$pid"
  log "OctaneServer launched (pid $pid)"
  echo "OCTANE_STATE serverRunning"
}

# One line, OCTANE_STATE <state>. The app writes <state> verbatim to
# nodes.octane_state, so it is spelled exactly as OctaneState
# (src/shared/models.ts) spells it:
#   none           no OctaneServer running
#   serverRunning  running, and its log says nothing yet about a license
#   licensed       the last license line in its log is a success
#   needsLogin     the last license line is a failure: sign in over VNC
cmd_status() {
  local pid last p
  pid="$(server_pid)"
  if [ -z "$pid" ]; then
    for p in $(all_server_pids); do pid="$p"; break; done
  fi
  if [ -z "$pid" ]; then
    echo "OCTANE_STATE none"
    return 0
  fi
  last="$(grep -aiE "($LOGIN_FAILED_RE)|($LICENSED_RE)" "$SERVER_LOG" 2> /dev/null | tail -1 || true)"
  if [ -z "$last" ]; then
    echo "OCTANE_STATE serverRunning"
  elif printf '%s\n' "$last" | grep -qiE "$LOGIN_FAILED_RE"; then
    echo "OCTANE_STATE needsLogin"
  else
    echo "OCTANE_STATE licensed"
  fi
}

# Bounded at ~31 s so it fits the app's 45 s exec timeout, and ends every
# OctaneServer, not only the pidfile's, since a license is held per server.
cmd_stop_server() {
  local pids="" pid p left
  pid="$(server_pid)"
  [ -z "$pid" ] || pids="$pid"
  for p in $(all_server_pids); do
    case " $pids " in *" $p "*) ;; *) pids="$pids $p" ;; esac
  done
  if [ -z "$pids" ]; then
    rm -f "$PIDFILE"
    log "no OctaneServer running"
    echo "OCTANE_STOPPED none"
    return 0
  fi
  # shellcheck disable=SC2086 # word-split on purpose: one pid per word
  kill -TERM $pids 2> /dev/null || true
  # Clean exit releases the floating license slot — wait up to 30s.
  for _ in $(seq 30); do
    left=""
    for p in $pids; do
      if kill -0 "$p" 2> /dev/null; then left="$left $p"; fi
    done
    if [ -z "$left" ]; then
      rm -f "$PIDFILE"
      log "OctaneServer exited cleanly"
      echo "OCTANE_STOPPED clean"
      return 0
    fi
    sleep 1
  done
  log "OctaneServer did not exit in 30s — killing (its license may stay in use: docs/OCTANE.md)"
  # shellcheck disable=SC2086
  kill -KILL $left 2> /dev/null || true
  rm -f "$PIDFILE"
  echo "OCTANE_STOPPED killed"
}

usage() {
  echo "usage: setup_octane.sh install|start-vnc <password>|start-vnc --password-stdin|start-server [--credentials-stdin]|status|stop-server"
  exit 1
}

case "${1:-}" in
  install) cmd_install ;;
  start-vnc) cmd_start_vnc "${2:-}" ;;
  start-server)
    case "${2:-}" in '' | --credentials-stdin) ;; *) usage ;; esac
    cmd_start_server "${2:-}"
    ;;
  status) cmd_status ;;
  stop-server) cmd_stop_server ;;
  *) usage ;;
esac
