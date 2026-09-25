/**
 * Nothing that goes wrong in main may put up Electron's "A JavaScript error
 * occurred in the main process" box, and no diagnostic write may be what
 * goes wrong (plan 1.21).
 *
 * Field, job da68b61b: with the Mac's disk full, the headless stdout mirror
 * (events.ts) threw ENOSPC. Nothing caught it, so Electron showed its modal
 * error box, and the app sat behind it while nodes billed. Three things
 * stop that here:
 *
 * - diagWrite: a diagnostic line is written through it, and a write the
 *   disk or a closed pipe refuses (ENOSPC, EPIPE, EIO, or anything else) is
 *   counted and dropped. There is nowhere left to report it.
 * - guardStdio: stdout and stderr get an 'error' listener. A write to a
 *   closed terminal or a full disk can fail after the call has returned, as
 *   an 'error' event on the stream, and one with no listener is an uncaught
 *   exception. Every run gets it, not only a headless one: a person's app
 *   started from a terminal writes there too.
 * - installCrashGuard: 'uncaughtException' and 'unhandledRejection'
 *   listeners that log the error and raise an alert, and so keep the
 *   default box away. The app carries on, as it did after the box was
 *   dismissed, rather than exit with the fleet billing and nothing left to
 *   destroy it.
 */

import { describeError } from '../errors'

/** Why a diagnostic write was dropped: the codes a full disk or a closed pipe gives, or other. */
export type DiagFailure = 'ENOSPC' | 'EPIPE' | 'EIO' | 'other'

const failures: Record<DiagFailure, number> = { ENOSPC: 0, EPIPE: 0, EIO: 0, other: 0 }

function codeOf(e: unknown): DiagFailure {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ENOSPC' || code === 'EPIPE' || code === 'EIO' ? code : 'other'
}

/** Count one dropped diagnostic write. Never throws. */
export function countDiagFailure(e: unknown): DiagFailure {
  const code = codeOf(e)
  failures[code]++
  return code
}

/** Diagnostic writes dropped so far in this process, by why. */
export function diagFailures(): Readonly<Record<DiagFailure, number>> {
  return { ...failures }
}

/** Somewhere a diagnostic line goes: process.stdout, stderr, a log file. */
export interface DiagSink {
  write(text: string): unknown
}

/**
 * Write `text` to `sink`, or count why not. Never throws: it runs inside
 * the money paths (an alert raised from a destroy's catch block) and inside
 * the crash guard itself.
 */
export function diagWrite(sink: DiagSink, text: string): void {
  try {
    sink.write(text)
  } catch (e) {
    countDiagFailure(e)
  }
}

/** What guardStdio needs of a stream. */
export interface ErrorEmitter {
  on(event: 'error', listener: (e: unknown) => void): unknown
}

/**
 * An 'error' listener on each stream, so a write that fails after it
 * returned (EPIPE from a closed terminal, ENOSPC from a full disk) is
 * counted instead of thrown as an uncaught exception.
 */
export function guardStdio(streams: readonly ErrorEmitter[]): void {
  for (const stream of streams) {
    stream.on('error', (e) => {
      countDiagFailure(e)
    })
  }
}

/** What installCrashGuard needs of `process`. */
export interface CrashSource {
  on(event: 'uncaughtException', listener: (e: unknown) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

export interface CrashGuardDeps {
  proc: CrashSource
  /** Raise an error alert: the banner, and the OS notification with no window in front. */
  alert(message: string): void
  /** A diagnostic line, through diagWrite. */
  log(text: string): void
}

/**
 * The alert for an error nothing caught. It says the app is still running,
 * because it is, and that the fleet still bills, because a stuck scheduler
 * does not stop it.
 */
export function crashAlertMessage(e: unknown): string {
  return (
    `Vast Render hit an unexpected error and kept running: ${describeError(e)}. ` +
    'If renders or downloads look stuck, restart the app; nodes keep billing until they are destroyed.'
  )
}

/** The stack's frames alone: its first line repeats the message, which describeError has scrubbed. */
function framesOf(e: unknown): string {
  const stack = (e as { stack?: unknown } | null)?.stack
  if (typeof stack !== 'string') return ''
  return stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n')
}

/** Log and alert every uncaught exception and unhandled rejection, instead of Electron's box. */
export function installCrashGuard(deps: CrashGuardDeps): void {
  const report = (what: string) => (e: unknown) => {
    // Each step on its own: a listener that threw would be an uncaught
    // exception of its own, and a full disk must not cost the alert.
    try {
      const frames = framesOf(e)
      deps.log(`[vast-render] ${what}: ${describeError(e)}\n${frames ? `${frames}\n` : ''}`)
    } catch (err) {
      countDiagFailure(err)
    }
    try {
      deps.alert(crashAlertMessage(e))
    } catch {
      // emit() never throws; this is for a deps.alert that does.
    }
  }
  deps.proc.on('uncaughtException', report('uncaught exception'))
  deps.proc.on('unhandledRejection', report('unhandled rejection'))
}
