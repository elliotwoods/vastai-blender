"""Execute all in-file text blocks whose name starts with "startup".

The per-scene hook: pack a text block named e.g. "startup_setup.py" into the
.blend and it runs before rendering (ported behaviour — kept intentionally
identical to the legacy pipeline).

A block that raises still fails the render (Blender runs this under
--python-exit-code), but first prints one line naming it,
    VR_STARTUP_FAILED {"script": name, "error": "Type: message"}
which the agent makes the chunk's error, with errorKind "scene": the block is
part of the .blend, and would raise the same way on every node.
"""

import json

import bpy


def _vr_run_startup_block(name, source):
    # A function of its own, so the block cannot rebind the names this needs:
    # the block itself still runs in this module's globals, as it always has.
    try:
        exec(source, globals())
    except Exception as e:
        report = {"script": name, "error": f"{type(e).__name__}: {e}"}
        print("VR_STARTUP_FAILED " + json.dumps(report), flush=True)
        raise


for text in bpy.data.texts:
    if text.name.lower().startswith("startup"):
        print(f"Executing startup script {text.name}")
        _vr_run_startup_block(text.name, text.as_string())
