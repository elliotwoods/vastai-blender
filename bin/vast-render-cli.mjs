#!/usr/bin/env node
/**
 * vast-render-cli: drive a running Vast Render app from a terminal or a
 * script, through its local API (docs/API.md). No dependencies; Node 18+.
 *
 *   vast-render-cli submit shot_010.blend --frames 1-120 --engine cycles
 *   vast-render-cli list
 *   vast-render-cli watch
 *
 * It finds the app through the api.json the app writes while its local API
 * is on (Settings > General > Local API, or VR_API=1): VR_API_FILE, else
 * <VR_USERDATA>/api.json, else the app's profile folder for this platform.
 *
 * Exit status: 0 done, 1 refused (the answer says why), 2 the app is not
 * running (or its API is off).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_NOT_RUNNING = 2

/**
 * The profile folder names: the packaged app's (electron-builder
 * productName) and a dev run's (package.json name).
 */
export const APP_DIR_NAMES = ['Vast Render', 'vastai-blender']

const USAGE = `vast-render-cli <command> [options]

  submit <blend>... [--frames A-B] [--step N] [--engine eevee|cycles|octane]
                    [--chunk N] [--name NAME] [--share] [--dedupe never]
  submit --spec <campaign.json>     a VR_JOB_SPEC-style campaign
  list [--all]                      jobs (--all: with those removed from the list)
  status <job>                      one job
  queue                             the render queue, in order
  cancel <job>
  rm <job> [--cancel]               remove from the list (--cancel: cancel first)
  restore <job>                     list a removed job again
  move <job> [--before <job>]       (no --before: to the end)
  group <job> <with-job>
  ungroup <job>
  share <job> on|off                let its chunks share a node
  resume <job>                      release a job the retry breaker held
  retry <job>                       queue its missing frames again
  fleet                             nodes and holds
  cost                              $/hr, session total, balance
  watch [--channels a,b] [--progress] [--logs]

  --json            print the raw answer
  --api-file PATH   the app's api.json (else VR_API_FILE, VR_USERDATA, the profile)

Exit status: 0 ok, 1 refused, 2 the app is not running.`

/** A usage error: exit 1 with the message and the usage. */
export class UsageError extends Error {}

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  'frames',
  'step',
  'engine',
  'chunk',
  'name',
  'dedupe',
  'spec',
  'before',
  'channels',
  'api-file'
])
/** Flags that are on or off. */
const BOOL_FLAGS = new Set(['json', 'all', 'share', 'cancel', 'progress', 'logs', 'help'])

/** argv (after the node and script) as { command, args, flags }. Throws UsageError. */
export function parseArgs(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      args.push(...argv.slice(i + 1))
      break
    }
    if (a === '-h') {
      flags.help = true
      continue
    }
    if (!a.startsWith('--')) {
      args.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (BOOL_FLAGS.has(name)) {
      if (eq > 0) throw new UsageError(`--${name} takes no value`)
      flags[name] = true
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i]
      if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`)
      flags[name] = value
    } else {
      throw new UsageError(`unknown option --${name}`)
    }
  }
  const [command = flags.help ? 'help' : '', ...rest] = args
  return { command, args: rest, flags }
}

function positiveInt(what, s) {
  if (!/^\d+$/.test(s)) throw new UsageError(`${what} must be a whole number (got ${s})`)
  return Number(s)
}

/** "1-120" or "7" as { frameStart, frameEnd }. */
export function parseFrames(s) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(s)
  if (!m) throw new UsageError(`--frames must be like 1-120 (got ${s})`)
  const frameStart = Number(m[1])
  const frameEnd = m[2] === undefined ? frameStart : Number(m[2])
  if (frameEnd < frameStart) throw new UsageError(`--frames ends before it starts (${s})`)
  return { frameStart, frameEnd }
}

/**
 * The spec `submit` sends. Paths are made full from `cwd`: the API takes
 * only full local paths.
 */
export function buildSpec(args, flags, cwd = process.cwd(), readFile = readFileSync) {
  if (flags.spec) {
    if (args.length) throw new UsageError('submit --spec takes no blends of its own')
    const spec = JSON.parse(readFile(resolve(cwd, flags.spec), 'utf-8'))
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new UsageError(`${flags.spec}: a spec must be a JSON object`)
    }
    const full = (p) => (typeof p === 'string' && !/^[\\/]{2}/.test(p) ? resolve(cwd, p) : p)
    if (Array.isArray(spec.blends)) {
      spec.blends = spec.blends.map((b) =>
        typeof b === 'string'
          ? full(b)
          : b && typeof b === 'object'
            ? { ...b, path: full(b.path) }
            : b
      )
    }
    if (typeof spec.blendDir === 'string') spec.blendDir = full(spec.blendDir)
    if (Array.isArray(spec.addonZips)) spec.addonZips = spec.addonZips.map(full)
    return spec
  }
  if (!args.length) throw new UsageError('submit needs at least one .blend (or --spec)')
  const spec = { blends: args.map((b) => resolve(cwd, b)) }
  if (flags.frames) Object.assign(spec, parseFrames(flags.frames))
  if (flags.step) spec.frameStep = positiveInt('--step', flags.step)
  if (flags.engine) spec.engine = flags.engine
  if (flags.chunk) spec.chunkSize = positiveInt('--chunk', flags.chunk)
  if (flags.name) spec.name = flags.name
  if (flags.share) spec.shareNode = true
  if (flags.dedupe) spec.dedupe = flags.dedupe
  return spec
}

/** Where to look for api.json, in order. */
export function apiFileCandidates(
  env = process.env,
  platform = process.platform,
  home = homedir()
) {
  if (env.VR_API_FILE) return [env.VR_API_FILE]
  if (env.VR_USERDATA) return [join(env.VR_USERDATA, 'api.json')]
  let base
  if (platform === 'darwin') base = join(home, 'Library', 'Application Support')
  else if (platform === 'win32') base = env.APPDATA || join(home, 'AppData', 'Roaming')
  else base = env.XDG_CONFIG_HOME || join(home, '.config')
  return APP_DIR_NAMES.map((name) => join(base, name, 'api.json'))
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it is there, as another user.
    return e && e.code === 'EPERM'
  }
}

/**
 * The api.json of the app that is running: the first candidate that parses
 * and whose process is alive. null when there is none.
 */
export function discoverApi(opts = {}) {
  const {
    candidates = apiFileCandidates(),
    readFile = readFileSync,
    exists = existsSync,
    alive = processAlive
  } = opts
  for (const path of candidates) {
    if (!exists(path)) continue
    let info
    try {
      info = JSON.parse(readFile(path, 'utf-8'))
    } catch {
      continue
    }
    if (
      info &&
      info.version === 1 &&
      typeof info.url === 'string' &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) &&
      typeof info.token === 'string' &&
      alive(info.pid)
    ) {
      return { ...info, path }
    }
  }
  return null
}

class NotRunning extends Error {}

/** One request to the API: its parsed body, whatever the status. */
async function api(info, method, path, body) {
  let res
  try {
    res = await fetch(`${info.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new NotRunning(`could not reach the app at ${info.url}: ${e.cause?.code ?? e.message}`)
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, code: 'internal', message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
  }
}

