"""Configure Cycles for GPU rendering (OptiX preferred, CUDA fallback).

Engines other than Cycles are left untouched: EEVEE uses the GPU implicitly,
Octane is handled by the OctaneBlender build itself.

WHY THIS IS DEFENSIVE
This runs under `--python-exit-code 32`, which makes any exception FATAL — the
chunk fails, retries four times, fails again, and the render never happens. But
the Blender version is whatever the .blend asks for, and Cycles' settings
properties keep moving between releases:

  * `use_auto_tile_size` (pre-Cycles-X) → `use_auto_tile` (Cycles-X)
  * `cycles.use_persistent_data` → `render.use_persistent_data`
  * `get_devices()` is deprecated in favour of `refresh_devices()`

Both of the first two were observed failing every Cycles render on Blender
5.1.2. So: probe for each property, never assume, and treat tuning as
best-effort. Getting the GPU enabled is what matters; a tiling hint is not
worth failing a paid render over.
"""

import bpy


def try_set(owner, name, value, label=None):
    """Set an optional property, reporting what happened. Never raises."""
    if owner is None or not hasattr(owner, name):
        return False
    try:
        setattr(owner, name, value)
        print(f"set {label or name} = {value}")
        return True
    except Exception as e:  # noqa: BLE001 — tuning must never fail a render
        print(f"could not set {label or name}: {e}")
        return False


scene = bpy.context.scene
cycles = getattr(scene, "cycles", None)

if scene.render.engine == "CYCLES" and cycles is not None:
    cycles.device = "GPU"

    cprefs = bpy.context.preferences.addons["cycles"].preferences
    # get_devices() is deprecated in newer Blenders; refresh_devices() replaced
    # it. Call whichever exists — skipping the refresh entirely would leave the
    # device list empty and silently render on the CPU.
    for refresh in ("refresh_devices", "get_devices"):
        fn = getattr(cprefs, refresh, None)
        if callable(fn):
            try:
                fn()
                break
            except Exception as e:  # noqa: BLE001
                print(f"{refresh}() failed: {e}")

    types = [d.type for d in cprefs.devices]
    if "OPTIX" in types:
        cprefs.compute_device_type = "OPTIX"
        print("Using OptiX for rendering")
    elif "CUDA" in types:
        cprefs.compute_device_type = "CUDA"
        print("Using CUDA for rendering")
    else:
        print(f"WARNING no OptiX/CUDA device found (types: {sorted(set(types))})")

    enabled = 0
    for device in cprefs.devices:
        # CPU devices are listed too; enabling them alongside the GPU splits the
        # scene and is usually slower than the GPU alone.
        if device.type == "CPU":
            device.use = False
            continue
        device.use = True
        enabled += 1
        print(f"Enabled GPU: {device.name} ({device.type})")
    if enabled == 0:
        print("WARNING no GPU devices enabled — Cycles will fall back to CPU")

    if bpy.app.version < (3, 0, 0):  # pre Cycles-X
        try_set(cycles, "tile_size", 512)
        try_set(cycles, "use_auto_tile_size", False)
    elif not try_set(cycles, "use_auto_tile", True):
        try_set(cycles, "use_auto_tile_size", True)

    # Moved from cycles to render settings; try both, in that order.
    if not try_set(cycles, "use_persistent_data", True, "cycles.use_persistent_data"):
        try_set(scene.render, "use_persistent_data", True, "render.use_persistent_data")
else:
    print(f"Render engine is {scene.render.engine}, not Cycles. Skipping GPU setup.")

print("Rendering setup completed.")
