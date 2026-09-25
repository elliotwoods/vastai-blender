# Local API

Vast Render can be driven from scripts and a terminal through a small HTTP
API that the running app serves on your own computer. It covers what the Jobs
and Fleet screens do: submit a campaign, list and inspect jobs, cancel, remove,
reorder and group them, and watch events as they happen. The
[`vast-render-cli`](#cli) command is a thin client for it.

The API is **off by default**. It is served only while the app is running.

## Turning it on

- **Settings › General › Local API**: tick *Local API*. The *Port* field is
  blank by default, which means the OS picks a free port each time the API
  starts. Give a port from 1024 to 65535 to fix it.
- Or start the app with **`VR_API=1`**, which turns it on for that session
  whatever the setting says (the checkbox then shows *on for this session*).

The *Status* line shows the address it is listening on, and the folder button
beside it shows `api.json` in Finder or Explorer.

## Discovery: `api.json`

While the API runs, the app keeps `api.json` in its profile folder:

```json
{
 "version": 1,
 "url": "http://127.0.0.1:53817",
 "port": 53817,
 "token": "q3W…43 characters…",
 "pid": 4242,
 "startedAt": 1758850000000
}
```

| Platform | Profile folder (packaged app) | Dev run (`npm run dev`) |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Vast Render/` | `~/Library/Application Support/vastai-blender/` |
| Windows | `%APPDATA%\Vast Render\` | `%APPDATA%\vastai-blender\` |
| Linux | `~/.config/Vast Render/` | `~/.config/vastai-blender/` |

`VR_USERDATA=<dir>` moves the profile, and `api.json` with it.

- The file is written whole (to a temporary file, then renamed), with mode
  `0600`, so only your user can read it.
- It is deleted when the API stops (the setting turned off) and when the app
  quits. A file left behind by a crash names a `pid` that is no longer
  running; the CLI checks for that.
- The **token changes every time the API starts.** Read it from the file each
  time rather than copying it somewhere.

## Authentication and the security model

Every request needs the token:

```
Authorization: Bearer <token from api.json>
```

What protects the API:

- **Loopback only.** The server binds to `127.0.0.1`, so other machines on
  the network cannot reach it.
- **A per-start token** of 32 random bytes, compared in constant time.
  A missing or wrong token gets **401**. The app never logs it.
- **No browsers.** Any request that carries an `Origin` header gets **403**,
  and the API sends no CORS headers. Browsers add `Origin` to cross-origin
  requests and to every `POST`, so a web page you visit cannot drive the app,
  even with a request that skips the CORS preflight.
- **Host check.** The `Host` header must be `127.0.0.1:<port>` or
  `localhost:<port>`, or the request gets **403**. This stops DNS-rebinding
  pages, which reach `127.0.0.1` under a host name of their own.
- **Small JSON bodies.** A body must be `application/json` (else **415**) and
  at most 1 MB (else **413**).
- **Local scene paths only.** Every `.blend`, `blendDir` and add-on zip path
  in a submission must be a full path on this computer. Relative paths,
  network shares (`\\server\share`, `//server/share`), and paths with `.` or
  `..` in them are refused, as they are in the New render dialog.

Anyone who can read `api.json` can submit and cancel jobs, and so spend money
on your Vast.ai account within your spend cap. That is the same as anyone who
can run the app as you. The API gives them nothing more: it cannot change
settings, keys or the spend cap, and it cannot rent or destroy nodes directly.

## Responses

Every response is JSON in the result envelope that the app uses internally:

```json
{ "ok": true, "value": … }
{ "ok": false, "code": "active", "message": "job 1a2b… is running; cancel it before removing it from the list" }
```

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `bad_request` | 400 (405 for the wrong method) | The arguments are wrong: a type, a range or a path. |
| `unauthorized` | 401 | No token, or the wrong one. |
| `forbidden` | 403 | An `Origin` header was sent, or the `Host` is not loopback. |
| `not_found` | 404 | No such job, or no such route. |
| `conflict` | 409 | The request does not fit the job's state, for example grouping a job that is not queued. |
| `active` | 409 | The job is queued or running, so cancel it first. |
| `refused` | 409 | A valid request the app will not carry out. Examples: a campaign whose fleet settings clash with open work, or a job that cannot be revived. |
| `too_large` | 413 | The body is over 1 MB. |
| `internal` | 500 | Anything else. The app's log has the details. |

The examples below set up the address and token like this:

```bash
API=$(jq -r .url  ~/Library/Application\ Support/Vast\ Render/api.json)
TOKEN=$(jq -r .token ~/Library/Application\ Support/Vast\ Render/api.json)
auth=(-H "Authorization: Bearer $TOKEN")
```

## Routes

All routes are under `/v1`.

### `GET /v1/health`

Is the app there? The response is `{app, version, pid, startedAt}`.

```bash
curl -s "${auth[@]}" $API/v1/health
```

### `GET /v1/jobs`

Returns every job, newest first. Add `?hidden=1` to include jobs that were
removed from the list. Each entry is a `JobSummary` (see
`src/shared/models.ts`): `id`, `name`, `state`, `framesDone`, `framesTotal`,
`queuePos`, `groupId` and so on.

```bash
curl -s "${auth[@]}" $API/v1/jobs | jq '.value[] | {id, name, state, framesDone, framesTotal}'
```

### `POST /v1/jobs`

Submits a campaign. The body is a spec in the same shape as a `VR_JOB_SPEC`
file (see the README, *Headless campaigns*), but every path must be a full
local path. The two fields that matter most here:

- **`name`** names the job. With several blends, it goes in front of each
  job's name. A blend entry's own `name` takes precedence.
- **`dedupe`** is either `"campaign"` or `"never"`:
  - `"campaign"` (the default) skips a blend whose job with the same frame
    range is complete, and heals an open job for that blend instead of
    submitting it twice.
  - `"never"` submits every blend as a new job.

Fleet settings in the spec (`maxActiveNodes`, `spendCapPerHour`,
`offerFilters` and others) follow the hand-off rule:

- If the app has no other open jobs, they apply for this campaign only and
  are released when it is done.
- If other jobs are open, each one must match what is already in force.
  Otherwise the response is `refused` and nothing is submitted.

On success the status is **201** and the response is
`{jobs, unsubmitted, settings}`:

- `jobs` lists the campaign's jobs: the new ones, and any open ones it named
  again.
- `unsubmitted` lists each blend that was not submitted, with the reason.

If no blend was submitted at all, the response is `bad_request`.

```bash
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X POST $API/v1/jobs -d '{
  "blends": ["/Users/me/scenes/shot_010.blend",
             {"path": "/Users/me/scenes/shot_020.blend", "frameStart": 1, "frameEnd": 60, "name": "shot 20"}],
  "engine": "cycles", "frameStart": 1, "frameEnd": 120,
  "name": "hero pass", "dedupe": "campaign"
}'
```

### `GET /v1/jobs/:id`

Returns one job, with its chunks (`JobDetail`), or **404**.

```bash
curl -s "${auth[@]}" $API/v1/jobs/1a2b3c4d-… | jq .value.state
```

### `PATCH /v1/jobs/:id`

`{"shareNode": true|false}` sets whether the job's chunks may share a node.
The change applies to chunks that have not been assigned yet.

```bash
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X PATCH $API/v1/jobs/$JOB -d '{"shareNode": true}'
```

### `DELETE /v1/jobs/:id`

Removes a finished job from the Jobs list. The job's files and records stay,
and `POST …/restore` lists it again. A job that is still queued or running is
refused with `active`, unless you add `?cancel=1`, which cancels it first and
then removes it once its renders have stopped.

```bash
curl -s "${auth[@]}" -X DELETE "$API/v1/jobs/$JOB?cancel=1"
```

### `POST /v1/jobs/:id/<action>`

| Action | Body | What it does |
| --- | --- | --- |
| `cancel` | none | Stops the job. Unfinished chunks become `cancelled`. |
| `restore` | none | Lists a removed job again. |
| `move` | `{"before": "<job id>" \| null}` | Moves the job, with its whole group, to just before another job, or to the end when `before` is `null`. The response is the new queue. |
| `group` | `{"withJobId": "<job id>"}` | Puts the job in the other job's group, which is created if needed. Grouped jobs share one place in the queue and render in step. The response is `{groupId}`. |
| `ungroup` | none | Takes the job out of its group. |
| `resume` | none | Releases a job the retry breaker held. The value is `false` if it was not held. |
| `retry-missing` | none | Queues every frame not yet downloaded again. The response is `{frames, chunks}`. |

```bash
curl -s "${auth[@]}" -X POST $API/v1/jobs/$JOB/cancel
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X POST $API/v1/jobs/$JOB/move -d '{"before": null}'
curl -s "${auth[@]}" -H 'Content-Type: application/json' -X POST $API/v1/jobs/$A/group -d "{\"withJobId\": \"$B\"}"
```

### `GET /v1/queue`

Returns the queued and running jobs in dispatch order. Each entry is
`{position, groupId, jobIds}`, and a group counts as one entry.

```bash
curl -s "${auth[@]}" $API/v1/queue
```

### `GET /v1/fleet`

Returns `{nodes, holds, scale}`:

- `nodes`: each node's snapshot (state, GPU, $/hr, current work).
- `holds`: every reason the fleet is not renting.
- `scale`: why scale-up is or is not renting, as of the scheduler's last tick.

```bash
curl -s "${auth[@]}" $API/v1/fleet | jq '.value.nodes[] | {id, state, gpuName}'
```

### `GET /v1/fleet/cost`

Returns `{perHour, sessionTotal, sessionWh, sessionCo2g, balance}`.

```bash
curl -s "${auth[@]}" $API/v1/fleet/cost
```

## Events: `GET /v1/events`

This route streams server-sent events from the app's event bus, the same
events the app's own window receives:

```
event: job:changed
data: {"id":"1a2b…","state":"running","framesDone":12,…}

: ping
```

- `?channels=job:changed,alert` picks channels.
- Without `channels`, you get `node:changed`, `job:changed`,
  `chunk:changed`, `asset:added`, `fleet:cost` and `alert`.
- The high-rate channels are sent only when you name them:
  - `chunk:progress`: Blender's live status, several times a second per
    chunk.
  - `render:logLine`: every line Blender prints.
- A `: ping` comment arrives every 15 seconds.
- An unknown channel gets **400**.

```bash
curl -sN "${auth[@]}" "$API/v1/events?channels=job:changed,alert"
```

## CLI

`bin/vast-render-cli.mjs` has no dependencies and needs Node 18 or later. It
is named `-cli` so it does not clash with the packaged app's `vast-render`
executable. From a checkout, run `npm link` once to put `vast-render-cli` on
your `PATH`, or run it with `node bin/vast-render-cli.mjs …`.

```
vast-render-cli submit shot_010.blend shot_020.blend --frames 1-120 --engine cycles --name "hero pass"
vast-render-cli submit --spec campaign.json      # a VR_JOB_SPEC-style file
vast-render-cli list [--all]
vast-render-cli status <job>
vast-render-cli queue
vast-render-cli cancel <job>
vast-render-cli rm <job> [--cancel]
vast-render-cli restore <job>
vast-render-cli move <job> [--before <job>]
vast-render-cli group <job> <with-job>
vast-render-cli ungroup <job>
vast-render-cli share <job> on|off
vast-render-cli resume <job>
vast-render-cli retry <job>
vast-render-cli fleet
vast-render-cli cost
vast-render-cli watch [--channels a,b] [--progress] [--logs]
```

- **Paths.** `submit` makes every path full from the directory you run it in,
  including the paths in a `--spec` file. Other options: `--step N`,
  `--chunk N`, `--share` and `--dedupe never`.
- **Output.** `--json` prints the raw value instead of the summary.
- **Finding the app.** The CLI looks for `api.json` in this order:
  1. `--api-file PATH`
  2. `VR_API_FILE`
  3. `<VR_USERDATA>/api.json`
  4. The packaged app's profile folder, then the dev run's

  It uses the first file whose app process is still alive.
- **Exit status.**
  - `0`: done.
  - `1`: refused. The reason is on stderr. This includes a usage error, and a
    `submit` that left any blend unsubmitted.
  - `2`: the app is not running, or its local API is off.

```bash
vast-render-cli submit ~/scenes/*.blend --frames 1-240 --engine cycles && vast-render-cli watch
```
