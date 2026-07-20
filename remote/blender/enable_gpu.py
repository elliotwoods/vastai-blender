"""Configure Cycles for GPU rendering (OptiX preferred, CUDA fallback).

Engines other than Cycles are left untouched: EEVEE uses the GPU implicitly,
Octane is handled by the OctaneBlender build itself.
"""

import bpy

scene = bpy.context.scene

if scene.render.engine == 'CYCLES':
    scene.cycles.device = 'GPU'

    prefs = bpy.context.preferences
    cprefs = prefs.addons['cycles'].preferences
    cprefs.get_devices()

    if 'OPTIX' in [device.type for device in cprefs.devices]:
        cprefs.compute_device_type = 'OPTIX'
        print("Using OptiX for rendering")
    else:
        cprefs.compute_device_type = 'CUDA'
        print("Using CUDA for rendering")

    for device in cprefs.devices:
        device.use = True
        print(f"Enabled GPU: {device.name} ({device.type})")

    if bpy.app.version < (3, 0, 0):  # pre Cycles-X
        scene.cycles.tile_size = 512
        scene.cycles.use_auto_tile_size = False
        print("Tile size set to 512 (pre Cycles-X)")
    else:
        scene.cycles.use_auto_tile_size = True
        print("Cycles-X detected: using auto tile size")

    scene.cycles.use_persistent_data = True
else:
    print(f"Render engine is {scene.render.engine}, not Cycles. Skipping GPU setup.")

print("Rendering setup completed.")
