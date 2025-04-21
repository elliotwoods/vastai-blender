#!/bin/bash

# Install dependencies for X11 + fonts
apt update && apt install -y \
  xfce4 xfce4-goodies \
  tightvncserver \
  x11-xserver-utils \
  xterm dbus-x11 \
  libglu1-mesa \
  libgtk2.0-0 libgtk-3-0 \
  libxrandr2 libxss1 libxcursor1 \
  libxcomposite1 libasound2 \
  libxi6 libxtst6 wget \
  xfonts-base xfonts-100dpi xfonts-75dpi openbox

# Set VNC environment path
VNC_DIR="/root/.vnc"
STARTUP_FILE="$VNC_DIR/xstartup"

# Create VNC directory
mkdir -p "$VNC_DIR"

# Set a simple VNC password (e.g. "password")
echo "password" | vncpasswd -f > "$VNC_DIR/passwd"
chmod 600 "$VNC_DIR/passwd"

# Write xstartup script for Openbox + xterm
cat > "$STARTUP_FILE" <<EOF
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
xrdb \$HOME/.Xresources
openbox-session &
xterm &
EOF

# Set permissions for xstartup
chmod +x "$STARTUP_FILE"

echo "✅ VNC environment setup complete (TightVNC + Openbox)."

# Kill any existing VNC session on :0 (just in case)
vncserver -kill :0 >/dev/null 2>&1

# Start VNC server on display :0 (port 5900), with correct font path
vncserver :0 -geometry 1280x800 -depth 24 -fp /usr/share/fonts/X11/misc/,/usr/share/fonts/X11/100dpi/,/usr/share/fonts/X11/75dpi/

echo "✅ VNC server running on display :0 (port 5900). Connect using your VNC viewer."

# Wait a bit to ensure the X11 session is fully up
sleep 2

# Set DISPLAY environment variable
export DISPLAY=:0

# Run OctaneServer inside the correct X11 context
OctaneServer &
echo "🚀 OctaneServer launched inside VNC X11 display :0"
