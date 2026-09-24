import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { shJoin, shq, shqMin } from './shq'

// Values that have broken hand-written '${x}' quoting, or would run code
// through it: a quote, command substitution, globs, separators, newlines.
// Every payload only echoes, so a regression shows as wrong output here and
// never does anything to the machine running the tests.
const NASTY = [
  '',
  ' ',
  "it's",
  "''",
  "'; echo INJECTED #",
  '4.2; echo INJECTED',
  '$(echo INJECTED)',
  '`id`',
  '$HOME ${PATH}',
  '*',
  '~/x',
  'a b\tc',
  'line1\nline2',
  '"double"',
  'back\\slash',
  '-n',
  'é🎬',
  "a'b'c'"
]

/** What /bin/sh actually sees: each argument printed between markers. */
function throughShell(commandTail: string): string {
  const script = `set -- ${commandTail}; for a; do printf '<%s>' "$a"; done`
  return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf-8' })
}

const hasSh = process.platform !== 'win32' && existsSync('/bin/sh')

describe('shq', () => {
  it('single-quotes and escapes a quote by closing and reopening', () => {
    expect(shq('abc')).toBe("'abc'")
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  it('makes the empty string one empty argument, not nothing', () => {
    // sshTerminal.ts's private shq returned '' bare, which drops the argument.
    expect(shq('')).toBe("''")
    expect(shqMin('')).toBe("''")
  })

  it('quotes numbers, and refuses NaN, Infinity and NUL', () => {
    expect(shq(22)).toBe("'22'")
    expect(() => shq(Number.NaN)).toThrow(/NaN/)
    expect(() => shq(Number.POSITIVE_INFINITY)).toThrow(/Infinity/)
    expect(() => shq('a\0b')).toThrow(/NUL/)
    expect(() => shq(undefined as unknown as string)).toThrow(/undefined/)
  })

  it.skipIf(!hasSh)('round-trips every nasty value through a real /bin/sh', () => {
    for (const v of NASTY) {
      expect(throughShell(shq(v)), JSON.stringify(v)).toBe(`<${v}>`)
    }
  })

  it.skipIf(!hasSh)('keeps a Blender version override from running a command (audit C4)', () => {
    // provisioner.ts put blenderVersionOverride into `provision.sh ... ${version}` bare.
    const version = '4.2 ; echo INJECTED'
    expect(throughShell(`probe-eevee ${shq(version)}`)).toBe(`<probe-eevee><${version}>`)
  })
})

describe('shqMin / shJoin', () => {
  it('leaves safe words bare and quotes the rest', () => {
    expect(shqMin('/Users/me/.ssh/id_ed25519')).toBe('/Users/me/.ssh/id_ed25519')
    expect(shqMin('root@1.2.3.4')).toBe('root@1.2.3.4')
    expect(shqMin('StrictHostKeyChecking=accept-new')).toBe('StrictHostKeyChecking=accept-new')
    expect(shqMin('/Users/Jane Doe/key')).toBe("'/Users/Jane Doe/key'")
    expect(shqMin('~/key')).toBe("'~/key'")
  })

  it('joins an ssh command line the way the Fleet screen copies it', () => {
    expect(shJoin(['ssh', '-i', '/Users/Jane Doe/.ssh/k', '-p', 22, 'root@h'])).toBe(
      "ssh -i '/Users/Jane Doe/.ssh/k' -p 22 root@h"
    )
  })

  it('quotes a first word the shell would read as an assignment or a keyword', () => {
    expect(shJoin(['FOO=bar', 'ls'])).toBe("'FOO=bar' ls")
    expect(shJoin(['if', 'x'])).toBe("'if' x")
    // Only the first word: later ones are plain arguments.
    expect(shJoin(['ssh', '-o', 'A=b', 'if'])).toBe('ssh -o A=b if')
  })

  it.skipIf(!hasSh)('runs the first word as the command, never as an assignment', () => {
    // Bare, `X=1 echo ran` sets X and runs echo. Quoted, the shell looks for
    // a command named "X=1" and finds none (127). Nothing here runs anything
    // but echo.
    const status = (argv: string[]): string =>
      execFileSync('/bin/sh', ['-c', `${shJoin(argv)} 2>/dev/null; printf '<%s>' "$?"`], {
        encoding: 'utf-8'
      })
    expect(status(['X=1', 'echo', 'ran'])).toBe('<127>')
    expect(status(['while', 'true'])).toBe('<127>')
  })

  it.skipIf(!hasSh)('gives the shell exactly the arguments it was given', () => {
    const args = [...NASTY, 'plain', 42]
    expect(throughShell(shJoin(args))).toBe(args.map((a) => `<${a}>`).join(''))
  })
})
