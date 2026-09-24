# Octane rendering

Octane support layers on top of the normal node lifecycle:

1. **OctaneBlender binary** — Otoy's Blender build. Otoy's downloads are
   login-gated, so the app cannot fetch it automatically. Options:
   - Rent instances from a Vast.ai template/image that already contains
     OctaneBlender at `/usr/local/OctaneBlender/blender` (the path the node
     agent probes for Octane jobs), or
   - Install it manually over SSH (Fleet → row → ssh).

   If it is missing, nothing stops the job: the agent falls back to stock
   Blender, which has no Octane.
2. **X11 + VNC + OctaneServer** — set up automatically the first time an
   Octane job is dispatched to a node (`remote/octane/setup_octane.sh`):
   a minimal Openbox desktop under TightVNC on display `:0`, bound to
   **localhost only** with a **per-node generated password**.
3. **License sign-in** — best-effort automation: if OTOY credentials are
   saved in Settings → Octane, they are sent over SSH as part of the command
   that starts OctaneServer, and passed to it as `--username`/`--password` when
   the installed build lists such flags. Nothing writes them to a file on the
   node, but they sit in that command line and, as flags, in the server's
   process arguments, where root on the host can read them. The host is
   someone else's machine, so treat saved OTOY credentials as disclosed to
   every host you rent an Octane node from. The app then watches the server
   log for license acquisition for 60s.

## Manual sign-in fallback

If the license isn't confirmed within those 60 s, the app raises a warning
alert. The node is not marked as needing a login (the node panel's *octane
login needed* chip never shows), and each later Octane chunk sent to it runs
the setup again.

There is no way to reach the VNC session from the app yet. The alert says to
open the VNC tunnel from the fleet view, but there is no such button:
`node:openVncTunnel` is implemented in the main process but nothing in the UI
calls it, and the app keeps the VNC password in memory without showing it.
An *Open VNC login* button in the node panel, with the port and password,
arrives with plan item 1.18 (the Octane rework). Until then, destroy a node
that cannot get a license: it bills whether or not Octane can render on it.

## License release

Octane floating licenses are released when OctaneServer exits cleanly. When
you destroy a node whose license was confirmed, or it is destroyed for being
idle, the app SIGTERMs OctaneServer and waits up to 30 s for it to exit
**before** destroying the instance (drain ordering). The other destroy paths
skip this: Fleet's *clear failed*, the launch sweep, a node that failed or
became unreachable, and any node whose license was never confirmed. Quitting
the app leaves the node running, and its license in use. After any of those,
or if a machine dies first, release the slot manually: **Otoy account →
licenses → release all**. Plan item 1.18 stops the server on every destroy
path.
