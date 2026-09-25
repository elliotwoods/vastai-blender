/**
 * remote/octane/setup_octane.sh on a FakeMachine, for harness tests that
 * dispatch Octane jobs (plan 1.18). octaneLicense.ts reads the script's
 * `OCTANE_STATE <word>` lines, so a machine that answers its commands with
 * the fakes' default (exit 0, nothing said) fails the setup: "setup_octane.sh
 * reported no state". This answers as the real script does, as its own tests
 * (octaneScript.test.ts) pin it:
 *
 *   start-server   a server is launched unless one runs, and says
 *                  serverRunning; one already running says its state
 *   status         the state: `octane.state`, which a test moves (the user
 *                  signing in is `octane.state = 'licensed'`)
 *   stop-server    ends the server: OCTANE_STOPPED clean, state none
 *
 * install, start-vnc and `test -x` of OctaneBlender keep the default answer:
 * done, and present. What the commands carried on stdin is not seen here;
 * octaneLicense's own tests look at that.
 */

import type { OctaneState } from '../../shared/models'
import type { FakeMachine } from './fakeSsh'

export interface FakeOctane {
  /** What status says now. */
  state: OctaneState
  /** Servers launched. */
  launches: number
}

/**
 * Script `machine`'s setup_octane.sh. With `signIn: 'scripted'` (the default)
 * a launched server is licensed at once, as a scripted sign-in that works
 * is; with 'byHand' it stays unlicensed until the test sets the state.
 */
export function fakeOctane(
  machine: FakeMachine,
  opts: { signIn?: 'scripted' | 'byHand' } = {}
): FakeOctane {
  const octane: FakeOctane = { state: 'none', launches: 0 }
  machine.onExec(/setup_octane\.sh start-server\b/, () => {
    if (octane.state !== 'none') {
      return `[octane] OctaneServer already running (pid 4242) — left as is\nOCTANE_STATE ${octane.state}\n`
    }
    octane.launches++
    octane.state = opts.signIn === 'byHand' ? 'serverRunning' : 'licensed'
    return '[octane] OctaneServer launched (pid 4242)\nOCTANE_STATE serverRunning\n'
  })
  machine.onExec(/setup_octane\.sh status\b/, () => `OCTANE_STATE ${octane.state}\n`)
  machine.onExec(/setup_octane\.sh stop-server\b/, () => {
    const was = octane.state
    octane.state = 'none'
    return was === 'none' ? 'OCTANE_STOPPED none\n' : 'OCTANE_STOPPED clean\n'
  })
  return octane
}
