/**
 * The command layer's result envelope (docs/AUDIT-2026-09.md §5): a command
 * either answers `{ ok: true, value }` or refuses with `{ ok: false, code,
 * message }`. Electron drops an Error's own properties on the way to the
 * renderer, and an HTTP client wants a code it can branch on, so the code
 * travels as data here, and as the "code: message" prefix over IPC.
 *
 *   bad_request  the arguments are wrong: a type, a range, a path
 *   not_found    no such job (or node)
 *   conflict     the request does not fit the state: a job not in the queue
 *   active       the job is queued or running, and must be cancelled first
 *   refused      a valid request the app will not carry out as asked
 *                (a campaign's settings cannot be put in force, a job that
 *                cannot be revived)
 *   internal     anything else: a bug, or the disk or database failing
 */

import { QueueRefusal } from '../jobs/queueModel'
import { ValidationError } from '../../shared/validate'

export type CommandCode =
  'bad_request' | 'not_found' | 'conflict' | 'active' | 'refused' | 'internal'

export const COMMAND_CODES: readonly CommandCode[] = [
  'bad_request',
  'not_found',
  'conflict',
  'active',
  'refused',
  'internal'
]

export type CommandResult<T> =
  { ok: true; value: T } | { ok: false; code: CommandCode; message: string }

/**
 * A command's refusal. `cause`, when given, is the domain error it stands
 * for: over IPC that error goes to the renderer as it always did (its words
 * are what the renderer shows), where a refusal of the command layer's own
 * goes as "code: message".
 */
export class CommandError extends Error {
  override readonly name = 'CommandError'

  constructor(
    readonly code: CommandCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Any error as a CommandError. A queue refusal keeps its code (its message
 * loses the "code: " prefix it carries for IPC); a failed validator is a
 * bad request; anything else is internal. `as` classifies an error that is
 * not already a CommandError or a known kind.
 */
export function toCommandError(e: unknown, as: CommandCode = 'internal'): CommandError {
  if (e instanceof CommandError) return e
  if (e instanceof QueueRefusal) {
    const prefix = `${e.code}: `
    const message = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message
    return new CommandError(e.code, message, { cause: e })
  }
  if (e instanceof ValidationError) return new CommandError('bad_request', e.message)
  return new CommandError(as, messageOf(e), { cause: e })
}

/** The HTTP status for a code (main/api). */
export function httpStatus(code: CommandCode): number {
  switch (code) {
    case 'bad_request':
      return 400
    case 'not_found':
      return 404
    case 'conflict':
    case 'active':
    case 'refused':
      return 409
    case 'internal':
      return 500
  }
}
