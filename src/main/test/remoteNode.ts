/**
 * A throwaway "node" for the remote/ shell scripts (provision.sh,
 * octane/setup_octane.sh), run for real under bash. HOME and VASTAI_HOME sit
 * in a temp dir with the app's remote/ tree copied in the way uploadTree lays
 * it out, and a stub bin/ goes first on PATH, so apt-get, curl, tmux, pkill,
 * pgrep, vncserver and OctaneServer never reach this machine or the network.
 * Coreutils (sha256sum, find, date, ps, kill) are the real ones, which is why
 * the scripts must also run on macOS's bash 3.2.
 *
 * The stubs and what they model:
 *   tmux        one session, `vr-agent`, kept as a marker file. new-session
 *               starts a fake agent as FAKE_AGENT says: `beat` (default) writes
 *               state/heartbeat as noderunner.py's heartbeat_loop does at once,
 *               `crash` dies at startup (no session, a traceback in agent.log),
 *               `silent` keeps the session but never beats.
 *   pgrep       answers from a fake process table (`setProcs`), never the real one
 *   pkill       recorded only: nothing on this machine is ever signalled by name
 *   apt-get     recorded; `install` marks the Octane packages installed
 *   dpkg-query  reports those packages installed once apt-get installed them
 *   curl        fails, as a node with no network would
 *   setsid      recorded only (it would start ensure-optix)
 *   flock       `flock [-n | -w <s>] <fd>`, util-linux's form, done with
 *               perl's flock(2), which macOS lacks as a command. The lock is
 *               on the open file the script holds as <fd>, so it lasts, as
 *               the real one does, until the script and every process that
 *               inherited that fd have closed it.
 *   vncserver   `:0` starts a real sleeper named Xtightvnc and writes TightVNC's
 *               pid file; `-kill` is recorded only
 *   vncpasswd   `-f` writes "enc(<password>)", so a test can see which password
 *   OctaneServer a real long-lived process that records its argv, environment
 *               and first two stdin lines under rec/ (outside HOME), exits on
 *               SIGTERM, and answers --help as a build with login flags would
 *
 * Every stub appends "<name> <args>" to rec/calls.log. Processes the stubs
 * start are killed by dispose().
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REMOTE_SRC = fileURLToPath(new URL('../../../remote', import.meta.url))

const RECORD = 'echo "$(basename "$0") $*" >> "$STUB_REC/calls.log"'

const STUBS: Record<string, string> = {
  'apt-get': `${RECORD}
[ "\${1:-}" = install ] && touch "$STUB_REC/apt-installed"
exit 0`,
  'dpkg-query': `${RECORD}
[ -e "$STUB_REC/apt-installed" ] || exit 1
shift 2
for p in "$@"; do echo "install ok installed"; done`,
  curl: `${RECORD}
exit 7`,
  setsid: `${RECORD}
exit 0`,
  flock: `${RECORD}
exec /usr/bin/perl -MFcntl=:flock -MTime::HiRes=sleep,time -e '
  my ($wait, $nb);
  while (@ARGV && $ARGV[0] =~ /^-/) {
    my $o = shift @ARGV;
    if ($o eq "-w") { $wait = shift @ARGV } elsif ($o eq "-n") { $nb = 1 }
    else { die "flock stub: $o is not modelled\\n" }
  }
  my $fd = shift @ARGV;
  $fd =~ /^\\d+$/ or die "flock stub: only the <fd> form is modelled\\n";
  open(my $fh, ">&=", $fd) or die "flock stub: fd $fd: $!\\n";
  my $until = defined $wait ? time + $wait : undef;
  until (flock($fh, LOCK_EX | LOCK_NB)) {
    exit 1 if $nb || (defined $until && time >= $until);
    sleep 0.05;
  }
' -- "$@"`,
  pkill: `${RECORD}
exit 0`,
  // procs: one "pid<TAB>name<TAB>args" per line. -f matches args as a fixed
  // string (the scripts only ever pass paths), -x matches the name exactly.
  pgrep: `${RECORD}
mode="$1"; pat="$2"; found=1
[ -f "$STUB_REC/procs" ] || exit 1
while IFS=$'\\t' read -r pid name args; do
  case "$mode" in
    -f) case "$args" in *"$pat"*) echo "$pid"; found=0 ;; esac ;;
    -x) [ "$name" = "$pat" ] && { echo "$pid"; found=0; } ;;
  esac
done < "$STUB_REC/procs"
exit $found`,
  tmux: `${RECORD}
case "$1" in
  has-session) [ -e "$STUB_REC/tmux-session" ] ;;
  kill-session) rm -f "$STUB_REC/tmux-session" ;;
  new-session)
    case "\${FAKE_AGENT:-beat}" in
      beat) touch "$STUB_REC/tmux-session"; mkdir -p "$VASTAI_HOME/state"; touch "$VASTAI_HOME/state/heartbeat" ;;
      crash) echo "Traceback (most recent call last): fake crash" >> "$VASTAI_HOME/logs/agent.log" ;;
      silent) touch "$STUB_REC/tmux-session" ;;
    esac ;;
esac`,
  vncpasswd: `${RECORD}
IFS= read -r pw || true
printf 'enc(%s)' "$pw"`,
  vncserver: `${RECORD}
[ "$1" = "-kill" ] && exit 0
(exec -a Xtightvnc sleep 300) < /dev/null > /dev/null 2>&1 &
echo $! >> "$STUB_REC/spawned"
mkdir -p "$HOME/.vnc"
echo $! > "$HOME/.vnc/$(hostname):0.pid"`,
  OctaneServer: `${RECORD}
if [ "\${1:-}" = "--help" ]; then echo "usage: OctaneServer [--username U --password P]"; exit 0; fi
echo $$ >> "$STUB_REC/spawned"
n=$(ls "$STUB_REC" | grep -c '^octane-argv' || true)
printf '%s\\n' "$@" > "$STUB_REC/octane-argv.$n"
env > "$STUB_REC/octane-env.$n"
u=""; p=""
IFS= read -r -t 2 u || true
IFS= read -r -t 2 p || true
printf '%s\\n%s\\n' "$u" "$p" > "$STUB_REC/octane-stdin.$n"
echo "OctaneServer (fake) started"
touch "$STUB_REC/octane-ready.$$"
trap 'kill "$child" 2>/dev/null; exit 0' TERM
sleep 300 < /dev/null > /dev/null 2>&1 &
child=$!
echo $child >> "$STUB_REC/spawned"
wait "$child"`
}

export interface ScriptResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface OctaneLaunch {
  argv: string[]
  env: string
  stdin: string[]
}

export interface RemoteNode {
  /** $HOME on the node. */
  home: string
  /** $VASTAI_HOME: the uploaded remote/ tree and everything the scripts write. */
  vastai: string
  /** $X_TMPDIR: where X servers keep .X0-lock (/tmp on a node). */
  xtmp: string
  provision(args: string[], opts?: RunOpts): ScriptResult
  octane(args: string[], opts?: RunOpts): ScriptResult
  /** Every stub call so far, "<name> <args>". */
  calls(): string[]
  /** The agent's tmux session ends, as it does when noderunner.py exits. */
  endAgentSession(): void
  /** The fake process table pgrep answers from. */
  setProcs(procs: Array<{ pid: number; name: string; args: string }>): void
  /** Each OctaneServer launch the stub saw, in order. */
  octaneLaunches(): OctaneLaunch[]
  /** As provision() and octane(), without waiting: for runs that overlap. */
  provisionAsync(args: string[], opts?: RunOpts): Promise<ScriptResult>
  octaneAsync(args: string[], opts?: RunOpts): Promise<ScriptResult>
  /**
   * Hold an exclusive flock(2) on `path` from another process, as a copy of
   * a script still running would; returns its release.
   */
  holdLock(path: string): () => void
  /**
   * A real, unrelated long-lived process (killed by dispose), shown by ps as
   * `argv0` (default `sleep`).
   */
  spawnBystander(argv0?: string): number
  /**
   * The pid of a real zombie: a process that has exited and that its parent
   * never reaps, as in a container whose PID 1 reaps no orphans.
   */
  spawnZombie(): number
  /**
   * The pid of a real process that runs until SIGTERM, then exits and, with
   * nobody to reap it, stays a zombie.
   */
  spawnUnreaped(): number
  alive(pid: number): boolean
  /** Set a file's mtime `seconds` into the past. */
  age(path: string, seconds: number): void
  /** Files under `dir` whose bytes contain `needle`. */
  filesContaining(dir: string, needle: string): string[]
  dispose(): void
}

