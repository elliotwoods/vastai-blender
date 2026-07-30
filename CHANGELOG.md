# Changelog

All notable changes to Vast Render are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/): the version in `package.json` is
the source of truth, each release is tagged `vX.Y.Z`, and tags are published as
GitHub Releases with the notes from this file.

- **major** — a rewrite, or a change that invalidates existing state (settings
  file, SQLite schema, on-node layout) without a migration.
- **minor** — new capability: a screen, an engine, a scheduler behaviour.
- **patch** — fixes and refinements to what is already there.

## [Unreleased]

## [2.1.0] — 2026-07-30

### Added

- **Watch a chunk render** — a full-window preview overlay, opened from Fleet,
  Jobs, Job detail or Gallery and closed back onto an intact screen. It carries a
  frame-accurate transport (space, arrow-key stepping, `[`/`]` to walk chunks), a
  thumbnail filmstrip across the whole job, and a histogram. Frames from a chunk
  that started ten seconds ago show as a still until the first clip exists, so
  there is always something to look at.
- **Live preview clips, built on the node as it renders** — the agent encodes
  each finished frame into a single-frame All-Intra HEVC access unit and appends
  it to one stream, so a playable clip grows frame by frame instead of waiting
  for the chunk to finish. Costs one encode per frame rather than re-encoding the
  chunk-so-far on every emission. Off, on-demand (only while someone is
  watching) or always, in Settings.
- **Per-frame thumbnails** — render output is usually EXR, which no browser can
  decode; the node now ships a small JPEG per frame so the UI has an image before
  any clip is encoded.
- **Grading, on the GPU** — exposure/contrast/saturation/lift applied by a WebGL
  shader, with HDR (HLG) passthrough on a capable display. The shader is verified
  against a `CanvasRenderingContext2D.filter` reference across a 12-grade sweep
  (`?screen=gradelab`), within 3 LSB; see `docs/hdr-notes.md`.
- **History screen** — spend, account balance, fleet GPU draw and fleet size over
  1d/7d/30d/all, with the range's totals and the jobs that cost the most. Backed
  by new persisted tables (`usage_log`, `balance_log`), so energy and utilisation
  survive a restart instead of being a session figure held in memory. Existing
  `cost_log` history is imported once on upgrade — those rows carry no job
  attribution or energy, because neither was recorded then, and show as
  "unattributed" rather than being quietly dressed up.
- **Fleet node workload panel** — what each node is rendering right now, its
  slots in use vs target, and %GPU/%VRAM/%CPU/%RAM meters.
- **CO₂ behind every energy figure** — hovering any Wh readout now also gives an
  estimated carbon cost and an everyday equivalent ("≈ 1.4 × a full hot bath",
  "≈ 2.1 × a one-way flight London–New York"), on the History power chart, the
  range totals, each job's energy in the top-jobs table, the toolbar session
  readout and the Fleet node panel. The comparison ladder is spaced two to three
  anchors per order of magnitude from a phone charge to a person's annual
  footprint, so the multiplier always stays readable.
- **Per-country grid intensity** — vast.ai reports where a machine is, and the
  app now records it (`nodes.geolocation`, schema v4) instead of discarding it,
  so a render in Norway (~30 gCO₂e/kWh) is not costed like one in Poland
  (~660). Nodes rented before this, and locations that don't resolve, fall back
  to a world average and say so. No backfill is possible — vast.ai does not
  report an instance's location after the fact.
- Settings: **CO₂ overhead factor** (default 1.6) scales measured GPU watts to a
  whole-machine estimate for the carbon figures — host CPU, PSU losses and
  datacentre cooling, none of which `nvidia-smi` sees. Energy readouts in Wh are
  never scaled by it.
- **Per-job node sharing** — jobs carry a `shareNode` flag, set on the submit
  dialog, toggled later from the job screen, or given in a `VR_JOB_SPEC`
  campaign (per campaign or per blend). Flagged jobs may render several chunks
  side by side on one node, mixed with other flagged jobs; unflagged jobs keep
  a node to themselves one chunk at a time, exactly as before. For scenes that
  leave a machine under-used — a long single-threaded CPU step before each
  frame reaches the GPU — this is the difference between renting one node per
  job and packing several onto one.
- **Auto-judged concurrency** — the app now decides how many chunks a node
  runs at once instead of applying one number to the whole fleet. A hardware
  ceiling (threads, VRAM, RAM) bounds it; within that, each node hill-climbs
  on measured frames/sec and stops when another slot stops paying, or backs
  off immediately under memory pressure. Where a node settles is remembered
  per GPU model in the new `gpu_slots` table, so later nodes start near the
  answer. The Fleet detail shows slots in use vs target.
