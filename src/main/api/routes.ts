/**
 * The local API's routes (docs/API.md), each one a command of the shared
 * layer (commands/registry.ts): the same checks and the same answers as the
 * renderer's IPC. A response body is the command's result envelope,
 * `{ ok: true, value }` or `{ ok: false, code, message }`, with the HTTP
 * status from its code (result.ts httpStatus).
 *
 *   GET    /v1/health
 *   GET    /v1/jobs[?hidden=1]
 *   POST   /v1/jobs                        an inline campaign spec
 *   GET    /v1/jobs/:id
 *   PATCH  /v1/jobs/:id                    { "shareNode": bool }
 *   DELETE /v1/jobs/:id[?cancel=1]
 *   POST   /v1/jobs/:id/cancel | restore | ungroup | resume | retry-missing
 *   POST   /v1/jobs/:id/move               { "before": id | null }
 *   POST   /v1/jobs/:id/group              { "withJobId": id }
 *   GET    /v1/queue
 *   GET    /v1/fleet
 *   GET    /v1/fleet/cost
 *   GET    /v1/events[?channels=…]         (sse.ts; answered by server.ts)
 */

import type { JobDetail } from '../../shared/models'
import { boolean, id, nullable, object, optional, ValidationError } from '../../shared/validate'
import type { CommandName } from '../commands/registry'
import { httpStatus, type CommandResult } from '../commands/result'

export type RunCommand = (name: CommandName, args: unknown[]) => Promise<CommandResult<unknown>>

export interface RouteRequest {
  method: string
  /** The path's segments after /v1, decoded: ['jobs', '<id>', 'cancel']. */
  segments: string[]
  query: URLSearchParams
  /** The parsed JSON body, or undefined when there was none. */
  body: unknown
}

export interface RouteDeps {
  run: RunCommand
  /** For /v1/health. */
  version: string
  startedAt: number
  /** Waits between tries while a cancelled job's renders stop (DELETE ?cancel=1). */
  pause?: (attempt: number) => Promise<void>
}

export interface RouteAnswer {
  status: number
  body: unknown
}

function answer(r: CommandResult<unknown>, okStatus = 200): RouteAnswer {
  return { status: r.ok ? okStatus : httpStatus(r.code), body: r }
}

function refuse(status: number, code: string, message: string): RouteAnswer {
  return { status, body: { ok: false, code, message } }
}

const notFound = (req: RouteRequest): RouteAnswer =>
  refuse(404, 'not_found', `no route ${req.method} /v1/${req.segments.join('/')}`)

const methodNotAllowed = (req: RouteRequest, allowed: string): RouteAnswer =>
  refuse(405, 'bad_request', `${req.method} is not allowed here; use ${allowed}`)

/** Check a body against a validator; a failure is a 400. */
function bodyOf<T>(req: RouteRequest, check: (v: unknown, path: string) => T): T | RouteAnswer {
  try {
    return check(req.body ?? {}, 'body')
  } catch (e) {
    if (e instanceof ValidationError) return refuse(400, 'bad_request', e.message)
    throw e
  }
}

function isAnswer(v: unknown): v is RouteAnswer {
  return typeof v === 'object' && v !== null && 'status' in v && 'body' in v
}

const moveBody = object({ before: optional(nullable(id())) })
const groupBody = object({ withJobId: id() })
const patchBody = object({ shareNode: boolean() })

/** Wait for a cancelled job's renders to stop: a few event-loop turns, then 100 ms steps. */
function defaultPause(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    attempt < 20 ? setImmediate(resolve) : setTimeout(resolve, 100).unref?.()
  )
}

/** How many times DELETE ?cancel=1 tries the remove while the cancel settles (about 10 s). */
const REMOVE_TRIES = 120