/** The method, path and body for a command that is one request. */
export function requestFor(command, args, flags, cwd = process.cwd()) {
  const need = (n, what) => {
    if (args.length !== n) throw new UsageError(`${command} takes ${what}`)
  }
  const job = () => encodeURIComponent(args[0])
  switch (command) {
    case 'submit':
      return ['POST', '/v1/jobs', buildSpec(args, flags, cwd)]
    case 'list':
      need(0, 'no arguments')
      return ['GET', flags.all ? '/v1/jobs?hidden=1' : '/v1/jobs']
    case 'status':
      need(1, 'a job id')
      return ['GET', `/v1/jobs/${job()}`]
    case 'queue':
      need(0, 'no arguments')
      return ['GET', '/v1/queue']
    case 'cancel':
    case 'restore':
    case 'ungroup':
    case 'resume':
      need(1, 'a job id')
      return ['POST', `/v1/jobs/${job()}/${command}`, undefined]
    case 'retry':
      need(1, 'a job id')
      return ['POST', `/v1/jobs/${job()}/retry-missing`, undefined]
    case 'rm':
      need(1, 'a job id')
      return ['DELETE', `/v1/jobs/${job()}${flags.cancel ? '?cancel=1' : ''}`]
    case 'move':
      need(1, 'a job id (and --before <job>)')
      return ['POST', `/v1/jobs/${job()}/move`, { before: flags.before ?? null }]
    case 'group':
      need(2, 'two job ids')
      return ['POST', `/v1/jobs/${job()}/group`, { withJobId: args[1] }]
    case 'share': {
      need(2, 'a job id and on|off')
      if (args[1] !== 'on' && args[1] !== 'off') throw new UsageError('share takes on or off')
      return ['PATCH', `/v1/jobs/${job()}`, { shareNode: args[1] === 'on' }]
    }
    case 'fleet':
      need(0, 'no arguments')
      return ['GET', '/v1/fleet']
    case 'cost':
      need(0, 'no arguments')
      return ['GET', '/v1/fleet/cost']
    default:
      throw new UsageError(command ? `unknown command ${command}` : 'no command given')
  }
}

function pct(done, total) {
  return total > 0 ? `${Math.floor((100 * done) / total)}%` : '-'
}

