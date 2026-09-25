"""Scene preflight: refuse, before the first frame, a scene no node renders right.

Runs as the third -P, after run_startup_scripts.py (so a path a startup block
relinks counts) and enable_gpu.py. Only the .blend is uploaded to a node, so
anything it refers to by path is not there, and Blender does not stop for it:
a missing texture renders magenta, a missing library leaves placeholders, an
unbaked simulation starts cold in every chunk but the first. Each renders the
whole job wrong, and every chunk completes, downloads and is billed across the
fleet (#246 #247 #249 #252).

Checks, over what the render evaluates and reads (see trace):
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
A missing file nothing the render reads from is only a warning: a reference
image on an empty, a camera's background, a brush's texture, the footage a
camera solve was tracked from, a cache only a hidden object uses. So is every
path bpy.utils.blend_paths() knows and the checks above do not, since it
cannot say whether anything uses it; and so are sounds (renders run with
-noaudio) and geometry-nodes simulation zones, whose bake state Python cannot
read.

Output: exactly one line,
    VR_PREFLIGHT {"ok": bool, "summary": str,
                  "missing": [{"kind", "name", "path", "packable"}],
                  "problems": [str], "warnings": [str]}
and then, when ok is false, a raise: under --python-exit-code Blender exits
GUARD_EXIT before rendering, and the agent fails the chunk with errorKind
"scene" and the summary as its error. A missing entry's "packable" is false
for what a .blend cannot hold (movie clips, caches) and for linked data a
library lacks: packing is no fix for those.

Input: VR_PREFLIGHT in the environment, JSON set by the agent:
    {"jobChunks": int|null, "first": int|null, "last": int|null,
     "contiguous": bool, "stepped": bool, "resumed": bool,
     "mode": "enforce"|"warn"}
first/last are the first and last frames Blender will actually render
(Overwrite is off, so frames already on disk are skipped), contiguous whether
it renders every frame between them, stepped whether the chunk's own frames
skip any (a frame step), resumed whether frames already on disk are being
skipped, and "warn" reports without refusing.

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
missing = []  # {"kind", "name", "path", "packable"}: fatal
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


def id_type(idb):
    return getattr(idb, "id_type", "") or ""


def rendering_collections():
    """The collections that render in some view layer, or None when bpy
    cannot say (then every collection counts).

    A collection renders unless it, or one above it, is disabled for renders
    or excluded from the layer: where artists park work in progress, an
    unbaked simulation included, that must not fail the job.
    """
    layers = [vl for vl in getattr(scene, "view_layers", None) or () if getattr(vl, "use", True)]
    if not layers:
        return None
    found = set()

    def walk(layer_collection, hidden):
        coll = layer_collection.collection
        hidden = hidden or layer_collection.exclude or getattr(coll, "hide_render", False)
        if not hidden:
            found.add(coll)
        for child in layer_collection.children:
            walk(child, hidden)

    for layer in layers:
        walk(layer.layer_collection, False)
    return found


def direct_objects(rendering):
    """The scene's objects that render in their own right: not hidden from the
    render, and in a collection in `rendering` (any, when that is None)."""
    for obj in getattr(scene, "objects", None) or ():
        if getattr(obj, "hide_render", False):
            continue
        if rendering is not None and not any(
            c in rendering for c in getattr(obj, "users_collection", None) or ()
        ):
            continue
        yield obj


def compositor_inputs():
    """What the compositor reads while it runs: its tree, and the images, movie
    clips, masks and node groups its nodes hold."""
    if not getattr(scene.render, "use_compositing", True):
        return []
    # 5.0 made the compositor's tree a datablock of its own; before, it is the
    # scene's embedded node_tree, used while use_nodes is on.
    tree = getattr(scene, "compositing_node_group", None)
    if tree is None and getattr(scene, "use_nodes", False):
        tree = getattr(scene, "node_tree", None)
    if tree is None:
        return []
    found = [tree] if id_type(tree) else []
    for node in getattr(tree, "nodes", None) or ():
        for attr in ("image", "clip", "mask", "node_tree"):
            ref = getattr(node, attr, None)
            if ref is not None and id_type(ref):
                found.append(ref)
    return found


def not_drawn_from(idb):
    """Datablock types `idb` uses that no render draws: a camera's background
    images and clips are the viewport's; an object's movie clip is the tracking
    data of its Camera Solver or Follow Track constraint, which the .blend
    holds; an empty's image is a viewport reference."""
    kind = id_type(idb)
    if kind == "CAMERA":
        return ("IMAGE", "MOVIECLIP")
    if kind == "OBJECT":
        return ("IMAGE", "MOVIECLIP") if getattr(idb, "type", "") == "EMPTY" else ("MOVIECLIP",)
    return ()


