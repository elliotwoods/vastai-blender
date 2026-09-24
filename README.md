# Vast Render

A desktop app (Electron) that renders Blender projects on [Vast.ai](https://vast.ai)
GPU fleets. Point it at a `.blend`, and it rents the best-value machines,
provisions them (matching Blender version, ffmpeg, render agent), splits the
animation into frame chunks across the fleet, streams frames and HDR preview
clips back to your disk as they finish, and destroys the machines when done.

Vast.ai rents time on other people's GPU machines — typically far cheaper than
dedicated cloud render farms. This app automates the whole lifecycle from an
API key: no manual SSH, no third-party file sync.

![Fleet screen](docs/screenshots/fleet.png)

*The fleet: one row per rented machine with live %GPU, %VRAM, %CPU, %RAM,
watts, $/hr and accumulated cost. Expanding a row shows the full node panel —
gauges, ssh access, what it's rendering, and its console.*

## Features

- **Fleet rendering** — set a max node count and a spend cap; jobs are split
  into frame chunks and distributed. Failed machines are replaced and only
  missing frames re-render.
- **Node sharing** — tick *Share node* on a job whose renders leave the
  machine under-used (a long CPU step before each frame, say) and its chunks
  run alongside other renders instead of taking a whole node each. The app
  measures throughput per node and tunes the number of concurrent renders on
  its own; *Max render slots per node* in Settings caps it if you want.
- **Per-GPU render slots** — on a multi-GPU node each GPU renders its own
  chunk (pinned with `CUDA_VISIBLE_DEVICES`), so per-frame CPU work such as
  scene sync doesn't idle the other GPUs. One or two slots per GPU, or off, in
  Settings; *Min GPUs per node* in the offer filters.
- **Engines** — Cycles (OptiX/CUDA), EEVEE (per-node capability
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
- **Whole-job preview** — as chunks finish, the desktop stitches their preview
  clips end to end (a lossless remux, no re-encode) into one clip per job. However
  finely a job is chunked across the fleet, it plays and scrubs as one clip;
  chunks still rendering show as gaps you can click into to watch live.
- **Gallery** — a video wall of preview clips with a frame-exact transport
  (timecode, frame stepping, draggable playhead), exposure/grade controls,
  HDR passthrough on HDR displays, and click-to-open into Explorer for every
  frame, clip and folder.
- **Extensions** — register Blender extension zips (Blender 4.2+ manifest
  format) in Settings; they're uploaded and enabled on nodes per job. Scenes
  can also carry `startup*` text blocks, executed before rendering.
- **Live telemetry** — %GPU, %VRAM, true %CPU (from `/proc/stat` deltas, not
  load average), %RAM, GPU watts, and Wh of energy per node.
- **Cost control** — live $/hr, per-node metered spend, total spend and this
  session's energy, account balance, idle-timeout auto-destroy while the app
  runs, a spend cap on automatic scale-up, and a sweep at launch that destroys
  instances this profile rented but lost track of. All of it has limits; see
  [Safety model](#safety-model).

## Install and run

Prebuilt Windows installer:
[latest release](https://github.com/elliotwoods/vastai-blender/releases/latest).
It is unsigned, so SmartScreen will ask for a confirmation on first run.

From source:

```bash
npm install
npm run dev          # development (Vite + Electron, hot reload)
npm run build:win    # packaged Windows build (electron-builder)
npm test             # node agent self-check (needs python3), then unit tests
npm run typecheck    # main + renderer type checks
```

CI (`.github/workflows/ci.yml`) runs both typechecks, eslint, the unit tests,
the agent self-check and syntax checks over `remote/` on every push and pull
request. None of it needs Electron, a GPU or a Vast.ai account.

If `npm run dev` reports "Electron uninstall", the Electron binary download
was interrupted — see `docs/hdr-notes.md` for the manual fix.

## First run

1. **Settings → Vast.ai API** — paste your API key (from
   [cloud.vast.ai](https://cloud.vast.ai) → Account). It's stored encrypted
   with your OS user credentials (DPAPI on Windows). An SSH keypair is
   generated on first use and registered with your Vast.ai account.
2. **Settings → General** — set the project root (where renders land), max
   active nodes, spend cap ($/hr), idle timeout, and (optionally) a cap on
   render slots per node — leave it blank to let the app judge concurrency.
3. **Settings → Offer filters** — GPU allowlist, max $/hr, minimum
   VRAM/network/reliability. Turn on *CPU-bound* for scenes whose frame time
   is dominated by CPU work, so ranking stops favouring premium datacenter
   GPUs.
4. **Settings → Extensions** *(optional)* — register any Blender extension
   zips your scenes need.

![Settings](docs/screenshots/settings.png)

## Rendering a job

Only the `.blend` itself is uploaded; nothing it references on your disk
reaches the node. Before submitting:

- **Pack what can be packed**: File → External Data → Pack Resources (images,
  fonts, volumes), plus Pack Linked Libraries for linked `.blend` files, which
  Pack Resources and its *Automatically* toggle leave out.
- **Bake simulations** (rigid body, cloth, particles, simulation nodes) and
  keep the bake inside the file, not in a disk cache. Each chunk renders in a
  fresh Blender starting at the chunk's first frame, so an unbaked simulation
  starts cold in every chunk after the first, and in every chunk when the step
  is above 1. A chunk size covering the whole range renders it in one go, but a
  retry after a failure restarts part-way through, cold.
- Image sequences, movie clips, Alembic/USD caches and files over 2 GB cannot
  be packed, so scenes that need them are not supported yet.

Nothing checks for any of this before the fleet starts. A missing texture
renders magenta, and those frames complete and are billed like any other.

**Jobs → new render**: pick `.blend` file(s), the engine, the frame range and
step, optionally the extensions to enable and a chunk size (blank = the
scheduler picks one so each node gets ~3 chunks). Submit.

![Jobs screen](docs/screenshots/jobs.png)

From there it is automatic: nodes start while there's queued work, chunks are
dispatched, frames download as they are rendered, and nodes are destroyed
once they've been idle past the timeout, as long as the app is running (see
[Safety model](#safety-model)). A job page shows per-chunk state and the live
console; the Gallery shows the preview clips as they arrive.

Useful controls while a job runs:

- **Fleet → max nodes** — raise it and the scheduler rents toward it while
  there's work and the spend cap allows. Lowering it only stops new rentals:
  nodes already running stay until they idle out or you destroy them.
- **Fleet → + request node** — add one machine now. It counts against max
  nodes but ignores the spend cap.
- **Fleet → row → ssh** — open a terminal on that machine using the app's own
  key (clicking the ssh endpoint copies the command instead).
- **Fleet → row → destroy** — kill a bad machine; its chunks are re-queued.
- **Jobs → cancel** — stop dispatching and stop the job's renders on the
  nodes; frames already downloaded are kept.

## Safety model

Rented machines bill by the hour whether or not they render. What the app
does about that, and what it doesn't:

- **Quitting leaves the fleet billing.** Quitting the app (on Windows and
  Linux, closing its window) does not destroy nodes, and nothing on a node
  shuts it down. They bill until you open the app again and they idle out, or
  until you destroy them. Before you quit, set **Fleet → max nodes** to 0 (or
  cancel every unfinished job), then destroy each node. Otherwise their chunks
  go back to the queue and, within seconds, the scheduler rents replacements
  to render them. Check the
  [Vast.ai console](https://cloud.vast.ai/instances/) afterwards. Sleep is the
  same: nodes keep billing and nothing is metered until the computer wakes.
- **A restart re-renders in-flight work.** On launch the app re-provisions
  every node it can reach, which kills the renders running there. Each chunk
  that was in flight goes back to the queue and renders its whole frame range
  again. When any chunk was in flight and max nodes is above 1, renting waits
  behind a *Resume rendering* prompt; a queue with nothing in flight rents
  straight away.
- **The spend cap limits automatic scale-up only.** It stops renting once the
  fleet's combined quoted $/hr reaches the cap. It doesn't count the price of
  the machine about to be rented, so the last rental can go over, and
  *+ request node* ignores it. Rates are the quotes at rent time, not vast.ai's
  invoice.
- **Instance ownership.** Each instance is labelled `vastai-blender` followed
  by the first 8 characters of its node's id. At launch the app destroys any
  instance with such a label that this profile rented but no longer tracks,
  such as one whose destroy failed. An instance another profile or install
  rented is left running, with a warning, and instances without the label are
  never touched. The sweep runs only at launch.
- **One app per profile.** A second launch on the same profile focuses the
  window that is already open; a headless one (`VR_JOB_SPEC`, `VR_E2E_BLEND`)
  exits with status 1 and submits nothing.
- **Billing-risk alerts stay up.** A destroy that failed, or an instance left
  running, stays in a banner above every screen until you dismiss it, with a
  link to the Vast.ai console.

## Headless campaigns

For batches too big to click through, `VR_JOB_SPEC` submits a whole campaign
at boot:

```jsonc
{
  "blends": [
    "C:/scenes/shot_010.blend",
    { "path": "C:/scenes/shot_020.blend", "frameStart": 1, "frameEnd": 60 }
  ],
  // or "blendDir": "C:/scenes/campaign"
  "engine": "eevee",
  "frameStart": 1, "frameEnd": 200, "frameStep": 1,
  "addonZips": ["C:/addons/auroravision-0.2.0.zip"],
  "chunkSize": null,
  "maxActiveNodes": 4,
  "shareNode": true, // let these jobs co-run on a node (per-blend override too)
  "maxNodeSlots": 0, // 0/omitted = the app decides concurrency per node
  "slotsPerGpu": 1,  // renders per GPU on a node (0 = one process on all GPUs)
  "spendCapPerHour": 2,
  "offerFilters": { "cpuBound": true, "minNumGpus": 4 }
}
```

```bash
VR_JOB_SPEC=C:/specs/campaign.json npm run dev
```

Each blend entry is **one job**, however many nodes render it. To put more
machines on a job, raise `maxActiveNodes` (and set `eagerFleet: true` to rent
ahead of demand) rather than shrinking `chunkSize`. Leaving `chunkSize` null sizes
chunks for about three per node.

Re-running the same spec **heals** partially complete jobs (revives failed
chunks) rather than duplicating them. Events and node logs are mirrored to
stdout in this mode so a scripted run is diagnosable.

The spec's fleet settings (`maxActiveNodes`, `spendCapPerHour`, `eagerFleet`,
`maxNodeSlots`, `slotsPerGpu`, `offerFilters`) are saved into the profile's
settings and stay in force after the run, in the app as well. Run campaigns on
their own profile (`VR_USERDATA`) if that matters.

Other environment switches (development aids):

| Variable | Effect |
| --- | --- |
| `VR_MOCK=1` | Serve mock nodes, jobs and history to the UI. Only reads are mocked: the real node manager and scheduler still run, and actions (request node, destroy, submit, cancel) reach the profile's real fleet. Use it only with `VR_USERDATA` |
| `VR_SCREEN=jobs` | Open on a given screen (`fleet`, `jobs`, `job`, `gallery`, `history`, `settings`, `gradelab`) |
| `VR_SHOT=out.png` | Capture the window after load (`VR_SHOT_DELAY` ms, default 6000) |
| `VR_USERDATA=dir` | Use a throwaway profile (own settings, own SQLite state, no API key) |
| `VR_E2E_BLEND=x.blend` | Single-blend end-to-end test run (rents real machines) |

`VR_SCREEN` is appended to the dev-server URL verbatim, so it can carry the
screens' own parameters: `history&metric=power&range=7d`,
`settings&section=general`, `job&jobId=<id>`, `gallery&jobId=<id>&chunkId=<id>`,
`fleet&expand=1`, and `job&jobId=<id>&preview=<chunkId>&frame=<n>` to open the
preview overlay (otherwise only reachable by clicking, so uncapturable in a
scripted run). `gradelab&run=1` runs the grade-parity sweep and prints its result.

`VR_USERDATA` must be a **non-empty** path — an empty value falls back to the real
profile. On Windows, copy `Local State` from the real profile into a throwaway one
if you need the stored API key to decrypt there: Chromium keeps the `safeStorage`
key in that file, DPAPI-wrapped. A profile with a working key is a second fleet
on the same account. It rents up to its own max nodes and spend cap, not the
real profile's, and its launch sweep leaves the other profile's instances alone.

## How machines are chosen

Offers are ranked by `perf-per-dollar × reliability² × network`, where
perf-per-dollar prefers **your own measured render throughput** for a GPU
model (learned from completed chunks, per GPU, and scaled by each offer's GPU
count) over Vast's synthetic benchmark. In
CPU-bound mode, machines with no measured throughput are ranked by CPU clock
and effective cores per dollar instead, with the GPU benchmark capped so it
only tie-breaks. The strategy lives in `src/main/vast/offers.ts`; filters are
in Settings → Offer filters.

## Repository layout

- `src/main` — Electron main process: Vast.ai client, SSH/SFTP, node
  lifecycle, scheduler, settings, SQLite state.
- `src/renderer` — the UI (React + TypeScript).
- `src/shared` — the typed IPC contract shared by both.
- `remote/` — scripts that run **on the nodes** (provisioning, render agent,
  preview encoder). Uploaded verbatim over SFTP; stdlib Python + bash only.
  `npm test` runs `remote/agent/selfcheck.py` first, which covers the agent
  behaviour that is easiest to get wrong.
- `docs/` — setup notes, Octane specifics, HDR/codec findings, screenshots.

## Notes

- The render output contract for previews assumes linear Rec.709 EXR
  (Blender's `Standard` view transform); scenes rendering to PNG/JPG still
  work but get SDR previews only.
- Blender 5.x defaults to a Vulkan GPU backend; provisioning installs the
  Vulkan loader and the EEVEE probe falls back to OpenGL when Vulkan is
  unavailable on a node.
- Spend, energy (Wh), GPU draw and fleet size are metered once a minute and
  persisted in SQLite, so the History screen survives a restart. Everything there
  is what this app observed **while running** — it never reads back Vast.ai's
  billing, so totals read low for any period the app was closed or the
  computer slept.
- Versioning and release notes: see [CHANGELOG.md](CHANGELOG.md).
- License: GPL-3.0 (see `LICENSE`). A GPL-licensed Dropbox uploader this repo
  used to bundle set it, and that bundle is gone. Packaged builds now ship an
  ffmpeg binary from `ffmpeg-static` (GPL-3.0-or-later), though, so any change
  of license has to account for it.