/** A human line or two for a command's value. */
export function describe(command, value) {
  switch (command) {
    case 'submit': {
      const lines = [`submitted ${value.jobs.length} job(s): ${value.jobs.join(', ') || 'none'}`]
      for (const u of value.unsubmitted ?? []) lines.push(`  not submitted: ${u}`)
      if (value.settings && Object.keys(value.settings).length) {
        lines.push(`  settings for this campaign only: ${JSON.stringify(value.settings)}`)
      }
      return lines.join('\n')
    }
    case 'list':
      if (!value.length) return 'no jobs'
      return value
        .map(
          (j) =>
            `${j.id}  ${String(j.state).padEnd(9)} ${pct(j.framesDone, j.framesTotal).padStart(4)}  ` +
            `${j.framesDone}/${j.framesTotal}  ${j.name}`
        )
        .join('\n')
    case 'status':
      return [
        `${value.name} (${value.id})`,
        `  state   ${value.state}`,
        `  frames  ${value.framesDone}/${value.framesTotal} (${value.frameStart}-${value.frameEnd})`,
        `  engine  ${value.engine}`,
        `  scene   ${value.blendPath}`,
        `  output  ${value.outputDir ?? ''}`
      ].join('\n')
    case 'queue':
    case 'move':
      if (!value.length) return 'the queue is empty'
      return value
        .map(
          (e) =>
            `${e.position}. ${e.jobIds.join(' + ')}${e.groupId ? `  (group ${e.groupId})` : ''}`
        )
        .join('\n')
    case 'group':
      return `grouped (${value.groupId})`
    case 'resume':
      return value ? 'released' : 'was not held'
    case 'retry':
      return `${value.frames} frame(s) queued again in ${value.chunks} chunk(s)`
    case 'fleet': {
      const lines = value.nodes.map(
        (n) => `${n.id}  ${String(n.state).padEnd(12)} ${n.gpuName ?? ''} x${n.numGpus ?? '?'}`
      )
      if (!lines.length) lines.push('no nodes')
      const holds = Object.keys(value.holds ?? {})
      if (holds.length) lines.push(`holds: ${holds.join(', ')}`)
      if (value.scale) lines.push(`scaling: ${value.scale.reason}`)
      return lines.join('\n')
    }
    case 'cost':
      return (
        `$${value.perHour.toFixed(3)}/hr now, $${value.sessionTotal.toFixed(2)} this session` +
        (typeof value.balance === 'number' ? `, balance $${value.balance.toFixed(2)}` : '')
      )
    default:
      return 'ok'
  }
}

/** Stream /v1/events to `out` until the stream ends. */
async function watch(info, flags, out) {
  let channels = flags.channels
  if (!channels && (flags.progress || flags.logs)) {
    const list = [
      'node:changed',
      'job:changed',
      'chunk:changed',
      'asset:added',
      'fleet:cost',
      'alert'
    ]
    if (flags.progress) list.push('chunk:progress')
    if (flags.logs) list.push('render:logLine')
    channels = list.join(',')
  }
  const path = `/v1/events${channels ? `?channels=${encodeURIComponent(channels)}` : ''}`
  let res
  try {
    res = await fetch(`${info.url}${path}`, { headers: { Authorization: `Bearer ${info.token}` } })
  } catch (e) {
    throw new NotRunning(`could not reach the app at ${info.url}: ${e.cause?.code ?? e.message}`)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return {
      ok: false,
      code: body.code ?? 'internal',
      message: body.message ?? `HTTP ${res.status}`
    }
  }
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (!event || data === undefined) continue
      out(flags.json ? JSON.stringify({ event, data: JSON.parse(data) }) : `${event} ${data}`)
    }
  }
  return { ok: true, value: null }
}

/**
 * Run the CLI. Returns the exit status; writes to `io.out` / `io.err`.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`))
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`))
  let parsed
  try {
    parsed = parseArgs(argv)
    if (parsed.command === 'help' || parsed.flags.help || parsed.command === '') {
      out(USAGE)
      return parsed.command === '' && !parsed.flags.help ? EXIT_REFUSED : EXIT_OK
    }
    const { command, args, flags } = parsed
    const request = command === 'watch' ? null : requestFor(command, args, flags, io.cwd)
    const info = discoverApi(
      flags['api-file'] ? { candidates: [flags['api-file']] } : (io.discover ?? {})
    )
    if (!info) {
      err(
        'vast-render-cli: the app is not running, or its local API is off ' +
          '(Settings > General > Local API, or start it with VR_API=1).'
      )
      return EXIT_NOT_RUNNING
    }
    const result = request
      ? await api(info, request[0], request[1], request[2])
      : await watch(info, flags, out)
    if (!result.ok) {
      if (flags.json) out(JSON.stringify(result))
      err(`vast-render-cli: ${result.code}: ${result.message}`)
      return EXIT_REFUSED
    }
    if (command !== 'watch') {
      out(flags.json ? JSON.stringify(result.value, null, 2) : describe(command, result.value))
    }
    // A campaign with blends not submitted is not all done.
    if (command === 'submit' && result.value.unsubmitted?.length) return EXIT_REFUSED
    return EXIT_OK
  } catch (e) {
    if (e instanceof UsageError) {
      err(`vast-render-cli: ${e.message}\n\n${USAGE}`)
      return EXIT_REFUSED
    }
    if (e instanceof NotRunning) {
      err(`vast-render-cli: ${e.message}`)
      return EXIT_NOT_RUNNING
    }
    err(`vast-render-cli: ${e?.message ?? e}`)
    return EXIT_REFUSED
  }
}

function isMain() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
