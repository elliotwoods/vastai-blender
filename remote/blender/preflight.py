"""Scene preflight: refuse, before the first frame, a scene no node renders right.

Runs as the third -P, after run_startup_scripts.py (so a path a startup block
relinks counts) and enable_gpu.py. Only the .blend is uploaded to a node, so
anything it refers to by path is not there, and Blender does not stop for it:
a missing texture renders magenta, a missing library leaves placeholders, an
unbaked simulation starts cold in every chunk but the first. Each renders the
whole job wrong, and every chunk completes, downloads and is billed across the
fleet (#246 #247 #249 #252).

Checks, over what the scene can use (datablocks with real users; a fake user
alone does not count, and objects that do not render, hidden or in a
collection disabled for renders or excluded from the view layer, are skipped):
  * files it refers to by path and did not pack: images (every UDIM tile),
    movie clips, volumes, Alembic/USD caches, fonts, mesh-cache modifiers and
    linked libraries, and any linked datablock Blender could not find
    (ID.is_missing);
  * simulations this render cannot run forward from their first frame: an
    unbaked point cache (rigid body, cloth, soft body, dynamic paint,
    particles, hair dynamics) or a fluid domain in Replay mode, when the job is
    split into chunks, the frames rendered are not consecutive, or the first
    one comes after the simulation starts. A bake on disk is refused whatever
    the chunking: disk caches are not uploaded, and a baked cache whose files
    are missing is not simulated either;
  * a movie output format: chunks render one image per frame.
bpy.utils.blend_paths() also lists paths the checks above do not know about;
those are warnings only, since it cannot say whether anything uses them. So
are sounds (renders run with -noaudio) and geometry-nodes simulation zones,
whose bake state Python cannot read.

Output: exactly one line,
    VR_PREFLIGHT {"ok": bool, "summary": str, "missing": [...],
                  "problems": [str], "warnings": [str]}
and then, when ok is false, a raise: under --python-exit-code Blender exits
GUARD_EXIT before rendering, and the agent fails the chunk with errorKind
"scene" and the summary as its error.

Input: VR_PREFLIGHT in the environment, JSON set by the agent:
    {"jobChunks": int|null, "first": int|null, "last": int|null,
     "contiguous": bool, "mode": "enforce"|"warn"}
first/last are the first and last frames Blender will actually render
(Overwrite is off, so frames already on disk are skipped), contiguous whether
it renders every frame between them, and "warn" reports without refusing.

WHY THIS IS DEFENSIVE (enable_gpu.py's rule): the Blender version is whatever
the job asks for, and bpy moves between releases. Every property is probed
with getattr, and a check that raises becomes a warning, never a failure: a
bug here must not cost a paid render. Only a positive finding refuses one.
"""

import json
import os

import bpy

# Entries listed per section in the marker line; the counts stay exact.
MAX_LISTED = 25
# Formats that write one container file rather than one image per frame. Newer
# Blenders say so with render.is_movie_format; this backs it up.
MOVIE_FORMATS = {"FFMPEG", "AVI_JPEG", "AVI_RAW", "FRAMESERVER", "H264", "XVID", "THEORA",
                 "QUICKTIME"}
# The bpy.data collections whose datablocks can be linked from a library.
ID_COLLECTIONS = (
    "actions", "armatures", "brushes", "cache_files", "cameras", "collections", "curves",
    "fonts", "grease_pencils", "hair_curves", "images", "lattices", "lightprobes", "lights",
    "linestyles", "masks", "materials", "meshes", "metaballs", "movieclips", "node_groups",
    "objects", "paint_curves", "palettes", "particles", "pointclouds", "scenes", "sounds",
    "speakers", "texts", "textures", "volumes", "worlds",
)


def load_args():
    try:
        args = json.loads(os.environ.get("VR_PREFLIGHT") or "{}")
    except ValueError:
        args = {}
    return args if isinstance(args, dict) else {}


ARGS = load_args()
scene = bpy.context.scene
missing = []  # {"kind", "name", "path"}: fatal
problems = []  # fatal
warnings = []
checked = set()  # every normalised path a typed check looked at


def real_users(idb):
    users = getattr(idb, "users", 1) or 0
    if getattr(idb, "use_fake_user", False):
        users -= 1
    return users > 0


