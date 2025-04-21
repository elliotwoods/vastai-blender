import bpy

scene = bpy.context.scene

# Check if the current scene is set to use Cycles
if scene.render.engine == 'CYCLES':    
    scene.cycles.device = 'GPU'

    # Get user preferences for Cycles
    prefs = bpy.context.preferences
    prefs.addons['cycles'].preferences.get_devices()
    cprefs = prefs.addons['cycles'].preferences

    # Try to use OptiX, otherwise fallback to CUDA
    if 'OPTIX' in [device.type for device in cprefs.devices]:
        cprefs.compute_device_type = 'OPTIX'
        print("Using OptiX for rendering")
    else:
        cprefs.compute_device_type = 'CUDA'
        print("Using CUDA for rendering")

    # Enable all available GPUs
    for device in cprefs.devices:
        device.use = True
        print(f"Enabled GPU: {device.name} ({device.type})")

    # Handle tile size correctly
    if bpy.app.version < (3, 0, 0):  # Pre Cycles-X (Blender < 3.0)
        bpy.data.scenes[0].cycles.tile_size = 512
        bpy.context.scene.cycles.use_auto_tile_size = False
        print("Tile size set to 512 (Pre Cycles-X)")
    else:
        bpy.context.scene.cycles.use_auto_tile_size = True  # Dynamic Tiling in Cycles-X
        print("Cycles-X detected: Using auto tile size")

    # Enable Persistent Data for faster re-renders (useful for animations)
    bpy.context.scene.cycles.use_persistent_data = True
else:
    print(f"Rende engine is {scene.render.engine}, not Cycles. Skipping GPU setup.")

print("Rendering setup completed.")
