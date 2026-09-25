/**
 * The shared command layer: every job, queue and fleet action the renderer
 * (over IPC, ipc.ts's handleCommand) and the local HTTP API (main/api) can
 * take, each with the validator for its arguments. One definition of what
 * an action checks and does, whichever way it came in.
 *
 * A command's arguments are an argument list, as an IPC channel's are, so a
 * command named like its IPC channel takes the same arguments:
 *
 *   await runCommand('job:move', [{ jobId, before: null }])
 *   // { ok: true, value: QueueEntry[] } | { ok: false, code, message }
 *
 * runCommand never throws. executeCommand throws CommandError (result.ts),
 * for a caller (handleCommand) that turns a refusal into a rejection.
 */

import type {
  FleetCost,
  FleetHolds,
  JobDetail,
  JobSubmission,
  JobSummary,
  NodeSnapshot,
  QueueEntry,
  RetryMissingResult,
  ScaleStatusInfo
} from '../../shared/models'
import {
  boolean,
  id,
  isRecord,
  nullable,
  object,
  optional,
  showValue,
  tuple,
  type Validator
} from '../../shared/validate'
import { cancelJob, isCancelling, retryMissing } from '../app/recovery'
import { openJobs } from '../app/headless/drivers'
import {
  SpecSettingsRefused,
  inlineSpecProblems,
  runJobSpec,
  trackCampaignSettings,
  type JobSpec
} from '../app/headless/jobSpec'
import type { OverlayFields } from '../app/settingsOverlay'
import { getDb } from '../db/db'
import { createJob, getJob, listJobs, setJobShareNode } from '../jobs/jobs'
import { groupJobs, moveJob, queueEntries, removeJob, restoreJob, ungroupJob } from '../jobs/queue'
import { NotRevivable } from '../jobs/revive'
import { nodeManager } from '../nodes/nodeManager'
import { scheduler } from '../scheduler/scheduler'
import { CommandError, toCommandError, type CommandResult } from './result'

/** What POST /v1/jobs (job:submitSpec) answers. */
export interface SubmitSpecResult {
  /** The campaign's jobs: each submitted, or an open one it named again. */
  jobs: string[]
  /** Each blend not submitted, and why. */
  unsubmitted: string[]
  /** Settings put in force for this campaign only, released when it is done. */
  settings: OverlayFields
}

/** What GET /v1/fleet (fleet:status) answers. */
export interface FleetStatus {
  nodes: NodeSnapshot[]
  holds: FleetHolds
  /** Why scale-up is renting or not, at the scheduler's last tick. */
  scale: ScaleStatusInfo | null
}

interface Command<A extends unknown[], R> {
  args: Validator<A>
  run(...args: A): R | Promise<R>
}

function command<A extends unknown[], R>(
  args: Validator<A>,
  run: (...args: A) => R | Promise<R>
): Command<A, R> {
  return { args, run }
}

/** Throws not_found for a job that is not in the database. */
function requireJob(jobId: string): void {
  const row = getDb().prepare('SELECT 1 AS x FROM jobs WHERE id = ?').get(jobId)
  if (!row) throw new CommandError('not_found', `no job ${jobId}`)
}

/**
 * A submission is an object; createJob's validateSubmission checks its
 * fields (the dialog runs the same checks as the user types), and its
 * refusal is a bad request.
 */
const submission: Validator<JobSubmission> = (v, path) => {
  if (!isRecord(v)) throw new CommandError('bad_request', `${path} must be a job submission`)
  return v as unknown as JobSubmission
}

/** An inline campaign spec (jobSpec.ts), with every path full and local. */
const inlineSpec: Validator<JobSpec> = (v, path) => {
  if (!isRecord(v)) {
    throw new CommandError('bad_request', `${path} must be a campaign spec (got ${showValue(v)})`)
  }
  const problems = inlineSpecProblems(v)
  if (problems.length) throw new CommandError('bad_request', problems.join('; '))
  return v
}

async function submitSpec(spec: JobSpec): Promise<SubmitSpecResult> {
  const unsubmitted: string[] = []
  const campaign: string[] = []
  const applied: OverlayFields = {}
  try {
    await runJobSpec(spec, {
      kick: () => scheduler.kick(),
      unsubmitted,
      campaign,
      applied,
      source: 'request',
      // As a spec handed to the app (handoff.ts): the app is a person's, and
      // its fleet settings are only the campaign's when nothing else is open.
      settingsMode: 'handoff',
      openWork: () => openJobs(),
      resume: {
        recovery: (jobIds) => scheduler.resumeRecoveryFor(jobIds),
        job: (jobId) => scheduler.resumeJob(jobId, { octaneSignIn: false })
      }
    })
  } catch (e) {
    if (e instanceof SpecSettingsRefused) throw new CommandError('refused', e.message)
    throw toCommandError(e, 'bad_request')
  }
  trackCampaignSettings(campaign, applied, { openJobs, tag: '[api]' })
  if (campaign.length === 0 && unsubmitted.length > 0) {
    throw new CommandError('bad_request', `nothing submitted: ${unsubmitted.join('; ')}`)
  }
  return { jobs: campaign, unsubmitted, settings: applied }
}

const jobId = id()