def trace():
    """Every datablock this render evaluates or reads from, or None when bpy
    cannot say.

    Blender's render evaluates the objects that render and whatever they
    depend on. An object hidden from the render, or in an excluded collection,
    is evaluated all the same when something that renders uses it: the cloth
    proxy a visible mesh follows through Surface Deform, a collection an empty
    instances, the image a material samples. Counting it by where it sits
    missed those, and counting every datablock with a user refused scenes that
    render right, over a reference image or a camera solve's footage.

    So: from the objects that render, the world and the compositor's inputs,
    follow bpy.data.user_map() downwards (A uses B), through everything but a
    scene (which uses all of it) and the uses not_drawn_from names.
    """
    user_map = getattr(bpy.data, "user_map", None)
    if not callable(user_map):
        return None
    uses = {}
    for idb, users in user_map().items():
        for user in users:
            uses.setdefault(user, []).append(idb)
    todo = list(direct_objects(RENDERING))
    world = getattr(scene, "world", None)
    if world is not None:
        todo.append(world)
    todo += compositor_inputs()
    reached = set()
    while todo:
        idb = todo.pop()
        if idb in reached:
            continue
        reached.add(idb)
        if id_type(idb) == "SCENE":
            continue
        skip = not_drawn_from(idb)
        deps = list(uses.get(idb, ()))
        # A library override is rebuilt from the linked datablock it overrides.
        reference = getattr(getattr(idb, "override_library", None), "reference", None)
        if reference is not None:
            deps.append(reference)
        for dep in deps:
            if dep not in reached and id_type(dep) not in skip:
                todo.append(dep)
    return reached


try:
    RENDERING = rendering_collections()
except Exception as e:  # noqa: BLE001 — then every collection counts
    RENDERING = None
    warnings.append(f"preflight could not read the view layers: {type(e).__name__}: {e}")
try:
    REACHED = trace()
    if REACHED is None:
        warnings.append("this Blender has no bpy.data.user_map: every object in the scene, and"
                        " every file with a user, counts as rendered")
except Exception as e:  # noqa: BLE001 — then everything counts, as refusing is the safe side
    REACHED = None
    warnings.append(f"preflight could not trace what the render uses ({type(e).__name__}: {e}):"
                    " every object in the scene, and every file with a user, counts as rendered")


def used(idb):
    """Does the render evaluate or read `idb`? Without a trace, anything with
    a real user does (a fake user alone never counts)."""
    if REACHED is None:
        return real_users(idb)
    return idb in REACHED or (RENDERING is not None and idb in RENDERING)


def rendered_objects():
    """The objects the render evaluates, the scene's own first. Without a
    trace, every object in the scene, hidden or not."""
    objects = list(getattr(scene, "objects", None) or ())
    if REACHED is None:
        return objects
    found = [obj for obj in objects if obj in REACHED]
    in_scene = set(found)
    others = [idb for idb in REACHED if id_type(idb) == "OBJECT" and idb not in in_scene]
    return found + sorted(others, key=lambda obj: getattr(obj, "name", ""))


def need_file(kind, idb, path, packable=True, needed=None):
    """Record `path`, which datablock `idb` refers to, if it is not on this node:
    fatal when the render reads it (`needed`, by default used(idb)), else a
    warning."""
    full = abspath(path, idb)
    checked.add(full)
    if os.path.exists(full):
        return
    name = getattr(idb, "name", "?")
    if used(idb) if needed is None else needed:
        missing.append({"kind": kind, "name": name, "path": path, "packable": packable})
    else:
        warnings.append(f"{kind} '{name}' is not on the node ({path}), but nothing the render"
                        " draws uses it")


absent_libraries = set()  # filepaths of the libraries not on this node


def check_libraries():
    """A library the render links data from. One nothing it draws comes from,
    such as the brush assets a sculpting session linked, is only a warning."""
    libraries = None
    if REACHED is not None:
        libraries = {getattr(idb, "library", None) for idb in REACHED | (RENDERING or set())}
    for lib in getattr(bpy.data, "libraries", None) or ():
        path = getattr(lib, "filepath", "") or ""
        if path and not packed(lib):
            if not os.path.exists(abspath(path, lib)):
                absent_libraries.add(path)
            need_file("library", lib, path,
                      needed=True if libraries is None else lib in libraries)