def packed(idb):
    if getattr(idb, "packed_file", None) is not None:
        return True
    try:
        return len(getattr(idb, "packed_files", None) or ()) > 0
    except TypeError:
        return False


def abspath(path, idb=None):
    """`path` on this node. `//` is relative to the file that holds `idb`."""
    library = getattr(idb, "library", None) if idb is not None else None
    try:
        if library is not None:
            path = bpy.path.abspath(path, library=library)
        else:
            path = bpy.path.abspath(path)
    except Exception:  # noqa: BLE001 — an unresolvable path is checked as written
        pass
    return os.path.normpath(path)


def need_file(kind, idb, path):
    """Record `path`, which datablock `idb` renders from, if it is not on this node."""
    full = abspath(path, idb)
    checked.add(full)
    if not os.path.exists(full):
        missing.append({"kind": kind, "name": getattr(idb, "name", "?"), "path": path})


def rendering_collections():
    """Names of the collections that render in some view layer, or None when
    bpy cannot say (then every collection counts).

    A collection renders unless it, or one above it, is disabled for renders
    or excluded from the layer: where artists park work in progress, an
    unbaked simulation included, that must not fail the job.
    """
    layers = [vl for vl in getattr(scene, "view_layers", None) or () if getattr(vl, "use", True)]
    if not layers:
        return None
    names = set()

    def walk(layer_collection, hidden):
        coll = layer_collection.collection
        hidden = hidden or layer_collection.exclude or getattr(coll, "hide_render", False)
        if not hidden:
            names.add(coll.name)
        for child in layer_collection.children:
            walk(child, hidden)

    for layer in layers:
        walk(layer.layer_collection, False)
    return names


def rendered_objects():
    try:
        rendering = rendering_collections()
    except Exception:  # noqa: BLE001 — then every collection counts
        rendering = None
    for obj in getattr(scene, "objects", None) or ():
        if getattr(obj, "hide_render", False):
            continue
        if rendering is not None and not any(
            c.name in rendering for c in getattr(obj, "users_collection", None) or ()
        ):
            continue
        yield obj


def check_libraries():
    for lib in getattr(bpy.data, "libraries", None) or ():
        path = getattr(lib, "filepath", "") or ""
        if path and not packed(lib):
            need_file("library", lib, path)


def check_missing_ids():
    """Linked datablocks Blender replaced with an empty placeholder."""
    reported = {m["path"] for m in missing if m["kind"] == "library"}
    by_library = {}
    for attr in ID_COLLECTIONS:
        for idb in getattr(bpy.data, attr, None) or ():
            if getattr(idb, "is_missing", False) and real_users(idb):
                path = getattr(getattr(idb, "library", None), "filepath", "") or "?"
                by_library.setdefault(path, []).append(getattr(idb, "name", "?"))
    for path, names in by_library.items():
        if path in reported:
            continue  # the library itself is missing, and already says so
        more = f" and {len(names) - 3} more" if len(names) > 3 else ""
        missing.append({"kind": "linked data", "name": ", ".join(names[:3]) + more,
                        "path": path})


