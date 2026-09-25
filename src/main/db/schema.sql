-- Operational data. Settings/secrets live in settings.json (see settings.ts);
-- this DB is the durable record of jobs/chunks/frames/nodes/costs that lets
-- the app resume cleanly after a restart.
--
-- This file runs on every launch, against old databases too, BEFORE db.ts's
-- migrate() adds the columns they lack. So:
--  - a column added to an existing table goes at the end of it, in the order
--    migrate() adds it, so a fresh and an upgraded database end up alike
--    (db.test.ts compares them);
--  - an index on such a column is created in its migrate() step, never here:
--    on an older database the column does not exist yet when this runs, and
--    the CREATE INDEX would throw before migrate() could add it.

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  blend_path TEXT NOT NULL,
  engine TEXT NOT NULL,               -- eevee | cycles | octane
  frame_start INTEGER NOT NULL,
  frame_end INTEGER NOT NULL,
  frame_step INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,                -- queued | running | complete | partial | failed | cancelled
  blender_version TEXT,               -- resolved from .blend header, e.g. "4.5.3"
  addon_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  chunk_size INTEGER,                 -- null = auto
  output_dir TEXT NOT NULL,
  cost_so_far REAL NOT NULL DEFAULT 0,
  submitted_at INTEGER NOT NULL,      -- epoch ms
  share_node INTEGER NOT NULL DEFAULT 0, -- 0 = exclusive (one chunk per node), 1 = may co-run
  -- The scene as submitted (plan 1.12). createJob copies the .blend into the
  -- job's folder and the job renders that copy, so saving over blend_path
  -- mid-render cannot change what the rest of the frames are rendered from.
  -- Both null = a job from before snapshots, which renders blend_path as it
  -- is now.
  blend_sha256 TEXT,                  -- hex SHA-256 of the snapshot, which nodes cache it under
  scene_path TEXT,                    -- absolute path of the snapshot
  -- Why the job is waiting on the user instead of rendering: the same class
  -- of error on two or more nodes (plan 1.17's breaker), or a scene that
  -- failed preflight (1.16). Shown as written. Null = nothing needs the user.
  attention TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  frame_start INTEGER NOT NULL,
  frame_end INTEGER NOT NULL,
  state TEXT NOT NULL,                -- pending | assigned | rendering | encoding | downloading | complete | failed | cancelled
  node_id TEXT,
  frames_done INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  assigned_at INTEGER,             -- epoch ms of dispatch; null = never assigned
  -- Retry policy (plan 1.17). `retries` counts failed attempts against
  -- MAX_RETRIES, whatever failed. 1.17 keeps it for the scene's failures and
  -- counts one that was the machine's or the network's (node gone, SSH
  -- refused, a transient error) in infra_retries instead, so a dying node
  -- cannot use up a chunk's render retries; the chunk then waits out a
  -- backoff before it is dispatched again.
  not_before INTEGER,                 -- epoch ms before which it is not dispatched; null = at once
  infra_retries INTEGER NOT NULL DEFAULT 0,
  -- The last failed attempt's class: what classify() made of the error
  -- (transient | machine | account | job-deterministic | local-fs), or the
  -- agent's own errorKind, e.g. scene from preflight (1.16). Null = no failure.
  error_kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_job ON chunks(job_id);
CREATE INDEX IF NOT EXISTS idx_chunks_state ON chunks(state);
-- The Fleet node panel's "what is this machine rendering" query.
CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id);

