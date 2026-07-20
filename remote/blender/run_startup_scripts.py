"""Execute all in-file text blocks whose name starts with "startup".

The per-scene hook: pack a text block named e.g. "startup_setup.py" into the
.blend and it runs before rendering (ported behaviour — kept intentionally
identical to the legacy pipeline).
"""

import bpy

for text in bpy.data.texts:
    if text.name.lower().startswith("startup"):
        print(f"Executing startup script {text.name}")
        exec(text.as_string(), globals())
