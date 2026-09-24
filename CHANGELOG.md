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

### Added

- **Alerts reach you.** The main process raises alerts from about 25 places,
  every "destroy failed — check the Vast.ai console" among them, and nothing
  in the window listened. Info and warnings now show as toasts. Errors and
  billing risks (a failed destroy, an instance left running) stay in a banner
  until dismissed, billing risks first, with a link to the Vast.ai console.
  Errors and billing risks raised before the window opened, or while it was
  closed, are shown when it opens, as are info and warnings from the last
  minute. An alert that repeats every tick is one entry. A new error raises an
  OS notification while the window is in the background. Dismissals survive
  closing and reopening the window.
- **CI.** Every push and pull request runs both typechecks, eslint, vitest, the
  node agent's self-check, and `py_compile` / `bash -n` over `remote/`, which
  is uploaded verbatim to nodes and was never checked before. `npm test` now
  runs the self-check before vitest, so it needs `python3`.
- **Tests for the code that spends money.** A lifecycle harness
  (`src/main/test/harness.ts`) runs the real node manager and scheduler against
  an in-memory database built by the real migrations, a scriptable fake Vast.ai
  API, fake machines behind a fake SSH connection, and fake timers. Renting,
  provisioning, dispatch, download and destroy had no tests before. To make
  that possible the event bus moved out of `ipc.ts` into `events.ts`, which
  does not import Electron.
- **Whole-job preview clips.** A job split across a wide fleet in small chunks
  used to preview as hundreds of clips a few frames long, each ending before
  it could be watched. The desktop now stitches finished chunks' clips into one
  clip per job and rendition, using `ffmpeg -c copy` with no re-encode. It
  rebuilds about 20 s after chunks complete, and at once when the job ends.
  Chunks not finished yet are gaps, and the clip records which job frames it
  holds (`assets.segments`, schema v5). ffmpeg now ships with the app
  (`ffmpeg-static`); without it, previews stay per-chunk as before.

- **One render per GPU on multi-GPU nodes.** A node with N GPUs used to run one
  Blender with every GPU enabled, so every GPU sat idle during each frame's
  serial CPU work (scene sync, BVH build, geometry nodes). Now each GPU renders
  its own chunk, pinned with `CUDA_VISIBLE_DEVICES`. This applies to jobs that
  don't share nodes too: for those, one GPU is the unit of exclusivity, not the
  whole machine. Settings → General → *Render slots per GPU*: 1 (default), 2
  (overlaps sync with sampling on the same GPU), or off (the old behaviour).
  `enable_gpu.py` enables only the pinned card, and only on the chosen backend,
  since each GPU is listed once as CUDA and once as OptiX. The Fleet node panel
  shows a bar per GPU and which GPU each slot is pinned to. A memory guard
  drops a lane when RAM or VRAM passes 90%. `VR_JOB_SPEC` takes `slotsPerGpu`.
- **Min GPUs per node** offer filter (`offerFilters.minNumGpus`, also in
  Settings → Offer filters). Settings → Offer filters also gains *Min CPU
  cores*, *Min disk* and *CPU-bound*, which could previously only be set from
  a spec.

### Changed

- **Docs and tooltips say what the app does.** The README gains a *Safety
  model* section (quitting and sleep, restarts, the spend cap, instance labels,
  one app per profile, alerts), and its scene-preparation advice now covers
  linked libraries and simulations, not only textures. Claims corrected there
  and in tooltips: `VR_MOCK` mocks only reads, and its actions reach the real
  fleet; the spend cap limits only automatic scale-up, and checks the fleet's
  current rate, not the next machine's price; the node panel's *actual* $/hr,
  now labelled *metered ÷ uptime*, settles at about the quote but reads up to
  about a third over when it first shows, since the meter charges whole
  minutes; the toolbar's spend is all-time, so its pill now reads *total*
  rather than *session*, while its energy counts since launch; and an app
  restart re-renders each in-flight chunk's whole range rather than
  re-attaching to it. `docs/OCTANE.md` no longer points to a VNC tunnel button
  the node panel does not have, and says that saved OTOY credentials can be
  read by the machine's host.