CREATE TABLE IF NOT EXISTS frames (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  frame INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  state TEXT NOT NULL,                -- pending | rendered | downloaded
  local_path TEXT,
  size_bytes INTEGER,
  -- Browser-decodable preview of this frame (the render itself is usually EXR,
  -- which no <img> can show). Keyed on the FRAME, never the chunk: requeue()
  -- re-points only not-yet-downloaded rows, so a downloaded frame keeps the old
  -- chunk id while the narrowed chunk's range moves off it.
  thumb_path TEXT,
  PRIMARY KEY (job_id, frame)
);
CREATE INDEX IF NOT EXISTS idx_frames_chunk ON frames(chunk_id);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  instance_id INTEGER,
  state TEXT NOT NULL,
  gpu_name TEXT,
  num_gpus INTEGER NOT NULL DEFAULT 1,
  dph_total REAL,
  ssh_host TEXT,
  ssh_port INTEGER,
  host_key TEXT,                      -- TOFU-pinned host key
  started_at INTEGER,                 -- epoch ms
  accumulated_cost REAL NOT NULL DEFAULT 0,
  eevee_capable INTEGER,              -- null = unprobed, 0/1
  octane_ready INTEGER NOT NULL DEFAULT 0, -- 1 = the license check passed, which #85 made unreliable; see octane_state
  blender_versions TEXT NOT NULL DEFAULT '[]', -- JSON array
  last_error TEXT,
  -- Raw vast.ai offer string, kept verbatim ("Poland, PL" / "US" / "Quebec, CA").
  -- Normalised to a country only at read time, so a parser fix never needs a
  -- backfill. Drives the grid carbon intensity behind the CO2 estimates.
  geolocation TEXT,
  -- When the app confirmed this node's instance gone (plan 1.2): Vast
  -- answered the destroy with 404, or no longer knows the instance
  -- (showInstance, or an init reconcile whose listInstances lacks it). Null =
  -- not confirmed, whatever state says: a DELETE can answer 200 and leave
  -- the instance running (#140). Only a row with an instance_id has anything
  -- to confirm. When a node may be billing is the billing predicate, after
  -- create_unknown_since below.
  destroyed_at INTEGER,               -- epoch ms
  -- The Vast label the instance was created under, written with the row and
  -- so before the create: the only way to find an instance whose create
  -- reply was lost, and how the orphan sweep tells this profile's instances
  -- from another's (plans 1.3, 1.4). Null = not recorded, by a build from
  -- before 1.3; that label was 'vastai-blender ' and the first 8 characters
  -- of id.
  label TEXT,
  -- Octane on this node (plan 1.18), spelled as shared/models.ts's
  -- OctaneState: none | serverRunning | licensed | needsLogin. needsLogin is
  -- a server that is up without a license, waiting for the user to sign in
  -- over VNC. none = no server known to be up: 1.18 checks the node itself
  -- before an Octane chunk goes to it.
  octane_state TEXT NOT NULL DEFAULT 'none',
  -- Since when a create for this row has been out with no known result
  -- (plans 1.2, 1.4): set as PUT /asks is sent; cleared when Vast answers
  -- with the instance id or refuses (a 4xx), or when 1.4's label lookup
  -- adopts the instance or finds none. While set, an instance may be billing
  -- under `label` with its id known to nobody: the reply was lost, a 5xx or
  -- a timeout came after Vast had acted, or the app stopped mid-create.
  create_unknown_since INTEGER        -- epoch ms
  -- The billing predicate (shared/nodeState.ts holdsInstance): the node may
  -- be billing, and counts against the caps, is metered and is named in the
  -- quit dialog, whatever its state, while
  --   (instance_id IS NOT NULL AND destroyed_at IS NULL)
  --   OR (instance_id IS NULL
  --       AND (create_unknown_since IS NOT NULL OR state = 'requested'))
  -- The 'requested' term is a create in flight, or one a crash cut short.
  -- Neither half clears itself: init's reconcile must stamp destroyed_at on
  -- every instance Vast no longer lists (rows an older build marked
  -- 'destroyed' included), and run 1.4's lookup on every unknown create, not
  -- only this session's, taking a settled row out of 'requested'; or those
  -- rows fill the caps for good.
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  chunk_id TEXT,                      -- NULL for a stitched job clip
  kind TEXT NOT NULL,                 -- previewSdr | previewHdr | proxy | live | frame
  abs_path TEXT NOT NULL UNIQUE,
  fps REAL,
  frames INTEGER,
  width INTEGER,
  height INTEGER,
  codec TEXT,
  hdr INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  segments TEXT                       -- job clips: JSON [{start,end}] of job frames held
);
CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);

-- Learned render throughput per GPU model (EWMA of frames/hour measured from
-- our own completed chunks, PER GPU — node totals are divided by the node's
-- GPU count) — feeds offer scoring so machine selection improves with every
-- render. Rows from before it was per GPU were wiped once (db.ts,
-- resetGpuLearning), as were gpu_slots'.
CREATE TABLE IF NOT EXISTS gpu_perf (
  gpu_name TEXT PRIMARY KEY,
  frames_per_hour REAL NOT NULL,
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  -- GPU count of the node behind the latest sample, so a row says which
  -- size of node taught it. Null = not recorded.
  num_gpus INTEGER
);

-- Learned concurrency per GPU model: how many chunks ran side-by-side on a
-- node of this GPU before adding more stopped paying (see slotController).
-- Lets a freshly rented node of a known model start near its optimum instead
-- of re-climbing the ramp from 2 every time.
-- Both columns below are PER GPU (may be fractional despite the INTEGER
-- affinity), so nodes with different GPU counts share one learned figure.
CREATE TABLE IF NOT EXISTS gpu_slots (
  gpu_name TEXT PRIMARY KEY,
  best_slots INTEGER NOT NULL,
  frames_per_hour REAL NOT NULL,      -- node throughput at best_slots, per GPU
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  num_gpus INTEGER                    -- as gpu_perf.num_gpus
);