- **Recovered work no longer starts a fleet on its own** — opening the app on a
  profile with a half-finished campaign used to rent up to _Max active nodes_ on
  the first scheduler tick, before you had seen a screen. Unfinished chunks are
  still recovered, but renting waits behind a "Resume rendering" prompt whenever
  more than one node is configured. Dispatch to nodes already running, scale-down
  and the manual _add node_ button are unaffected.
- Tooltips throughout: the figures that rest on an assumption (CO₂, grid
  intensity, metered vs billed spend, slot targets) now say so where they appear.

### Changed

- Settings: _Render slots per node_ is now _Max render slots per node_ — a
  cap on the auto-judged value, blank for none. A previously configured value
  above 1 carries over as the cap; the old default of 1 does not, so upgrading
  does not pin every node to a single slot.
- `gpu_perf` throughput samples are scaled by the concurrency a chunk ran
  under, so packing a node no longer teaches offer ranking that its GPU is
  slow.
- The node agent enforces exclusivity itself as a backstop, so a spec arriving
  as a node drains cannot end up co-running with an exclusive chunk.
- The History _fleet_ series now reports **mean nodes running concurrently**,
  counted per minute and then averaged, instead of distinct node ids seen
  anywhere in the bucket. The old figure counted machines recycled through a
  bucket, so a two-node fleet cycling every 15 minutes read as ~24 on a 6-hour
  bucket while node-hours beside it read correctly. **Expect this number to be
  lower than before** — nothing was lost, it was over-counted. "Peak nodes" is now
  the true range-wide maximum.

### Fixed

- **Destroying a node stranded its work.** In-flight chunks were never aborted:
  they polled a closed SSH connection every 5s for the life of the process, their
  rows stayed `rendering` against a node that no longer existed, and the job never
  finished. They are now requeued onto a surviving node, re-split around the
  frames that did land.
- **Idle nodes were never destroyed.** The slot controller's per-node bookkeeping
  left an empty entry behind for every node it inspected, which read as "still
  busy" forever — so scale-down skipped the node and it billed until the app was
  closed. Found by watching a real rented node sit idle.
- **A node that went unreachable mid-render kept billing** until the next app
  start's orphan sweep — indefinitely if the app stayed open — because nothing
  destroyed it, scale-down ignored `failed` nodes, and cost accrual stopped
  metering it, hiding the leak.
- **Memory pressure collapsed a node to one slot.** The backoff had no cooldown,
  so it fired on every 15s tick while the renders that caused the pressure were
  still running; a node happily using six slots walked down to one in ~75s and
  stayed pinned there. It now steps once per settle period, and a safety backoff
  no longer teaches `gpu_slots` a throughput it measured at a higher slot count.
- **A transient download failure lost a frame silently.** On the final drain there
  is no later poll to retry, so the file was dropped and the chunk still reported
  complete. Failed transfers are retried within the drain, and frames that truly
  cannot be fetched now fail the chunk so only the missing frames re-render.
- **Cancelling a job during node preparation started the render anyway.** A
  cancel during a multi-minute Blender install or scene upload was not noticed
  until after the spec had been written, so the agent rendered a cancelled chunk,
  the row flipped back to `rendering`, and a frame downloader was left polling
  forever. Preparation now checks after every step and withdraws the spec.
- **Live preview stream corruption.** Restarting the agent mid-chunk appended a
  second copy of every frame to the append-only stream, and re-emitted clip
  filenames the app had already downloaded. Closing and reopening the preview left
  a permanent hole, so clip frame indices stopped matching real frame numbers.
- The live-preview backfill fed ffmpeg any file in `frames/`, including one
  Blender was still writing and truncated leftovers from a killed render — and a
  single failure disabled thumbnails and previews for the whole chunk. It now
  encodes only frames the manifest has accepted, and tolerates isolated failures.
- The node agent's state heartbeat and its render loop raced on one temporary
  filename, which could kill the heartbeat (silently ending the anti-stall
  refresh) or fail a healthy chunk.
- Playback froze at frame 0 whenever a rolling live clip rolled to a new version,
  and the playhead jumped back to the start when a chunk finished and its
  definitive clip replaced the live one.
- The HDR passthrough toggle never appeared in the preview overlay, because it was
  gated on the clip being shown rather than on an HDR rendition existing — and the
  SDR one is deliberately preferred until HDR is switched on.
- **`media://` never served byte ranges**, so no paused seek ever moved the
  picture — scrubbing, arrow-key stepping and opening at a frame all updated the
  transport while the image stayed on frame 0. The handler fetched by URL and
  dropped the request's `Range` header, always answering with the whole file;
  Chromium will not seek a resource whose server shows no range support, so it
  accepted `currentTime` and immediately reset it to 0. Ranges are now served
  directly, with `206`/`Content-Range`, and the clip being inspected preloads
  (the gallery wall deliberately still does not).
