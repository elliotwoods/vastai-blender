-- Operational data. Settings/secrets live in settings.json (see settings.ts);
-- this DB is the durable record of jobs/chunks/frames/nodes/costs that lets
-- the app resume cleanly after a restart.

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
  share_node INTEGER NOT NULL DEFAULT 0  -- 0 = exclusive (one chunk per node), 1 = may co-run
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  frame_start INTEGER NOT NULL,
  frame_end INTEGER NOT NULL,
  state TEXT NOT NULL,                -- pending | assigned | rendering | encoding | downloading | complete | failed
  node_id TEXT,
  frames_done INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  assigned_at INTEGER              -- epoch ms of dispatch; null = never assigned
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
  octane_ready INTEGER NOT NULL DEFAULT 0,
  blender_versions TEXT NOT NULL DEFAULT '[]', -- JSON array
  last_error TEXT,
  -- Raw vast.ai offer string, kept verbatim ("Poland, PL" / "US" / "Quebec, CA").
  -- Normalised to a country only at read time, so a parser fix never needs a
  -- backfill. Drives the grid carbon intensity behind the CO2 estimates.
  geolocation TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  chunk_id TEXT,
  kind TEXT NOT NULL,                 -- previewSdr | previewHdr | proxy | frame
  abs_path TEXT NOT NULL UNIQUE,
  fps REAL,
  frames INTEGER,
  width INTEGER,
  height INTEGER,
  codec TEXT,
  hdr INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);

-- Learned render throughput per GPU model (EWMA of frames/hour measured from
-- our own completed chunks) — feeds offer scoring so machine selection
-- improves with every render.
CREATE TABLE IF NOT EXISTS gpu_perf (
  gpu_name TEXT PRIMARY KEY,
  frames_per_hour REAL NOT NULL,
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- Learned concurrency per GPU model: how many chunks ran side-by-side on a
-- node of this GPU before adding more stopped paying (see slotController).
-- Lets a freshly rented node of a known model start near its optimum instead
-- of re-climbing the ramp from 2 every time.
CREATE TABLE IF NOT EXISTS gpu_slots (
  gpu_name TEXT PRIMARY KEY,
  best_slots INTEGER NOT NULL,
  frames_per_hour REAL NOT NULL,      -- aggregate node throughput measured at best_slots
  samples INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
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
-- without rendering, so SUM over a node's rows is its true spend and the NULL
-- rows are exactly the idle/provisioning overhead.
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
-- IF NOT EXISTS (currently just the cost_log → usage_log backfill).
CREATE TABLE IF NOT EXISTS history_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