-- Where a scene's render time goes, per GPU model (scenePerf.ts): the phases
-- the agent's render driver times (remote/blender/render_driver.py), summed,
-- and the most GPU memory one render of the scene used. Keyed by the scene's
-- snapshot hash (jobs.blend_sha256), so every job of one .blend adds to one
-- row, and an edited scene starts a new one.
CREATE TABLE IF NOT EXISTS scene_perf (
  scene_sha TEXT NOT NULL,
  gpu_name TEXT NOT NULL,
  loads INTEGER NOT NULL DEFAULT 0,   -- chunks whose load was timed
  load_s REAL NOT NULL DEFAULT 0,     -- summed over them
  frames INTEGER NOT NULL DEFAULT 0,  -- frames timed
  eval_s REAL NOT NULL DEFAULT 0,     -- each phase summed over those frames
  sync_s REAL NOT NULL DEFAULT 0,
  sample_s REAL NOT NULL DEFAULT 0,
  save_s REAL NOT NULL DEFAULT 0,
  peak_vram_mb INTEGER,               -- null = never measured
  updated_at INTEGER NOT NULL,        -- epoch ms
  PRIMARY KEY (scene_sha, gpu_name)
);

CREATE TABLE IF NOT EXISTS cost_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                -- epoch ms
  dph_total REAL NOT NULL,
  delta_cost REAL NOT NULL
);

-- Per-minute usage series behind the History screen — the same accrual tick as
-- cost_log, but split by what the node was actually doing. One row per
-- (node, job) share, plus a job_id = NULL row for minutes the node billed
-- without rendering, so SUM over a node's rows is its metered spend and the
-- NULL rows are the idle/provisioning overhead within it. Metered, not billed:
-- a minute of the quoted rate per tick while the app runs. Time the app was
-- closed or asleep is missing, and so is a 'failed' node whose instance still
-- runs; nothing here is read back from vast.ai.
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                -- epoch ms
  node_id TEXT NOT NULL,
  job_id TEXT,                        -- null = idle / provisioning overhead
  chunk_id TEXT,                      -- comma-joined when a job has several here
  delta_cost REAL NOT NULL,           -- $ for this minute, this share
  delta_wh REAL NOT NULL DEFAULT 0,   -- GPU energy for this minute, this share
  power_w REAL,                       -- draw at the tick; null = not reported
  gpu_util REAL                       -- 0-100 at the tick; null = not sampled
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_log(job_id);

-- Vast account credit. Sampled every accrual tick but only written when the
-- value moves, so the series stays small and top-ups read as step jumps.
CREATE TABLE IF NOT EXISTS balance_log (
  ts INTEGER PRIMARY KEY,             -- epoch ms
  balance REAL NOT NULL
);

-- One-shot markers for data migrations that can't be expressed as CREATE TABLE
-- IF NOT EXISTS: backfill_v1 (the cost_log → usage_log backfill),
-- gpu_units_v1 (the per-GPU wipe of gpu_perf and gpu_slots) and
-- cancelled_chunks_v1 (cancelled jobs' open chunks, once written 'failed',
-- become 'cancelled'). Value = epoch ms the migration ran.
CREATE TABLE IF NOT EXISTS history_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-GPU samples behind the Fleet screen's GPU usage graphs (Feature G): one
-- row per GPU per metrics poll (15 s), so that a GPU sitting idle while it has
-- work assigned, which costs money and showed nowhere before, stays visible
-- after the fact. Feature G's metricsHistory holds the last few hours in
-- memory, writes each poll here for longer ranges and restarts, and prunes
-- this table to 7 days.
CREATE TABLE IF NOT EXISTS node_metrics (
  ts INTEGER NOT NULL,                -- epoch ms of the poll
  node_id TEXT NOT NULL,
  gpu_index INTEGER NOT NULL,         -- 0-based, nvidia-smi's order
  -- Null values are a gap, not a zero: the node was unreachable or offline,
  -- and a graph breaks its line there rather than drawing an idle GPU.
  util REAL,                          -- 0-100
  vram_used_gb REAL,
  vram_total_gb REAL,
  power_w REAL,
  runs INTEGER                        -- chunk runs in flight on this GPU at the poll
);
CREATE INDEX IF NOT EXISTS idx_node_metrics_node ON node_metrics(node_id, ts);
-- The fleet-wide graph and the 7-day prune read by time alone.
CREATE INDEX IF NOT EXISTS idx_node_metrics_ts ON node_metrics(ts);

-- Small state that must outlive a restart and has no better home, one row per
-- key. Kept here rather than in settings.json because it belongs to this
-- database's rows: an install id that labels its nodes' instances, holds that
-- stand for its jobs and nodes. Keys (db.ts AppStateKey; a new key is
-- listed here, and needs no change to db.ts):
--   install_id       this profile's random id, carried in every instance
--                    label so the orphan sweep can tell this profile's
--                    instances from another's (plan 1.3)
--   recovery_hold    the start-up recovery hold, so a relaunch does not rent
--                    a full fleet past it (plan 1.9)
--   account_hold     renting paused because Vast credit ran low or out, and
--                    why (plan 1.20)
--   local_sink_hold  the local output disk is full or refuses writes
--                    (ENOSPC, EACCES), and why (plan 1.10, B6)
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                -- the key owner's format; JSON where it has fields
  updated_at INTEGER NOT NULL         -- epoch ms of the last write
);