const COMMANDS = {
  // -- jobs -------------------------------------------------------------------
  // The option may be left out, as over IPC.
  'jobs:list': command<[opts?: { includeHidden?: boolean }], JobSummary[]>(
    tuple([optional(object({ includeHidden: optional(boolean()) }))]),
    (opts) => listJobs({ includeHidden: opts?.includeHidden === true })
  ),
  'job:get': command(tuple([jobId]), (id): JobDetail | null => getJob(id)),
  'job:create': command(tuple([submission]), async (sub): Promise<{ jobId: string }> => {
    // createJob refuses a scene that is not a file on this computer
    // (validateSubmission): its path is somewhere shell:showItemInFolder may
    // reveal, and a UNC path there hands the user's NTLM hash to whoever
    // serves the share (Phase 0 review, plans 1.12 and 1.14).
    let id: string
    try {
      id = await createJob(sub)
    } catch (e) {
      throw toCommandError(e, 'bad_request')
    }
    scheduler.kick()
    return { jobId: id }
  }),
  'job:submitSpec': command(tuple([inlineSpec]), submitSpec),
  // Through app/recovery.ts, which notes the cancel until it has stopped the
  // job's renders on the nodes: job:retryMissing waits for that (plan 1.15).
  'job:cancel': command(tuple([jobId]), async (id): Promise<void> => {
    requireJob(id)
    await cancelJob(id)
  }),
  'job:setShareNode': command(tuple([jobId, boolean()]), (id, shareNode): void => {
    requireJob(id)
    setJobShareNode(id, shareNode)
    // Newly shareable chunks may now fit alongside work already in flight.
    scheduler.kick()
  }),
  // Queue the frames not yet downloaded again (plan 1.15). A job that cannot
  // be revived (it failed outright) is refused, with why.
  'job:retryMissing': command(tuple([jobId]), async (id): Promise<RetryMissingResult> => {
    requireJob(id)
    try {
      return await retryMissing(id)
    } catch (e) {
      throw toCommandError(e, e instanceof NotRevivable ? 'refused' : 'internal')
    }
  }),
  // Release a job the retry breaker held (plan 1.17). false = it was not held.
  'job:resume': command(tuple([jobId]), (id): boolean => {
    requireJob(id)
    return scheduler.resumeJob(id)
  }),
  'job:remove': command(tuple([jobId]), (id): void =>
    removeJob(id, { liveRuns: scheduler.hasJobRuns(id) || isCancelling(id) })
  ),
  'job:restore': command(tuple([jobId]), (id): void => restoreJob(id)),

  // -- the render queue (jobs/queue.ts) -----------------------------------------
  'queue:list': command(tuple([]), (): QueueEntry[] => queueEntries()),
  'job:move': command(
    tuple([object({ jobId, before: nullable(jobId) })]),
    ({ jobId, before }): QueueEntry[] => {
      const queue = moveJob(jobId, before)
      // The next chunk handed out follows the new order.
      scheduler.kick()
      return queue
    }
  ),
  'job:group': command(
    tuple([object({ jobId, withJobId: jobId })]),
    ({ jobId, withJobId }): { groupId: string } => {
      const r = groupJobs(jobId, withJobId)
      scheduler.kick()
      return r
    }
  ),
  'job:ungroup': command(tuple([jobId]), (id): void => {
    ungroupJob(id)
    scheduler.kick()
  }),

  // -- fleet ----------------------------------------------------------------------
  'fleet:status': command(tuple([]), (): FleetStatus => ({
    nodes: nodeManager.list(),
    holds: scheduler.fleetHolds(),
    scale: scheduler.scaleStatus()
  })),
  'fleet:cost': command(tuple([]), (): FleetCost => nodeManager.fleetCost())
} as const

type Commands = typeof COMMANDS

export type CommandName = keyof Commands
export type CommandArgs<N extends CommandName> = Parameters<Commands[N]['run']>
export type CommandValue<N extends CommandName> = Awaited<ReturnType<Commands[N]['run']>>

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[]

export function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name)
}

/** Check `raw` as `name`'s arguments. Throws CommandError('bad_request'). */
export function commandArgs<N extends CommandName>(name: N, raw: unknown): CommandArgs<N> {
  try {
    return COMMANDS[name].args(raw, name) as CommandArgs<N>
  } catch (e) {
    throw toCommandError(e, 'bad_request')
  }
}

/** Run a command on arguments already checked (commandArgs). Throws CommandError. */
export async function executeCommand<N extends CommandName>(
  name: N,
  args: CommandArgs<N>
): Promise<CommandValue<N>> {
  const run = COMMANDS[name].run as (...a: unknown[]) => unknown
  try {
    return (await run(...args)) as CommandValue<N>
  } catch (e) {
    throw toCommandError(e)
  }
}

/** Check and run a command. Never throws: a refusal is `{ ok: false, code, message }`. */
export async function runCommand<N extends CommandName>(
  name: N,
  args: unknown[]
): Promise<CommandResult<CommandValue<N>>> {
  try {
    if (!isCommandName(name)) throw new CommandError('not_found', `no command ${String(name)}`)
    const value = await executeCommand(name, commandArgs(name, args))
    return { ok: true, value }
  } catch (e) {
    const err = toCommandError(e)
    if (err.code === 'internal') console.error(`[command] ${name} failed:`, err.cause ?? err)
    return { ok: false, code: err.code, message: err.message }
  }
}
