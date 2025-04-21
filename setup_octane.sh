#!/bin/bash

# Install dependencies for X11
apt update && apt install -y \
  xfce4 xfce4-goodies \
  tightvncserver \
  x11-xserver-utils \
  xterm dbus-x11 \
  libglu1-mesa \
  libgtk2.0-0 libgtk-3-0 \
  libxrandr2 libxss1 libxcursor1 \
  libxcomposite1 libasound2 \
  libxi6 libxtst6 wget


# Set VNC environment path
VNC_DIR="/root/.vnc"
STARTUP_FILE="$VNC_DIR/xstartup"

# Create VNC directory
mkdir -p "$VNC_DIR"

# Write xstartup script
cat > "$STARTUP_FILE" <<EOF
#!/bin/sh
xrdb \$HOME/.Xresources
startxfce4 &
EOF

# Make it executable
chmod +x "$STARTUP_FILE"

echo "✅ VNC environment setup complete."
