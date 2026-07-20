# Octane rendering

Octane support layers on top of the normal node lifecycle:

1. **OctaneBlender binary** — Otoy's Blender build. Otoy's downloads are
   login-gated, so the app cannot fetch it automatically. Options:
   - Rent instances from a Vast.ai template/image that already contains
     OctaneBlender at `/usr/local/OctaneBlender/blender` (the path the node
     agent probes for Octane jobs), or
   - Install it manually over the VNC session (below) / SSH.
2. **X11 + VNC + OctaneServer** — set up automatically the first time an
   Octane job is dispatched to a node (`remote/octane/setup_octane.sh`):
   a minimal Openbox desktop under TightVNC on display `:0`, bound to
   **localhost only** with a **per-node generated password**.
3. **License sign-in** — best-effort automation: if OTOY credentials are
   saved in Settings → Octane, they are injected into OctaneServer's process
   environment over SSH (never written to node disk) and used with the
   build's credential flags when it has them. The app then watches the
   server log for license acquisition for 60s.

## Manual sign-in fallback

If the license isn't confirmed, the node is flagged and the app shows a
warning. Use the VNC tunnel:

1. Fleet view → expand the node → open VNC tunnel (or `node:openVncTunnel`).
2. Connect any VNC viewer to `localhost:<port>` with the shown password.
3. Sign in inside the OctaneServer window.

## License release

Octane floating licenses are released when OctaneServer exits cleanly. The
app SIGTERMs OctaneServer and waits for exit **before** destroying an
instance (drain ordering). If a machine dies without the chance to do this,
release the slot manually: **Otoy account → licenses → release all**.
