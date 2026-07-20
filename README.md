# Vast Render

A desktop app (Electron) that renders Blender projects on [Vast.ai](https://vast.ai)
GPU fleets. Point it at a `.blend`, and it rents the best-value machines,
provisions them (matching Blender version, ffmpeg, render agent), splits the
animation into frame chunks across the fleet, streams frames and HDR preview
clips back to your disk as they finish, and destroys the machines when done.

Vast.ai rents time on other people's GPU machines — typically far cheaper than
dedicated cloud render farms. This app automates the whole lifecycle from an
API key: no manual SSH, no third-party file sync.

## Features

- **Fleet rendering** — set a max node count and a spend cap; jobs are split
  into frame chunks and distributed. Failed machines are replaced and only
  missing frames re-render.
- **Engines** — Cycles (OptiX/CUDA, all GPUs), EEVEE (per-node capability
  probe), Octane (see `docs/OCTANE.md`).
- **Automatic Blender version matching** — the app reads each `.blend`'s
  header and installs the matching Blender release on the nodes
  (side-by-side per version; override in Settings).
- **Direct, verified transfers** — scenes go up and frames come down over the
  instance's own SSH (SFTP, SHA-256 verified, resumable). No Dropbox, no
  cloud bucket, no credentials on untrusted machines.
- **Remote preview encodes** — each chunk is encoded on the node to H.265:
  SDR, 10-bit HLG BT.2020 **HDR**, and a small proxy — all All-Intra for
  frame-exact scrubbing.
- **Gallery** — a video wall of preview clips with a frame-exact transport
  (timecode, frame stepping, draggable playhead), exposure/grade controls,
  HDR passthrough on HDR displays, and click-to-open into Explorer for every
  frame, clip and folder.
- **Extensions** — register Blender extension zips (Blender 4.2+ manifest
  format) in Settings; they're uploaded and enabled on nodes per job. Scenes
  can also carry `startup*` text blocks, executed before rendering.
- **Cost control** — live $/hr, per-node accumulated cost, account balance,
  idle timeout auto-destroy, spend cap, and boot-time reconciliation that
  destroys any orphaned instances this app created.

## Setup

```bash
npm install
npm run dev          # development
npm run build:win    # packaged build
```

If `npm run dev` reports "Electron uninstall", the Electron binary download
was interrupted — see `docs/hdr-notes.md` for the manual fix.

In the app: **Settings → Vast.ai API** — paste your API key (from
[cloud.vast.ai](https://cloud.vast.ai) → account). It is stored encrypted with
your OS user credentials (DPAPI). An SSH keypair is generated automatically on
first use and registered with your Vast.ai account.

Then **Jobs → new render**: pick `.blend` file(s), engine, frame range —
done. Nodes start automatically while there's queued work.

Pack your textures into the `.blend` (File → External Data → Automatically
Pack Resources) — only the `.blend` file itself is uploaded.

## How machines are chosen

Offers are ranked by `perf-per-dollar × reliability² × network`, where
perf-per-dollar prefers **your own measured render throughput** for a GPU
model (learned from completed chunks) over Vast's synthetic benchmark. The
strategy is documented in `src/main/vast/offers.ts`. Filters (GPU allowlist,
max $/hr, min VRAM/network/reliability) live in Settings → Offer filters.

## Repository layout

- `src/main` — Electron main process: Vast.ai client, SSH/SFTP, node
  lifecycle, scheduler, settings, SQLite state.
- `src/renderer` — the UI (React + TypeScript).
- `src/shared` — the typed IPC contract shared by both.
- `remote/` — scripts that run **on the nodes** (provisioning, render agent,
  preview encoder). Uploaded verbatim over SFTP; stdlib Python + bash only.
- `docs/` — setup notes, Octane specifics, HDR/codec findings.

## Notes

- The render output contract for previews assumes linear Rec.709 EXR
  (Blender's `Standard` view transform); scenes rendering to PNG/JPG still
  work but get SDR previews only.
- License: this repo previously bundled a GPL-licensed Dropbox uploader,
  which set the repo license; that bundle is gone, so the license can now be
  revisited.
