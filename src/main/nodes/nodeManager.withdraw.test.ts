import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REMOTE_ROOT } from '../test/fakeSsh'
import { setup, type World } from '../test/harness'

// The command nodeManager sends to stop, on a node that answers again, the
// chunks the app gave back while it was silent (withdrawGivenBack, plan 1.7),
// run under bash against real processes on this computer. The harness can
// only see that it was sent.

let w: World
let dir: string
beforeEach(async () => {
  w = await setup()
  dir = mkdtempSync(join(tmpdir(), 'vr-withdraw-'))
})
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true })
  await w.dispose()
})

/**
 * On a stand-in node rooted at `dir`: one chunk's spec in the inbox, and an
 * "agent" rendering it that, when that render dies, starts it again 2.5 s
 * later, as noderunner.py retries an EEVEE attempt that made no frame on the
 * OpenGL backend (after its settle, 2.5 s at most). The renders are python
 * sleeps whose argv carries the chunk's output path, as Blender's -o does.
 * Runs `withdraw` a second in, and reports what is left 3 s after it
 * returns: past when a retry would have started however soon it returned.
 */
function onNode(chunkId: string, withdraw: string): string {
  const script = join(dir, 'node.sh')
  writeFileSync(
    script,
    [
      'set -u',
      'ROOT=$1; ID=$2',
      // Never spelled out whole in an argv but a render's: pkill -f would
      // take this script for one.
      'OUT="$ROOT/ren""ders/$ID/frame_####"',
      'mkdir -p "$ROOT/jobs/inbox"; touch "$ROOT/jobs/inbox/$ID.json"',
      'render() { python3 -c \'import time; time.sleep(60)\' -o "$OUT"; }',
      '( render; sleep 2.5; render; echo retry-ended >> "$ROOT/agent.log" ) &',
      'AGENT=$!',
      'sleep 1',
      // As sshd runs it: the command text in the shell's own argv.
      'bash -c "$(cat "$ROOT/withdraw.sh")"',
      'sleep 3',
      'if pgrep -f "/[r]enders/$ID/" >/dev/null; then echo RENDERING; else echo STOPPED; fi',
      'if [ -f "$ROOT/jobs/inbox/$ID.json" ]; then echo SPEC-LEFT; else echo SPEC-GONE; fi',
      // Whatever is left is stopped now, so nothing outlives the test.
      'pkill -f "/[r]enders/$ID/"',
      'wait $AGENT',
      'cat "$ROOT/agent.log"'
    ].join('\n')
  )
  writeFileSync(join(dir, 'withdraw.sh'), withdraw.split(REMOTE_ROOT).join(dir))
  const r = spawnSync('bash', [script, dir, chunkId], { encoding: 'utf8', timeout: 30_000 })
  return r.stdout
}

describe.skipIf(process.platform === 'win32')('withdrawCommand against real processes', () => {
  it(
    '1.7: a withdrawn EEVEE chunk the agent retries on OpenGL is stopped too, not left rendering',
    { timeout: 40_000 },
    async () => {
      const { withdrawCommand } = await import('./nodeManager')
      const chunkId = `vrtest${randomBytes(4).toString('hex')}-1-4`
      const out = onNode(chunkId, withdrawCommand([chunkId]))
      // Both the render and its retry were stopped, and the spec is gone.
      expect(out.split('\n').filter(Boolean)).toEqual(['STOPPED', 'SPEC-GONE', 'retry-ended'])
    }
  )

  it('1.7: a withdraw of chunk 1-4 leaves chunk 1-40 rendering, and does not kill its own shell', async () => {
    const { withdrawCommand } = await import('./nodeManager')
    const id = `vrtest${randomBytes(4).toString('hex')}`
    // One round is enough to see what it matches.
    const command = withdrawCommand([`${id}-1-4`]).replace(/seq \d+/, 'seq 1')
    writeFileSync(join(dir, 'withdraw.sh'), command.split(REMOTE_ROOT).join(dir))
    const r = spawnSync(
      'bash',
      [
        '-c',
        [
          'render() { python3 -c \'import time; time.sleep(60)\' -o "$1" & }',
          `render "${dir}/ren""ders/${id}-1-4/f"; MINE=$!`,
          `render "${dir}/ren""ders/${id}-1-40/f"; NEIGHBOUR=$!`,
          'sleep 0.5',
          `bash -c "$(cat '${dir}/withdraw.sh')"; echo "withdraw exit $?"`,
          'sleep 0.2',
          'kill -0 $MINE 2>/dev/null && echo 1-4-RENDERING',
          'kill -0 $NEIGHBOUR 2>/dev/null && echo 1-40-RENDERING',
          'kill $MINE $NEIGHBOUR 2>/dev/null; true'
        ].join('\n')
      ],
      { encoding: 'utf8', timeout: 20_000 }
    )
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['withdraw exit 0', '1-40-RENDERING'])
  })
})
