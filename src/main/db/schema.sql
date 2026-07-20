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
  submitted_at INTEGER NOT NULL       -- epoch ms
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  frame_start INTEGER NOT NULL,
  frame_end INTEGER NOT NULL,
  state TEXT NOT NULL,                -- pending | assigned | rendering | encoding | downloading | complete | failed
  node_id TEXT,
  frames_done INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_job ON chunks(job_id);
CREATE INDEX IF NOT EXISTS idx_chunks_state ON chunks(state);

CREATE TABLE IF NOT EXISTS frames (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  frame INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  state TEXT NOT NULL,                -- pending | rendered | downloaded
  local_path TEXT,
  size_bytes INTEGER,
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
  last_error TEXT
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

CREATE TABLE IF NOT EXISTS cost_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                -- epoch ms
  dph_total REAL NOT NULL,
  delta_cost REAL NOT NULL
);