- **Two earlier entries overclaimed.** 2.1.0's fix for "a node that went
  unreachable mid-render kept billing" covers only a node found unreachable
  when the app starts: nothing checks a node's reachability during a session
  yet. 2.0.0's "realised $/hr" is the node panel's metered spend ÷ uptime, an
  estimate from the quoted rate, not a rate vast.ai billed.
- **Faster fleet ramp.** Scale-up rents several nodes per 15 s tick (up to 8,
  from one offer search) instead of one, still bounded by *Max active nodes*
  and the spend cap. A 30-node fleet is now requested in about a minute rather
  than 7.5. Demand now subtracts capacity that is still booting, so a short
  queue no longer keeps renting while its first nodes boot.
- Offer ranking treats measured throughput (`gpu_perf`) and learned slot counts
  (`gpu_slots`) as **per GPU**. Both tables are keyed by GPU model, and 1-GPU
  and 4-GPU nodes of the same model used to overwrite each other's node totals.
  Existing rows are read as per-GPU figures, which is correct for rows learned
  on 1-GPU nodes.
- The preview overlay plays the whole job when the frame you open is in the job
  clip. `[`/`]` and the filmstrip seek within it rather than reopening per
  chunk. Frames that aren't stitched yet (a chunk still rendering) fall back to
  the per-chunk live view.
- The Gallery shows one tile per job when a job clip exists; **chunks** switches
  back to the per-chunk wall.

### Removed

- `electron-store`, `react-window` and `@electron-toolkit/preload`. Nothing
  imported them, but they were packed into `app.asar`.

### Fixed

- **A crashed or killed Blender could deliver a truncated frame.** After
  Blender exited, whatever its exit code, the agent adopted any size-stable
  file in `frames/`. The frame a crashed, out-of-memory or `pkill`ed Blender
  was writing went into the manifest with a hash over the truncated bytes, the
  app verified the download against that same hash, and the frame shipped as
  part of a "complete" job. Unannounced files are now adopted only after a
  clean exit, only on the chunk's frame grid, and only if this attempt wrote
  them. Before each attempt, files the manifest does not list are deleted.
- **Destroying a node while it was being rented left the instance billing,
  unseen.** A destroy before Vast.ai returned the instance id marked the node
  destroyed, and the instance then billed with nothing showing it until the
  next launch. A destroy during the first SSH connection or provisioning could
  be overwritten: the node was marked `failed` and its healthy machine
  blacklisted, or it came back as `provisioning`. The instance is now destroyed
  whichever step the destroy lands in. If that destroy fails, the node is left
  `failed` with a "check the Vast.ai console" alert, for Fleet's *clear
  failed* or the launch sweep to retry. One case remains: a destroy while the
  rent request is in flight, when that request then fails without a clear
  refusal (a timeout, a 5xx), may have created an instance whose id never
  came back. The node is left `failed` with a billing-risk alert, and only the
  launch sweep finds that instance (plan 1.4 resolves it by label).
- **Chunks were rendered twice.** Destroying a node while a chunk was being
  prepared on it (a Blender download, a scene upload) requeued the chunk, which
  was dispatched again at once. The abandoned preparation then failed on the
  closed connection, requeued the chunk its successor now owned and dropped the
  successor's bookkeeping, so the next tick dispatched it a third time while
  the successor was still rendering it: the same frames, billed twice. An
  abandoned run now writes nothing. Cancelling a job during a chunk's final
  download no longer puts the chunk back in the queue, and the cancel now shows
  in the Jobs list.
- **A chunk could complete without all its frames.** The final download pass
  read the manifest once and took a failed read for an empty one, so frames
  listed since the last good poll were never fetched, and idle scale-down then
  destroyed the only copy. The final read is now retried (after 5, 10 and
  20 s), and a read that never succeeds fails the chunk. A chunk completes only
  when every frame in its range is downloaded, and a job only when all of its
  frames are (otherwise it ends `partial`). Missing frames go through requeue,
  which re-renders just those.
