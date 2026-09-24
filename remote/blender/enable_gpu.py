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

import os

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
    backend = None
    if "OPTIX" in types:
        backend = "OPTIX"
    elif "CUDA" in types:
        backend = "CUDA"
    if backend:
        cprefs.compute_device_type = backend
        print(f"Using {backend} for rendering")
    else:
        print(f"WARNING no OptiX/CUDA device found (types: {sorted(set(types))})")

    # Per-GPU slots: the agent pins this process to one card with
    # CUDA_VISIBLE_DEVICES, so normally only that card is listed — once as CUDA
    # and once as OPTIX, which is why devices are counted per backend below
    # rather than all together. VR_GPU_BUS names the intended card as a
    # backstop in case the variable did not take effect: if several cards of
    # the chosen backend are still listed, only the one whose id carries that
    # PCI bus:device is enabled.
    pinned = os.environ.get("VR_GPU_INDEX")
    bus = os.environ.get("VR_GPU_BUS", "")
    # nvidia-smi: "00000000:41:00.0"; Cycles device ids carry e.g. "..._0000:41:00".
    bus_key = ":".join(bus.lower().split(":")[-2:]).split(".")[0] if bus else ""
    candidates = [d for d in cprefs.devices if d.type == backend] if backend else []
    if pinned is not None and bus_key and len(candidates) > 1:
        matching = [d for d in candidates if bus_key in d.id.lower()]
        if matching:
            print(f"CUDA_VISIBLE_DEVICES not honoured; selecting {bus} by bus id")
            candidates = matching
        else:
            print(f"WARNING pinned to GPU {pinned} ({bus}) but no device id matches; using all")

    chosen = {(d.type, d.id) for d in candidates}
    enabled = 0
    for device in cprefs.devices:
        # CPU devices are listed too; enabling them alongside the GPU splits the
        # scene and is usually slower than the GPU alone. Devices of the other
        # backend are left off: Cycles ignores them anyway, and counting them
        # made one GPU read as two.
        use = (device.type, device.id) in chosen
        device.use = use
        if use:
            enabled += 1
            print(f"Enabled GPU: {device.name} ({device.type}) id={device.id}")
    if pinned is not None:
        print(f"Pinned to GPU {pinned} ({bus or 'bus unknown'}): {enabled} {backend} device(s)")
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
