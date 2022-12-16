
import bpy
scene = bpy.context.scene
scene.cycles.device = 'GPU'
prefs = bpy.context.preferences
prefs.addons['cycles'].preferences.get_devices()
cprefs = prefs.addons['cycles'].preferences
cprefs.compute_device_type = 'CUDA'
for device in cprefs.devices:
      if device.type == 'CUDA':
              device.use = True
              print(device)
