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