- Clicking a frame in the filmstrip opened the preview at frame 0 instead of at
  that frame.
- The CO₂ tooltip promised on the History range totals was computed but never
  attached to the tiles.

### Notes

- Schema version 2 adds `jobs.share_node`; version 3 adds `chunks.assigned_at`
  and `frames.thumb_path`; version 4 adds `nodes.geolocation`. Existing databases
  are migrated in place on first launch; each step is guarded by the column's
  actual presence, so a database that predates the version bookkeeping converges
  either way. Existing jobs default to exclusive.
- The same migration creates the history tables (`usage_log`, `balance_log`,
  `history_meta`) and `gpu_slots`, and performs the one-time `cost_log` →
  `usage_log` import described above.
- Existing node rows keep a null location, so energy already recorded is costed at
  the world-average grid intensity — the per-country figures only apply to nodes
  rented from here on. No backfill is possible: vast.ai does not report an
  instance's location after the fact.
- `remote/agent/selfcheck.py` covers the agent behaviour that unit tests cannot
  reach (state-file writes under threads, the live-stream backfill and gap fill).
  Run it with any Python 3 after touching `noderunner.py`.

## [2.0.0] — 2026-07-27

First release of the Electron app. Version 1 was a set of Python scripts that
pushed frames through Dropbox; nothing carries over — new settings, new state,
new on-node agent.

### Added

- **Desktop app** — Electron + React + TypeScript, with a typed IPC contract
  shared by main and renderer, and SQLite for job/chunk/node state.
- **Fleet management** — rents Vast.ai instances against your filters (GPU
  allowlist, max $/hr, min VRAM/network/reliability), provisions them
  (Blender, ffmpeg, render agent), and destroys them when idle. Max node count
  and spend cap are enforced by the scheduler; orphaned instances are
  reconciled and destroyed at boot.
- **Chunked scheduling** — animations are split into frame chunks and spread
  across the fleet; failed machines are replaced and only missing frames
  re-render. `nodeSlots` runs several Blender processes per node, with the
  per-node preparation steps serialized so they can't race.
- **Engines** — Cycles (OptiX/CUDA), EEVEE with a per-node capability probe,
  and Octane (see `docs/OCTANE.md`).
- **Automatic Blender version matching** — the `.blend` header decides which
  Blender release is installed on the node, side by side per version, with an
  override in Settings.
- **Direct transfers** — scenes up and frames down over the instance's own
  SSH (SFTP, SHA-256 verified, resumable). No third-party file sync.
- **Remote preview encodes** — every chunk is encoded on the node to All-Intra
  H.265: SDR, 10-bit HLG BT.2020 HDR, and a small proxy.
- **Gallery** — a video wall with a frame-exact transport, exposure/grade
  controls, HDR passthrough on capable displays, and click-to-open into
  Explorer for any frame, clip or folder.
- **Extensions** — register Blender extension zips (4.2+ manifest format);
  they are uploaded and enabled per job. Scenes may also carry `startup*` text
  blocks, executed before rendering.
- **Node telemetry** — live %GPU, %VRAM, %CPU (from `/proc/stat` deltas, not
  load average), %RAM, GPU power draw in watts, and energy in Wh integrated
  per node; the toolbar shows session spend alongside session energy.
- **Node panel** — expanding a fleet row shows gauges, identity (GPU, vast
  instance, ssh endpoint), cost and energy, the chunk being rendered with a
  link to its job, capability chips, errors, and a live console tail. An
  **ssh** button opens a terminal onto the node using the app's own key;
  clicking the endpoint copies the command instead.
- **Cost control** — live $/hr, per-node accumulated cost and realised $/hr,
  Vast.ai balance, idle-timeout auto-destroy and a fleet spend cap.
- **Headless driver** — `VR_JOB_SPEC=<spec.json>` submits a whole campaign at
  boot (blend list or directory, per-blend frame overrides, engine, addons,
  fleet size, offer-filter overrides) and heals partially complete jobs
  instead of duplicating them.

### Notes

- Preview encoding assumes linear Rec.709 EXR output (Blender's `Standard`
  view transform). Scenes rendering to PNG/JPG still work but get SDR
  previews only.
- Energy totals are in-memory for the session; they reset when the app
  restarts. Cost totals are persisted in SQLite.

[Unreleased]: https://github.com/elliotwoods/vastai-blender/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/elliotwoods/vastai-blender/releases/tag/v2.0.0