def check_missing_ids():
    """Linked datablocks Blender replaced with an empty placeholder."""
    by_library = {}
    unused = []
    for attr in ID_COLLECTIONS:
        for idb in getattr(bpy.data, attr, None) or ():
            if not getattr(idb, "is_missing", False) or not real_users(idb):
                continue
            path = getattr(getattr(idb, "library", None), "filepath", "") or "?"
            if path in absent_libraries:
                continue  # the library itself is missing, and already says so
            if used(idb):
                by_library.setdefault(path, []).append(getattr(idb, "name", "?"))
            else:
                unused.append(f"{getattr(idb, 'name', '?')} ({path})")
    for path, names in by_library.items():
        more = f" and {len(names) - 3} more" if len(names) > 3 else ""
        missing.append({"kind": "linked data", "name": ", ".join(names[:3]) + more,
                        "path": path, "packable": False})
    if unused:
        warnings.append("linked data missing from its library, but nothing the render draws"
                        " uses it: " + ", ".join(unused[:5]))


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
                need_file(kind, idb, path, packable=can_pack)


def check_mesh_caches():
    for obj in rendered_objects():
        for mod in getattr(obj, "modifiers", None) or ():
            if getattr(mod, "type", "") == "MESH_CACHE" and getattr(mod, "show_render", True):
                path = getattr(mod, "filepath", "") or ""
                if path:
                    need_file("mesh cache", obj, path, packable=False)


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
    """(why, what else would do) when this render cannot run a simulation
    forward from its start, else None. "What else" is the way out that is not
    a bake: a resumed chunk is told so, not to render the job as one chunk,
    which it may already be."""
    if not renders_from(sim_start):
        return None
    chunks = ARGS.get("jobChunks")
    if isinstance(chunks, int) and chunks > 1:
        return (f"the job is split into {chunks} chunks, each of which starts it cold",
                "render the job as one chunk")
    if ARGS.get("stepped"):
        return ("this chunk renders with a frame step, so it cannot run it forward",
                "render it with a frame step of 1")
    first = ARGS["first"]
    start = int(getattr(scene, "frame_start", first))
    if sim_start is not None:
        start = max(start, int(sim_start))
    again = "render the chunk again from its first frame"
    if ARGS.get("resumed") and first > start:
        return (f"this chunk resumes at frame {first}, after frames it had already rendered,"
                " so it starts cold there", again)
    if ARGS.get("resumed") and not ARGS.get("contiguous", True):
        return ("this chunk skips frames it had already rendered, so it starts cold after them",
                again)
    if not ARGS.get("contiguous", True):
        return ("this chunk does not render every frame in turn, so it cannot run it forward",
                "render every frame in turn")
    if first > start:
        return (f"this chunk starts at frame {first}, after it starts at {start}, so it starts"
                " cold", f"start the render at frame {start}")
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
    found = stepping_problem(start)
    if found:
        reason, remedy = found
        problems.append(
            f"{kind} on '{owner}' is not baked, and {reason}; bake it (Disk Cache off) and"
            f" re-save, or {remedy}"
        )


def fluid_domain(owner, ds):
    if ds is None:
        return
    start = getattr(ds, "cache_frame_start", None)
    if getattr(ds, "cache_type", "REPLAY") == "REPLAY":
        found = stepping_problem(start)
        if found:
            reason, remedy = found
            problems.append(
                f"fluid domain '{owner}' simulates as it plays (Replay cache), and {reason};"
                f" {remedy}"
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
                found = stepping_problem(None)
                if found:
                    reason = found[0]
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
    def listed(entries):
        shown = ", ".join(f"{m['kind']} '{m['name']}' ({m['path']})" for m in entries[:4])
        return shown + (f" and {len(entries) - 4} more" if len(entries) > 4 else "")

    parts = []
    linked = [m for m in missing if m["kind"] == "linked data"]
    packable = [m for m in missing if m["packable"]]
    # Movie clips and caches: a .blend cannot hold them, so packing is no fix.
    other = [m for m in missing if not m["packable"] and m not in linked]
    if packable:
        parts.append(f"{len(packable)} file(s) not packed into the .blend and not on the node: "
                     f"{listed(packable)}")
    if other:
        parts.append(f"{len(other)} file(s) the render reads are not on the node, and a .blend"
                     f" cannot pack them: {listed(other)}")
    if linked:
        parts.append(f"linked data missing from its library: {listed(linked)}")
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