export interface RunOpts {
  input?: string
  env?: Record<string, string>
}

/**
 * `provisioned`: the directories `provision.sh base` makes already exist, as
 * they do on any node the Octane setup or a second provision runs on.
 */
export function remoteNode(opts: { provisioned?: boolean } = {}): RemoteNode {
  const root = mkdtempSync(join(tmpdir(), 'vr-remote-'))
  const home = join(root, 'home')
  const vastai = join(home, 'vastai')
  const rec = join(root, 'rec')
  const stubs = join(root, 'stubs')
  const xtmp = join(root, 'xtmp')
  for (const d of [home, rec, stubs, xtmp]) mkdirSync(d, { recursive: true })
  cpSync(REMOTE_SRC, vastai, { recursive: true })
  if (opts.provisioned) {
    for (const d of ['jobs/inbox', 'logs', 'state', 'control', 'renders'])
      mkdirSync(join(vastai, d), { recursive: true })
  }
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  // What a node already provisioned once has: skips the static ffmpeg download.
  mkdirSync(join(vastai, 'bin'), { recursive: true })
  writeFileSync(join(vastai, 'bin', 'ffmpeg'), '#!/bin/bash\necho "ffmpeg version fake"\n')
  chmodSync(join(vastai, 'bin', 'ffmpeg'), 0o755)
  const bystanders: number[] = []

  const scriptEnv = (opts: RunOpts): NodeJS.ProcessEnv => ({
    HOME: home,
    VASTAI_HOME: vastai,
    PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'C',
    STUB_REC: rec,
    X_TMPDIR: xtmp,
    ...opts.env
  })

  const run = (script: string, args: string[], opts: RunOpts = {}): ScriptResult => {
    const r = spawnSync('/bin/bash', [script, ...args], {
      input: opts.input ?? '',
      encoding: 'utf8',
      timeout: 60_000,
      env: scriptEnv(opts)
    })
    if (r.error) throw r.error
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  const runAsync = (script: string, args: string[], opts: RunOpts = {}): Promise<ScriptResult> =>
    new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', [script, ...args], {
        env: scriptEnv(opts),
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(opts.input ?? '')
    })

  // setup_octane.sh launches OctaneServer in the background and returns, so
  // the stub may not have recorded anything yet: wait for the one the
  // pidfile names to say it has.
  const settleOctane = (): void => {
    const pidfile = join(vastai, 'state', 'octane-server.pid')
    if (!existsSync(pidfile)) return
    const pid = readFileSync(pidfile, 'utf8').split('\n')[0].trim()
    if (!/^\d+$/.test(pid)) return
    for (let i = 0; i < 100 && !existsSync(join(rec, `octane-ready.${pid}`)); i++) {
      if (!alive(Number(pid))) return
      spawnSync('sleep', ['0.05'])
    }
  }

  /** Starts `body` in a subshell under a parent that never reaps; its pid. */
  const spawnUnderNonReaper = (body: string): number => {
    const out = join(rec, `unreaped.${bystanders.length}`)
    const parent = spawn('/bin/bash', ['-c', `( ${body} ) & echo $! > '${out}'; exec sleep 300`], {
      detached: true,
      stdio: 'ignore'
    })
    parent.unref()
    bystanders.push(parent.pid!)
    for (let i = 0; i < 100 && !existsSync(out); i++) spawnSync('sleep', ['0.05'])
    const pid = Number(readFileSync(out, 'utf8'))
    // Killed before its parent at dispose, if it still runs by then.
    bystanders.unshift(pid)
    return pid
  }

  const waitForState = (pid: number, state: string): void => {
    for (let i = 0; i < 100; i++) {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
      if (r.stdout.includes(state)) return
      spawnSync('sleep', ['0.05'])
    }
    throw new Error(`pid ${pid} never reached state ${state}`)
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  return {
    home,
    vastai,
    xtmp,
    provision: (args, opts) => run(join(vastai, 'provision.sh'), args, opts),
    octane: (args, opts) => {
      const r = run(join(vastai, 'octane', 'setup_octane.sh'), args, opts)
      if (args[0] === 'start-server') settleOctane()
      return r
    },
    provisionAsync: (args, opts) => runAsync(join(vastai, 'provision.sh'), args, opts),
    octaneAsync: async (args, opts) => {
      const r = await runAsync(join(vastai, 'octane', 'setup_octane.sh'), args, opts)
      if (args[0] === 'start-server') settleOctane()
      return r
    },
    holdLock: (path) => {
      const ready = `${path}.held`
      const child = spawn(
        '/usr/bin/perl',
        [
          '-MFcntl=:flock',
          '-e',
          'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $r, ">", $ARGV[1]) or die; close $r; sleep 300',
          path,
          ready
        ],
        { detached: true, stdio: 'ignore' }
      )
      child.unref()
      bystanders.push(child.pid!)
      for (let i = 0; i < 100 && !existsSync(ready); i++) spawnSync('sleep', ['0.05'])
      if (!existsSync(ready)) throw new Error(`could not take the lock on ${path}`)
      return () => {
        try {
          process.kill(child.pid!, 'SIGKILL')
        } catch {
          // already gone
        }
        rmSync(ready, { force: true })
      }
    },
    calls: () => {
      const f = join(rec, 'calls.log')
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
    },
    endAgentSession: () => rmSync(join(rec, 'tmux-session'), { force: true }),
    setProcs: (procs) =>
      writeFileSync(
        join(rec, 'procs'),
        procs.map((p) => `${p.pid}\t${p.name}\t${p.args}\n`).join('')
      ),
    octaneLaunches: () => {
      const out: OctaneLaunch[] = []
      for (let n = 0; existsSync(join(rec, `octane-argv.${n}`)); n++) {
        const stdinFile = join(rec, `octane-stdin.${n}`)
        out.push({
          argv: readFileSync(join(rec, `octane-argv.${n}`), 'utf8')
            .split('\n')
            .filter(Boolean),
          env: readFileSync(join(rec, `octane-env.${n}`), 'utf8'),
          stdin: existsSync(stdinFile)
            ? readFileSync(stdinFile, 'utf8').split('\n').slice(0, 2)
            : []
        })
      }
      return out
    },
    spawnBystander: (argv0) => {
      const child = spawn('sleep', ['300'], { argv0, detached: true, stdio: 'ignore' })
      child.unref()
      bystanders.push(child.pid!)
      return child.pid!
    },
    // The parent execs `sleep`, which never calls wait(), so the child it
    // started is left unreaped once it exits. (The child outlives the exec:
    // bash itself would reap it.)
    spawnZombie: () => {
      const pid = spawnUnderNonReaper('sleep 0.3')
      waitForState(pid, 'Z')
      return pid
    },
    spawnUnreaped: () => spawnUnderNonReaper('trap "exit 0" TERM; while :; do sleep 0.1; done'),
    alive,
    age: (path, seconds) => {
      const t = Date.now() / 1000 - seconds
      utimesSync(path, t, t)
    },
    filesContaining: (dir, needle) => {
      const hits: string[] = []
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (e.isFile() && statSync(p).size < 5_000_000 && readFileSync(p).includes(needle))
            hits.push(p)
        }
      }
      walk(dir)
      return hits
    },
    dispose: () => {
      const spawned = existsSync(join(rec, 'spawned'))
        ? readFileSync(join(rec, 'spawned'), 'utf8').split('\n').filter(Boolean).map(Number)
        : []
      for (const pid of [...spawned, ...bystanders]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}
