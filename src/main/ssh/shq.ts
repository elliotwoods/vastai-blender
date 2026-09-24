/**
 * POSIX shell quoting: the one helper for putting a value into a command line
 * that a shell will parse.
 *
 * Every remote command goes through ssh2's exec, which hands the string to
 * the node's shell. Values reach those strings from settings (the Blender
 * version override reached provisioner.ts unquoted: audit C4, #95), job and
 * chunk ids, remote paths and credentials. Before this module there were two
 * private copies (octaneLicense.ts `sq`, sshTerminal.ts `shq`) and a dozen
 * hand-written `'${path}'` wrappers, which break, or run what follows, on the
 * first single quote in the value.
 *
 * Inside single quotes a POSIX shell treats every character literally except
 * the closing quote, so a quote in the value is closed, escaped and reopened:
 * it's → 'it'\''s'. Nothing else needs escaping, newlines included.
 *
 * Pure, and checked against a real /bin/sh in shq.test.ts.
 */

/** Characters that never need quoting in an argument (shlex.quote's set). */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

function text(value: string | number): string {
  if (typeof value === 'number') {
    // NaN or Infinity in a command is a bug upstream, not a value to pass on.
    if (!Number.isFinite(value)) throw new Error(`shq: refusing to quote the number ${value}`)
    return String(value)
  }
  if (typeof value !== 'string') throw new Error(`shq: refusing to quote a ${typeof value}`)
  // A command reaches the shell as a C string: a NUL would silently cut it
  // short, quote and all, so the command that runs is not the one written.
  if (value.includes('\0')) throw new Error('shq: refusing to quote a NUL byte')
  return value
}

/**
 * Always single-quoted. Use this for every value in a remote command: paths,
 * ids, versions, passwords. The empty string becomes '' (one empty argument),
 * never nothing.
 */
export function shq(value: string | number): string {
  return `'${text(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Quoted only when it has to be, for command lines a person reads or copies
 * (the "open a shell" command). Same result in a shell as shq() for an
 * argument. Not for a command's first word: `A=b` or `if` bare there is an
 * assignment or a keyword, not a command. shJoin handles that.
 */
export function shqMin(value: string | number): string {
  const s = text(value)
  return SAFE.test(s) ? s : shq(s)
}

/**
 * Reserved words a shell reads as syntax when they come first (POSIX, plus
 * bash's and zsh's own), where a command name was meant.
 */
const RESERVED = new Set([
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'if',
  'in',
  'then',
  'until',
  'while',
  'function',
  'select',
  'time',
  'coproc',
  'repeat',
  'foreach',
  'end',
  'nocorrect'
])

/**
 * Arguments joined into one command line, each quoted only as needed. The
 * first is the command: it is always quoted if it holds an `=` (bare, the
 * shell would take `NAME=value` as an assignment and run the next word
 * instead) or is a reserved word.
 */
export function shJoin(args: ReadonlyArray<string | number>): string {
  return args
    .map((a, i) => {
      if (i === 0) {
        const s = text(a)
        if (s.includes('=') || RESERVED.has(s)) return shq(s)
      }
      return shqMin(a)
    })
    .join(' ')
}