def check_images():
    for img in getattr(bpy.data, "images", None) or ():
        if not real_users(img) or packed(img):
            continue
        source = getattr(img, "source", "FILE")
        if source in ("GENERATED", "VIEWER"):
            continue
        if getattr(img, "type", "IMAGE") in ("RENDER_RESULT", "COMPOSITING"):
            continue
        path = getattr(img, "filepath", "") or ""
        if not path:
            continue
        if source == "TILED" and ("<UDIM>" in path or "<UVTILE>" in path):
            for tile in getattr(img, "tiles", None) or ():
                n = int(getattr(tile, "number", 1001))
                uvtile = "u%d_v%d" % ((n - 1001) % 10 + 1, (n - 1001) // 10 + 1)
                need_file("image", img, path.replace("<UDIM>", str(n)).replace("<UVTILE>", uvtile))
        else:
            need_file("image", img, path)


def check_other_files():
    for attr, kind, can_pack in (
        ("movieclips", "movie clip", False),
        ("volumes", "volume", True),
        ("cache_files", "cache file", False),
        ("fonts", "font", True),
    ):
        for idb in getattr(bpy.data, attr, None) or ():
            if not real_users(idb) or (can_pack and packed(idb)):
                continue
            path = getattr(idb, "filepath", "") or ""
            if path and path != "<builtin>":
                need_file(kind, idb, path)


def check_mesh_caches():
    for obj in rendered_objects():
        for mod in getattr(obj, "modifiers", None) or ():
            if getattr(mod, "type", "") == "MESH_CACHE" and getattr(mod, "show_render", True):
                path = getattr(mod, "filepath", "") or ""
                if path:
                    need_file("mesh cache", obj, path)


def check_sounds():
    for snd in getattr(bpy.data, "sounds", None) or ():
        if not real_users(snd) or packed(snd):
            continue
        path = getattr(snd, "filepath", "") or ""
        full = abspath(path, snd)
        checked.add(full)
        if path and not os.path.exists(full):
            warnings.append(f"sound '{snd.name}' not found ({path}); renders run without audio")


def check_output():
    render = scene.render
    settings = getattr(render, "image_settings", None)
    fmt = getattr(settings, "file_format", "") or ""
    movie = getattr(render, "is_movie_format", None)
    if movie is None:
        movie = fmt in MOVIE_FORMATS
    if movie or getattr(settings, "media_type", "") == "VIDEO":
        problems.append(
            f"the output is a movie ({fmt}); chunks render one image per frame, so set"
            " Output > File Format to an image format such as OpenEXR or PNG and re-save"
        )


def renders_from(sim_start):
    """Does this render reach a simulation that starts at `sim_start`?"""
    first, last = ARGS.get("first"), ARGS.get("last")
    if first is None:
        return False  # every frame is already on disk: nothing renders
    return last is None or sim_start is None or last >= sim_start


def stepping_problem(sim_start):
    """Why this render cannot run a simulation forward from its start, or None."""
    if not renders_from(sim_start):
        return None
    chunks = ARGS.get("jobChunks")
    if isinstance(chunks, int) and chunks > 1:
        return f"the job is split into {chunks} chunks, each of which starts it cold"
    if not ARGS.get("contiguous", True):
        return ("this chunk does not render every frame in turn (a frame step, or frames"
                " already rendered), so it cannot run it forward")
    first = ARGS["first"]
    start = int(getattr(scene, "frame_start", first))
    if sim_start is not None:
        start = max(start, int(sim_start))
    if first > start:
        return f"this chunk starts at frame {first}, after it starts at {start}, so it starts cold"
    return None


def disk_cache_dir(pc):
    if getattr(pc, "use_external", False):
        return abspath(getattr(pc, "filepath", "") or "")
    blend = bpy.data.filepath or ""
    stem = os.path.splitext(os.path.basename(blend))[0]
    return os.path.join(os.path.dirname(blend), "blendcache_" + stem)


def point_cache(kind, owner, pc):
    if pc is None:
        return
    start = getattr(pc, "frame_start", None)
    if getattr(pc, "is_baked", False):
        if getattr(pc, "use_disk_cache", False) or getattr(pc, "use_external", False):
            where = disk_cache_dir(pc)
            if renders_from(start) and not os.path.isdir(where):
                problems.append(
                    f"{kind} on '{owner}' is baked to disk ({where}), and disk caches are not"
                    " uploaded with the .blend; bake it with Disk Cache off and re-save"
                )
        return
    reason = stepping_problem(start)
    if reason:
        problems.append(
            f"{kind} on '{owner}' is not baked, and {reason}; bake it (Disk Cache off) and"
            " re-save, or render the job as one chunk"
        )


def fluid_domain(owner, ds):
    if ds is None:
        return
    start = getattr(ds, "cache_frame_start", None)
    if getattr(ds, "cache_type", "REPLAY") == "REPLAY":
        reason = stepping_problem(start)
        if reason:
            problems.append(
                f"fluid domain '{owner}' simulates as it plays (Replay cache), and {reason};"
                " render the job as one chunk"
            )
        return
    if not getattr(ds, "has_cache_baked_any", True):
        return  # never baked: it renders empty here, as it does for the artist
    where = abspath(getattr(ds, "cache_directory", "") or "")
    if renders_from(start) and not os.path.isdir(where):
        problems.append(
            f"fluid domain '{owner}' is baked to {where}, and fluid bakes can be neither"
            " packed nor uploaded with the .blend"
        )


def has_simulation_zone(tree, depth=0):
    if tree is None or depth > 8:
        return False
    for node in getattr(tree, "nodes", None) or ():
        idname = getattr(node, "bl_idname", "")
        if idname == "GeometryNodeSimulationOutput":
            return True
        if idname == "GeometryNodeGroup" and has_simulation_zone(
            getattr(node, "node_tree", None), depth + 1
        ):
            return True
    return False


def check_simulations():
    world = getattr(scene, "rigidbody_world", None)
    bodies = getattr(getattr(world, "collection", None), "objects", None) or ()
    if world is not None and getattr(world, "enabled", True) and len(bodies) > 0:
        point_cache("rigid body world", scene.name, getattr(world, "point_cache", None))
    for obj in rendered_objects():
        for mod in getattr(obj, "modifiers", None) or ():
            if not getattr(mod, "show_render", True):
                continue
            kind = getattr(mod, "type", "")
            if kind in ("CLOTH", "SOFT_BODY"):
                point_cache(kind.replace("_", " ").lower(), obj.name,
                            getattr(mod, "point_cache", None))
            elif kind == "DYNAMIC_PAINT" and getattr(mod, "ui_type", "") == "CANVAS":
                surfaces = getattr(getattr(mod, "canvas_settings", None), "canvas_surfaces", None)
                for surface in surfaces or ():
                    # Image-sequence surfaces bake to image files, not a cache.
                    if getattr(surface, "surface_format", "") != "IMAGE":
                        point_cache("dynamic paint", obj.name,
                                    getattr(surface, "point_cache", None))
            elif kind == "PARTICLE_SYSTEM":
                psys = getattr(mod, "particle_system", None)
                settings = getattr(psys, "settings", None)
                if settings is None:
                    continue
                if getattr(settings, "type", "") == "HAIR":
                    if getattr(psys, "use_hair_dynamics", False):
                        point_cache("hair dynamics", obj.name, getattr(psys, "point_cache", None))
                elif getattr(settings, "physics_type", "") not in ("NO", "KEYED"):
                    point_cache("particles", obj.name, getattr(psys, "point_cache", None))
            elif kind == "FLUID" and getattr(mod, "fluid_type", "") == "DOMAIN":
                fluid_domain(obj.name, getattr(mod, "domain_settings", None))
            elif kind == "NODES" and has_simulation_zone(getattr(mod, "node_group", None)):
                reason = stepping_problem(None)
                if reason:
                    warnings.append(
                        f"geometry-nodes simulation on '{obj.name}': {reason}. Unless it is"
                        " baked (which Python cannot tell), those frames will be wrong"
                    )


def check_blend_paths():
    """Paths no typed check knows. Warnings: nothing says they are used."""
    blend_paths = getattr(getattr(bpy, "utils", None), "blend_paths", None)
    if not callable(blend_paths):
        return
    seen = set()
    for path in blend_paths(absolute=True, packed=False, local=False):
        # Frame and tile tokens are patterns, not files.
        if not path or "#" in path or "<" in path:
            continue
        full = os.path.normpath(path)
        if full in checked or full in seen:
            continue
        seen.add(full)
        if not os.path.exists(full):
            warnings.append(f"not on the node, and not packed: {path}")


def summarise():
    parts = []
    if missing:
        shown = ", ".join(f"{m['kind']} '{m['name']}' ({m['path']})" for m in missing[:4])
        more = f" and {len(missing) - 4} more" if len(missing) > 4 else ""
        parts.append(f"{len(missing)} file(s) not packed into the .blend and not on the node: "
                     f"{shown}{more}")
    parts += problems[:3]
    if len(problems) > 3:
        parts.append(f"{len(problems) - 3} more problem(s)")
    return "; ".join(parts) or "ok"


for check in (check_libraries, check_missing_ids, check_images, check_other_files,
              check_mesh_caches, check_sounds, check_simulations, check_output,
              check_blend_paths):
    try:
        check()
    except Exception as e:  # noqa: BLE001 — a preflight bug must not fail a paid render
        warnings.append(f"preflight {check.__name__} could not run: {type(e).__name__}: {e}")

ok = not missing and not problems
report = {
    "ok": ok,
    "summary": summarise(),
    "missing": missing[:MAX_LISTED],
    "problems": problems[:MAX_LISTED],
    "warnings": warnings[:MAX_LISTED],
}
print("VR_PREFLIGHT " + json.dumps(report), flush=True)
if not ok and ARGS.get("mode") != "warn":
    raise RuntimeError("scene preflight failed: " + report["summary"])