- **A chunk size of 0 hung the app.** Zero, or a negative chunk size or step,
  sent frame splitting into an endless loop in the main process. The UI froze,
  and the scheduler and idle scale-down stopped, while the fleet kept billing.
  A `VR_JOB_SPEC` campaign took the same path. A fractional step stored frames
  Blender never renders, and an end before the start made a job that stayed
  queued forever. `createJob`, which the dialog and `VR_JOB_SPEC` both use, now
  refuses these with a message, and the dialog lists the problems as you type
  and disables *Submit*.
- **A second launch on the same profile wrecked the first.** Its boot
  re-provisioned every live node, killing the first process's renders, reset
  every in-flight chunk to pending, and then two schedulers rented against two
  separate spend caps. Now only one app runs per profile: a second launch
  focuses the running window, and a headless one (`VR_JOB_SPEC`,
  `VR_E2E_BLEND`) exits with status 1 and submits nothing. `VR_USERDATA`
  profiles still run alongside the real one.
- **The launch sweep destroyed other installs' fleets.** It destroyed every
  `vastai-blender` instance this profile did not track, so a second install on
  the same account (a packaged app and a dev build, or a `VR_USERDATA`
  profile) killed the first one's live nodes at launch. It now destroys only
  instances this profile rented, and leaves any other running with a warning.
- **Provisioning could stall for good on a slow download.** A server that
  trickled instead of failing hung the static ffmpeg download, which blocks
  base provisioning while the node bills, and left the background NVIDIA driver
  download running for the node's whole life. Both now give up below 100 kB/s
  for 60 s, and have a time limit per attempt and overall. The Blender download
  has the same stall guard, retries every kind of error rather than only some,
  falls back through three mirrors, and checks the archive before extracting.
- **Healthy nodes were thrown away on boot.** vast.ai reports an instance as
  running before sshd inside it listens, and one refused connection failed and
  destroyed the node. In one 53-node run, 23 nodes were replaced this way. The
  first connection now retries with backoff for up to 3 minutes, re-reading
  the instance's endpoints each round. A host-key mismatch still fails at once.
- **Stalled downloads pinned nodes forever.** A transfer that stopped mid-file
  (4 frames at ~200 KB in one run) never completed or failed. Its chunk stayed
  'downloading' and kept its node rented. Transfers now fail after 60 s
  without data, reset the SFTP channel, and resume from the partial file on
  retry. The final download pass is bounded at 10 minutes. Frames still
  missing after that go through requeue, which re-renders only those frames.
  Manifest and agent-state reads are also timed out.
- The Fleet *max nodes* stepper clamped at 16, so one click on "−" shrank a
  spec-configured 30-node fleet to 16. The limit is now 64 there and in
  Settings.
- The agent's slot ceiling counted only GPU 0's VRAM, but the app counts every
  GPU. On multi-GPU nodes the two disagreed.
- **Graded previews were cropped.** The grading canvas kept its intrinsic size
  (the video's native resolution) instead of filling its tile. A 1920×1080
  clip in a smaller tile therefore showed only its top-left corner.

### Security

- **A rented node could write files anywhere on your computer.** The app saved
  each downloaded file at the job folder joined with the name in the node's
  manifest, unchecked, so a name like `../../…` put a file wherever you can
  write, a login item say. Root on the rented machine was enough, and so was a
  startup script inside a `.blend`. Manifest entries must now look like what
  the agent writes (`frames/NNNN.ext`, `thumbs/NNNN.jpg`,
  `previews/<chunk>_*.mp4`) and carry a SHA-256 and a size under a cap, and
  every path a node names goes through one `resolveInside()` check. A refused
  frame counts as lost and re-renders, with one alert per chunk. Job-clip
  stitching refuses paths that could slip a directive into ffmpeg's concat
  list.
- **The window could be steered into running programs.** Opening a file ran
  whatever path the window asked for, and on Windows that runs an `.exe` or
  `.bat`; frame names come from rented nodes. Links of any scheme went to the
  operating system, and nothing stopped the window navigating away from the
  app with the fleet controls still attached. The renderer is now sandboxed.
  Only http(s) links leave the app, in your browser, and navigation away from
  the app's page is blocked. A file opens only if it is a folder, image or clip
  inside the project or a job's folder; other files there are revealed in
  Explorer/Finder instead, and anything else is refused. The content security
  policy also rules out plugins, `<base>` and forms.

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