async function deleteJob(req: RouteRequest, jobId: string, deps: RouteDeps): Promise<RouteAnswer> {
  if (req.query.get('cancel') === '1') {
    const got = await deps.run('job:get', [jobId])
    if (!got.ok) return answer(got)
    const job = got.value as JobDetail | null
    if (!job) return refuse(404, 'not_found', `no job ${jobId}`)
    if (job.state === 'queued' || job.state === 'running') {
      const cancelled = await deps.run('job:cancel', [jobId])
      if (!cancelled.ok) return answer(cancelled)
    }
    // The cancel is noted until its renders have stopped on the nodes, and
    // the remove is refused 'active' until then.
    const pause = deps.pause ?? defaultPause
    for (let attempt = 0; ; attempt++) {
      const removed = await deps.run('job:remove', [jobId])
      if (removed.ok || removed.code !== 'active' || attempt >= REMOVE_TRIES) {
        return answer(removed)
      }
      await pause(attempt)
    }
  }
  return answer(await deps.run('job:remove', [jobId]))
}

const JOB_ACTIONS: Record<string, CommandName> = {
  cancel: 'job:cancel',
  restore: 'job:restore',
  ungroup: 'job:ungroup',
  resume: 'job:resume',
  'retry-missing': 'job:retryMissing'
}

/** Answer one request (all but /v1/events, which server.ts streams). */
export async function route(req: RouteRequest, deps: RouteDeps): Promise<RouteAnswer> {
  const { method, segments: s } = req
  const [top, jobId, action, ...rest] = s
  if (rest.length) return notFound(req)

  if (top === 'health' && s.length === 1) {
    if (method !== 'GET') return methodNotAllowed(req, 'GET')
    return {
      status: 200,
      body: {
        ok: true,
        value: {
          app: 'vast-render',
          version: deps.version,
          pid: process.pid,
          startedAt: deps.startedAt
        }
      }
    }
  }

  if (top === 'queue' && s.length === 1) {
    if (method !== 'GET') return methodNotAllowed(req, 'GET')
    return answer(await deps.run('queue:list', []))
  }

  if (top === 'fleet') {
    if (s.length === 1 || (s.length === 2 && jobId === 'cost')) {
      if (method !== 'GET') return methodNotAllowed(req, 'GET')
      return answer(await deps.run(s.length === 1 ? 'fleet:status' : 'fleet:cost', []))
    }
    return notFound(req)
  }

  if (top !== 'jobs') return notFound(req)

  if (s.length === 1) {
    if (method === 'GET') {
      const hidden = req.query.get('hidden') === '1'
      return answer(await deps.run('jobs:list', [hidden ? { includeHidden: true } : {}]))
    }
    if (method === 'POST') return answer(await deps.run('job:submitSpec', [req.body]), 201)
    return methodNotAllowed(req, 'GET or POST')
  }

  if (s.length === 2) {
    switch (method) {
      case 'GET': {
        const r = await deps.run('job:get', [jobId])
        if (r.ok && r.value === null) return refuse(404, 'not_found', `no job ${jobId}`)
        return answer(r)
      }
      case 'PATCH': {
        const body = bodyOf(req, patchBody)
        if (isAnswer(body)) return body
        return answer(await deps.run('job:setShareNode', [jobId, body.shareNode]))
      }
      case 'DELETE':
        return deleteJob(req, jobId, deps)
      default:
        return methodNotAllowed(req, 'GET, PATCH or DELETE')
    }
  }

  // /v1/jobs/:id/:action
  if (method !== 'POST') return methodNotAllowed(req, 'POST')
  if (action === 'move') {
    const body = bodyOf(req, moveBody)
    if (isAnswer(body)) return body
    return answer(await deps.run('job:move', [{ jobId, before: body.before ?? null }]))
  }
  if (action === 'group') {
    const body = bodyOf(req, groupBody)
    if (isAnswer(body)) return body
    return answer(await deps.run('job:group', [{ jobId, withJobId: body.withJobId }]))
  }
  const name = Object.prototype.hasOwnProperty.call(JOB_ACTIONS, action)
    ? JOB_ACTIONS[action]
    : null
  if (!name) return notFound(req)
  return answer(await deps.run(name, [jobId]))
}
