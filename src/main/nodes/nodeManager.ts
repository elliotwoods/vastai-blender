/**
 * Fleet node registry + per-node lifecycle. State is persisted in SQLite so
 * app restarts recover; transitions are pushed to the renderer via
 * `node:changed`.
 *
 * Phase 2 scope: request (offer → create → poll → SSH reachable → ready),
 * destroy, cost accrual. Provisioning (Blender/ffmpeg install, agent start)
 * hooks in at `onReady` in Phase 3.
 */

import { createHash, randomUUID } from 'crypto'
import { co2Grams } from '../carbon/intensity'
import { getDb, readAppState, writeAppState } from '../db/db'
import { classify, type Classification } from '../errors'
import { emit } from '../events'
import { normaliseSlotsPerGpu } from '../scheduler/gpuLanes'
import {
  budgetOpen,
  offerContribution,
  subtractRental,
  withDemand,
  type RentalContribution
} from '../scheduler/scaling'
import { learnedSlots } from '../scheduler/slotController'
import { getSecret, getSettings } from '../settings'
import { ensureKeyRegistered, readPrivateKey } from '../ssh/keys'
import { FIRST_CONNECT_BUDGET_MS, retryWithBackoff } from '../ssh/connectRetry'
import { shq } from '../ssh/shq'
import { HostKeyMismatchError, SshConnection, type ExecResult } from '../ssh/sshConnection'
import { findOffers } from '../vast/offers'
import { isDockerImage } from '../../shared/settingsSanitize'
import {
  createInstance,
  currentUser,
  destroyInstance,
  listInstances,
  sshEndpoints,
  showInstance,
  vastErrorKind
} from '../vast/vastClient'
import type {
  CapacityBudget,
  EngineId,
  FleetCost,
  FleetHolds,
  GpuSample,
  NodeMetrics,
  NodeSnapshot,
  NodeState,
  NodeWorkRef,
  OctaneState,
  Offer,
  RequestNodeOptions,
  SettingsPublic,
  UnclaimedInstance,
  UnclaimedOwner
} from '../../shared/models'
import {
  capacityBudget,
  capUsage,
  createOutcomeUnknown,
  fitsBudget,
  holdsInstance,
  type NodeCostFacts
} from '../../shared/nodeState'
import type { RawInstance } from '../vast/types'
import {
  AGENT_STALE_S,
  AgentBusyError,
  agentStatus,
  ConnectionLostError,
  exitStatus,
  provisionDeps,
  REMOTE_ROOT,
  restartAgent,
  type AgentRestart
} from './provisioner'
import { prune as pruneMetrics, record as recordMetrics, runsPerGpu } from './metricsHistory'
import {
  asOctaneState,
  forgetOctaneNode,
  octaneSignInHold,
  onOctaneState,
  refreshOctaneState,
  scriptedSignInFor,
  setRentalFacts,
  stopOctaneServer,
  type OctaneRentalFacts
} from '../octane/octaneLicense'

export const DOCKER_IMAGE = 'vastai/base-image:cuda-12.1.1-cudnn8-devel-ubuntu22.04'

/**
 * Why `engine`'s nodes cannot be rented with the image Settings gives them,
 * or null when they can (rentalImage). For the scheduler to hold a job for
 * the user rather than try, and fail, a rental on every tick.
 *
 * - One that is not a well-formed image reference (a settings.json edited
 *   by hand: sanitizeSettingsPatch refuses one): Vast would refuse every
 *   create with it, and each refusal blacklists the machine it was for.
 * - None for Octane: DOCKER_IMAGE has no OctaneBlender, so an Octane node
 *   rented from it would bill through its boot and provisioning, then fail
 *   its first chunk (plan 1.21: no work, no rent). A node for installing
 *   OctaneBlender by hand is the Fleet's manual request, with no engine.
 */
export function rentalImageProblem(
  settings: SettingsPublic,
  engine?: EngineId | null
): string | null {
  const image = engine ? settings.dockerImageByEngine?.[engine]?.trim() : undefined
  if (!image) {
    return engine === 'octane'
      ? 'no docker image is set for Octane nodes, and the built-in one has no OctaneBlender ' +
          '(Settings → Docker image for Octane)'
      : null
  }
  if (!isDockerImage(image)) {
    return (
      `the docker image set for ${engine} nodes is not an image name ` +
      `(${JSON.stringify(image.slice(0, 80))})`
    )
  }
  return null
}

/**
 * The docker image to rent `engine`'s nodes with (plan 1.18): Settings'
 * image for the engine, or DOCKER_IMAGE for an engine with none set other
 * than Octane. The name goes to Vast's create call as data, never to a
 * shell. Throws, and nothing is rented, for rentalImageProblem's reasons.
 */
export function rentalImage(settings: SettingsPublic, engine?: EngineId | null): string {
  const problem = rentalImageProblem(settings, engine)
  if (problem) throw new Error(`${problem}: nothing was rented`)
  return (engine ? settings.dockerImageByEngine?.[engine]?.trim() : undefined) || DOCKER_IMAGE
}

/** Minimal onstart — real provisioning is pushed over SSH by the app. */
const ONSTART = 'mkdir -p ~/vastai && touch ~/vastai/.booted'

/**
 * How long one ensureInstanceGone keeps at a destroy before it calls it
 * unconfirmed. Long enough to ride out a Vast blip or a burst of 429s without
 * an alarm; short enough that the destroy button, which waits for it, and a
 * quit's destroy-all are not held for minutes. The retry timer carries on
 * after it (DESTROY_RETRY_MS).
 */
const DESTROY_BUDGET_MS = 60_000
const DESTROY_FIRST_DELAY_MS = 2_000
const DESTROY_MAX_DELAY_MS = 15_000

/**
 * How often a destroy Vast has not confirmed is tried again, one attempt per
 * node per round. One Vast blip during an unattended idle scale-down used to
 * leave the instance billing until the user came back and pressed "clear
 * failed" or restarted the app (#194).
 */
const DESTROY_RETRY_MS = 60_000

/**
 * The longest a destroy waits for OctaneServer to stop and release its
 * floating license, on a node with a pidfile that the app does not know to
 * have run Octane (octane_state 'none': a server from before this build, or
 * whose state was never read). A clean exit takes seconds; past this the
 * instance going away ends the server anyway.
 */
const OCTANE_STOP_BUDGET_MS = 20_000

/**
 * The same, on a node whose server the app knows ran (octane_state not
 * 'none'): setup_octane.sh's own wait for a clean exit, which is what
 * releases the OTOY seat, is 30 s, and a server cut off mid-shutdown may
 * hold its seat until OTOY times it out. Plus the connect and exec. Only a
 * stop that overlaps another stop already running (the script's lock) can
 * take longer.
 */
const OCTANE_STOP_RUNNING_BUDGET_MS = 35_000

/**
 * Plan 1.4: how long the instance of a create that got no answer is looked
 * for by its label before the create counts as having rented nothing. Vast
 * lists an instance as soon as it exists, so a create it carried out shows up
 * at the first look; the minute covers one it carried out after the app gave
 * up waiting for the reply. The lookup backs off from 2 s to 15 s meanwhile.
 */
const CREATE_LOOKUP_MS = 60_000
const LOOKUP_FIRST_DELAY_MS = 2_000
const LOOKUP_MAX_DELAY_MS = 15_000

/**
 * How often the lookup asks once Vast has gone that whole minute without
 * answering it. It never gives up: until Vast answers, the row counts as
 * billing, and nothing else in this session would settle it.
 */
const LOOKUP_SLOW_MS = 60_000

/**
 * How often a restart asks Vast again about an instance it has not answered
 * about: from 5 s, doubling to a minute, for as long as it takes.
 */
const RESUME_FIRST_DELAY_MS = 5_000
const RESUME_MAX_DELAY_MS = 60_000

/**
 * Plan 1.8: how long onReady (the remote tree, the deps, the agent, the
 * default Blender, the EEVEE probe) may take before the node is failed and
 * destroyed. It had no deadline, and one stalled download left a node
 * 'provisioning', billing, for good (#37 #82).
 *
 * A node that meets the offer filters' bandwidth (100 Mbps by default) gets
 * through onReady in a few minutes: a 130 MB ffmpeg and a 400 MB Blender are
 * seconds of download each, and restart-agent's worst case, waiting out
 * another one on the node, is under 3 min. provision.sh's download ceilings
 * are sized for a link trickling just above curl's stall guard (100 kB/s),
 * where a slow download still finishes: 30 min an attempt, so about an hour
 * for ffmpeg before its apt fallback, and 30 min a Blender mirror. Such a
 * node would take longer than this deadline, and the app does not wait for
 * it: at 25 min it is destroyed like any other failed provision, and the
 * next rental goes to another machine. So inside onReady this deadline, not
 * the script's ceilings or provisioner.ts's per-step timeouts, is the one
 * that ends a slow node. The script's own fallbacks, the next Blender
 * mirror after 30 min and apt's ffmpeg after about an hour, cannot happen
 * within it: a link that would reach them is failed here instead. Fitting
 * the script's per-download ceilings inside this deadline, when it runs from
 * onReady, is provision.sh's to do.
 */
const PROVISION_DEADLINE_MS = 25 * 60_000

/**
 * Plan 1.8: provisioning that ran past PROVISION_DEADLINE_MS. The work
 * itself is not stopped here: its caller destroys the node, which closes the
 * connection the work runs on.
 */
class ProvisionTimeout extends Error {
  override readonly name = 'ProvisionTimeout'

  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${Math.round(ms / 60_000)} min`)
  }
}

/** `work`, or a ProvisionTimeout once `ms` has passed without it. */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProvisionTimeout(what, ms)), ms)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * Plan 1.7: every connected node is sampled this often (pollMetrics), and
 * the sample is its liveness probe too: an exec over the node's own
 * connection, bounded so that a wedged one fails in PROBE_TIMEOUT_MS rather
 * than hanging the probe.
 */
const PROBE_EVERY_MS = 15_000
const PROBE_TIMEOUT_MS = 10_000

/**
 * Plan 1.18: how often the licence poll reads the Octane state of a node in
 * the fleet that has run Octane (pollOctane).
 */
const OCTANE_POLL_MS = 30_000

/**
 * A probe still out after this long gets a bare liveness check beside it
 * (LIVENESS_COMMAND), bounded to end with the probe. The probe starts with
 * nvidia-smi, which can take seconds on a loaded many-GPU node without
 * persistence mode, and hangs on a card that has fallen off the bus. A probe
 * that timed out while the node answered the check is a slow sample, not a
 * node gone silent: it used to count as one, so such a node was taken out
 * of the fleet every 45 s while SSH was fine.
 */
const PROBE_SLOW_MS = 5_000

/**
 * Plan 1.7: a node whose probes have failed this many times in a row, over
 * at least UNREACHABLE_AFTER_MS, is 'unreachable': 30 to 45 s after it went
 * silent, with a probe every 15 s. A connection that drops (SshConnection's
 * 'disconnected') counts as one more failure, unless the next probe gets
 * through. Nothing used to notice a node dying mid-session: its chunks
 * polled a dead connection for good while it billed, and its free slots
 * took more work (#17 #36 #52 #169 #192).
 */
const UNREACHABLE_STRIKES = 3
const UNREACHABLE_AFTER_MS = 30_000

/**
 * How long an 'unreachable' node gets to answer over SSH again before it is
 * given up on while Vast says it runs (recoverUnreachable). It reconnects
 * with backoff in RECONNECT_SLICE_MS rounds, and Vast is asked after each:
 * an instance Vast stopped meanwhile, or lists on other ports, is not
 * waited out. Between rounds that fail at once, a short pause. Once
 * connected, a command must answer within ANSWER_TIMEOUT_MS.
 */
const RECONNECT_BUDGET_MS = 10 * 60_000
const RECONNECT_SLICE_MS = 2 * 60_000
const RECONNECT_PAUSE_MS = 5_000
const ANSWER_TIMEOUT_MS = 15_000

/**
 * Once SSH answers again, the agent check gets at least RECONNECT_SLICE_MS
 * of the budget, however late in it the node came back: a link that drops
 * under the check right after a reconnect costs another round, not the node.
 * At most this many times in one recovery, since a link that drops under
 * every check leaves a node billing with no work done.
 */
const ANSWERED_GRACE_MAX = 3

/**
 * A heartbeat older than AGENT_STALE_S (provision.sh's, six missed beats)
 * means a dead agent. The probe must see it AGENT_STALE_PROBES times in a
 * row, and restart-agent checks again under its lock, since a false "dead"
 * kills every render on the node.
 */
const AGENT_STALE_PROBES = 2

/**
 * How many times one node's agent may be restarted within
 * AGENT_RESTART_WINDOW_MS before the node is given up on. An agent that
 * keeps dying would otherwise send its chunks round and round, each lap
 * charged to them, while the node bills.
 */
const AGENT_RESTARTS_MAX = 3
const AGENT_RESTART_WINDOW_MS = 60 * 60_000

/** The node states the probe samples. */
const PROBED: ReadonlySet<NodeState> = new Set<NodeState>([
  'ready',
  'idle',
  'rendering',
  'encoding',
  'provisioning'
])

/**
 * The states in which a node is supervised (plan 1.7): the ones work is sent
 * to. Not 'provisioning': onReady, or the recovery that set it, has a
 * deadline of its own.
 */
const SUPERVISED: ReadonlySet<NodeState> = new Set<NodeState>([
  'ready',
  'idle',
  'rendering',
  'encoding'
])

const HEARTBEAT = `${REMOTE_ROOT}/state/heartbeat`

/** The agent's heartbeat age by the node's own clock, read the way provision.sh reads it. */
const HEARTBEAT_AGE = `if [ -f ${HEARTBEAT} ]; then echo "heartbeat $(( $(date +%s) - $(date -r ${HEARTBEAT} +%s) ))"; else echo 'heartbeat none'; fi`

/** The probe: GPU, CPU and RAM usage, then the agent's heartbeat age. */
const PROBE_COMMAND =
  // `index` goes LAST so the columns everything below reads by position
  // keep their positions.
  `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,index --format=csv,noheader,nounits; echo ----; cat /proc/loadavg; nproc; echo ----; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; head -1 /proc/stat; echo ----; ` +
  HEARTBEAT_AGE

/** The probe without its sample: does the node answer, and is its agent's heartbeat fresh (PROBE_SLOW_MS)? */
const LIVENESS_COMMAND = `echo ok; ${HEARTBEAT_AGE}`

/**
 * How long a withdraw (withdrawGivenBack) goes on stopping the renders of
 * the chunks it withdraws: a pkill a second, this many times. One pkill was
 * not enough. The agent retries an EEVEE attempt that made no frame once
 * more on the OpenGL backend (noderunner.py), under the same chunk directory,
 * a few seconds after the first attempt dies: its settle takes 2.5 s at
 * most. So a withdrawn EEVEE chunk caught before its first frame rendered
 * again, on a lane the app counts as free, with nobody to collect it. The
 * node is out of the fleet until the withdraw returns, so nothing new of its
 * own can be caught.
 */
const WITHDRAW_KILL_ROUNDS = 8
const WITHDRAW_TIMEOUT_MS = 30_000

/**
 * The command that withdraws `chunkIds` from a node: their specs removed from
 * the inbox and their renders stopped, for WITHDRAW_KILL_ROUNDS seconds. By
 * the render's own directory (Blender's -o and the encode's input): the
 * trailing slash keeps chunk 1-1 from matching 1-10, and `[r]` keeps pkill -f
 * from matching, and killing, the shell running this command.
 */
export function withdrawCommand(chunkIds: readonly string[]): string {
  const specs = chunkIds.map((id) => `rm -f ${shq(`${REMOTE_ROOT}/jobs/inbox/${id}.json`)}`)
  const kills = chunkIds.map(
    (id) => `pkill -f ${shq(`/[r]enders/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)}`
  )
  return (
    `${specs.join('; ')}; ` +
    `for i in $(seq ${WITHDRAW_KILL_ROUNDS}); do ${kills.join('; ')}; sleep 1; done; true`
  )
}

/**
 * The heartbeat age a probe reported, in seconds: null when the agent never
 * beat, undefined when the probe said nothing about it.
 */
function heartbeatAge(part: string | undefined): number | null | undefined {
  const m = /^heartbeat (\d+|none)$/m.exec(part ?? '')
  if (!m) return undefined
  return m[1] === 'none' ? null : Number(m[1])
}

/**
 * What Vast says about an instance SSH no longer reaches: gone (Vast no
 * longer knows it), stopped (Vast stops an account's instances at a $0
 * balance, field incident 1d59516c), up (running, coming back from a
 * restart, or on a host that is offline for now), or silent (no answer:
 * Vast is down, or this computer's network is).
 *
 * An 'offline' host has lost touch with Vast, and so, most likely, with
 * everyone: its container can well be running on, renders and all, and
 * answer again when the host's network does. It gets the reconnect rounds a
 * running instance gets, within the same budget, rather than being
 * destroyed, and its undownloaded frames with it, at the first look.
 */
type InstanceFate =
  | { kind: 'gone' }
  | { kind: 'stopped'; inst: RawInstance }
  | { kind: 'up'; inst: RawInstance }
  | { kind: 'silent'; reason: string }

/** Vast is not running this instance, and will not without being asked. */
function instanceStopped(inst: RawInstance): boolean {
  if (inst.intended_status === 'stopped' || inst.cur_state === 'stopped') return true
  return ['exited', 'stopped'].includes(inst.actual_status ?? '')
}

/**
 * The link to the node failed under a command, rather than the node
 * answering it: the connection went under it (ConnectionLostError, or a step
 * that ended with no exit status, "failed (exit null)", or "exit undefined"
 * from a caller that passed ssh2's code on unread; see exitStatus), it timed
 * out, the node could not be reached, or anything else classify() calls
 * transient over SSH. That is no verdict on the node or its agent. A laptop's Wi-Fi
 * flapping just after it wakes does exactly this, and a node brought back
 * from one drop used to be destroyed, renders and all, for the next.
 */
function linkFailed(e: unknown): boolean {
  if (e instanceof ProvisionTimeout) return false
  if (e instanceof ConnectionLostError) return true
  if (e instanceof Error && /\(exit (null|undefined)\)/.test(e.message)) return true
  const c = classify(e, { via: 'ssh' })
  return c.kind === 'transient' || c.rule === 'ssh-lost' || c.rule === 'ssh-unreachable'
}

/** One line for why a recovery step failed. */
function failureReason(e: unknown): string {
  // Not one classify() knows yet: it would read "unrecognised error".
  if (e instanceof AgentBusyError) return e.message
  return classify(e, { via: 'ssh' }).reason
}

/** How reviveAgent left the agent of a node that answers again. */
type AgentRevival =
  | { kind: 'kept'; renders: number; withdrawn: number }
  | { kind: 'restarted'; reason: string | null }
  | { kind: 'reprovisioned' }

/** A node's run of failed probes (plan 1.7). */
interface Strikes {
  count: number
  /** When the first of them failed (epoch ms). */
  since: number
  /** Why the last one did. */
  reason: string
}

/**
 * Plan 1.3: how often the account's instances are checked against this
 * profile's rows, from the cost timer. The check used to run once, at start-
 * up, so an orphan made mid-session (a create Vast carried out after its
 * lookup gave up, a destroy an older build took on trust) billed until the
 * next launch (#13 #93).
 */
const RECONCILE_EVERY_MS = 5 * 60_000

/**
 * An instance younger than this is left to the next reconcile, whoever's it
 * is. Its create may not have answered yet: this session's rentals are
 * guarded by name (creating, lookingUp), but a create in flight in another
 * process on this profile (an older build without the single-instance lock)
 * is not, and its row reads 'requested' with no instance id until then.
 */
const RECONCILE_MIN_AGE_MS = 2 * 60_000

/**
 * Plan 1.5: once a search the spend cap left empty (no offer at or under
 * what the cap leaves) has come back, scale-up does not search at that
 * headroom or less again for this long, unless the offer filters change. A
 * fleet sitting just under its cap, with less headroom than the cheapest
 * offer, otherwise ran a Vast search, and drew a "scale-up failed" warning,
 * on every scheduler tick. A manual request always searches.
 */
const CAP_EMPTY_BACKOFF_MS = 5 * 60_000

/**
 * Plan 1.20: the credit guard's thresholds, in minutes of runway (the Vast
 * balance over what the fleet bills per minute). Under WARN the user is told
 * once; under HOLD renting stops (an account hold) until the balance goes up
 * again and lasts at least RELEASE. WARN is armed again once the runway is
 * back over REARM, so a balance hovering at the line warns once, not every
 * minute.
 */
const RUNWAY_WARN_MIN = 30
const RUNWAY_HOLD_MIN = 10
const RUNWAY_RELEASE_MIN = 20
const RUNWAY_REARM_MIN = 45

/** A rise in the balance smaller than this is rounding, not a top-up. */
const TOP_UP_MIN = 0.01

/** What every rental label starts with; nothing else marks a Vast Render rental. */
const LABEL_PREFIX = 'vastai-blender'

/**
 * The label a rental is created under (plan 1.3): the first 8 characters of
 * this profile's install id and of the node id, `vastai-blender
 * <install8>:<node8>`. Without an install id it is the legacy
 * `vastai-blender <node8>`, which rentals made before install ids carry.
 */
export function rentalLabel(nodeId: string, installId?: string | null): string {
  const node = nodeId.slice(0, 8)
  const install = installId ? installId.slice(0, 8) : ''
  return install ? `${LABEL_PREFIX} ${install}:${node}` : `${LABEL_PREFIX} ${node}`
}

/**
 * The parts of a Vast Render label: the install and node prefixes, or the
 * node prefix alone for a legacy label. Null for anything else: no label, or
 * one another tool or a person wrote.
 */
export function parseRentalLabel(
  label: string | null | undefined
): { install: string | null; node: string } | null {
  if (!label?.startsWith(`${LABEL_PREFIX} `)) return null
  const rest = label.slice(LABEL_PREFIX.length + 1).trim()
  const colon = rest.indexOf(':')
  if (colon < 0) return rest ? { install: null, node: rest } : null
  return { install: rest.slice(0, colon), node: rest.slice(colon + 1) }
}

/** Why a manual request stops at the spend cap, in words the user can act on. */
function spendCapReached(caps: CapacityBudget, settings: SettingsPublic): string {
  if (settings.spendCapPerHour == null) {
    return 'No spend cap is set: set one in Settings, or switch the cap off there on purpose'
  }
  return `Spend cap reached: the fleet bills ${money(caps.perHour)}/hr of ${money(caps.spendCap ?? 0)}/hr. Confirm renting past the cap to go on.`
}

/** Minutes the balance lasts at `perHour`: 0 once it is spent, unbounded for a fleet billing nothing. */
function runwayMinutes(balance: number, perHour: number): number {
  if (!(balance > 0)) return 0
  if (!(perHour > 0)) return Number.POSITIVE_INFINITY
  return (balance / perHour) * 60
}

function money(v: number): string {
  return `$${v.toFixed(2)}`
}

/** A node as alerts name it: its GPU and the start of its id. */
function nodeName(s: Pick<NodeSnapshot, 'id' | 'gpuName'>): string {
  return s.gpuName ? `${s.gpuName} ${s.id.slice(0, 8)}` : s.id.slice(0, 8)
}

/** What the Vast balance pays for per hour: see NodeManager.accountPerHour. */
interface AccountRate {
  /** this fleet's nodes that may be billing */
  fleet: number
  /** the other instances on the account, and how many */
  others: number
  otherCount: number
  total: number
}

/** "the fleet's $6.00/hr", or, with other instances on the account billing too, each share. */
function rateWords(r: AccountRate): string {
  if (r.otherCount === 0) return `the fleet's ${money(r.fleet)}/hr`
  const others = r.otherCount === 1 ? '1 other instance' : `${r.otherCount} other instances`
  return `the account's ${money(r.total)}/hr (this fleet ${money(r.fleet)}/hr, ${others} on the account ${money(r.others)}/hr)`
}

/**
 * Why renting is on hold for the account (plan 1.20), as FleetHolds.account
 * carries it, and what releases it:
 *   credit  Vast refused a rental for lack of credit. Released once the
 *           balance has gone up (a top-up) and lasts RUNWAY_RELEASE_MIN.
 *   runway  The balance fell under RUNWAY_HOLD_MIN of what the account
 *           bills (accountPerHour). Released the same way, at the higher of
 *           that rate now and then, so destroying nodes to stretch the runway
 *           does not reopen renting on money that would last minutes once
 *           scale-up refills the fleet.
 *   auth    Vast refused the account itself (a 401 or 403). Released when an
 *           API key is saved, when Vast answers a key other than the one it
 *           refused, or by the user. Never by the refused key answering a
 *           balance read: a key that may read the account but not rent
 *           (scoped keys; Vast's permission errors are undocumented) would
 *           release, rent, be refused and hold again every minute, a failed
 *           row and two alerts each time. Kept for the session only: a
 *           restart asks Vast afresh.
 */
interface AccountHold {
  reason: string
  /** The balance the hold was set at, or the first read after it; a rise over it is a top-up. */
  balance: number | null
  since: number
  cause: 'credit' | 'runway' | 'auth'
  /** $/hr the account billed when the hold was set (accountPerHour). */
  perHour: number
  /** classify()'s rule, for an auth hold. */
  rule?: string
  /** For an auth hold, keyFingerprint() of the key Vast refused. In memory only. */
  key?: string | null
}

/**
 * A short hash of the Vast API key in use, or null with none, so an auth
 * hold can tell a new key from the one Vast refused without keeping it.
 */
function keyFingerprint(): string | null {
  const key = getSecret('vastApiKey')
  return key ? createHash('sha256').update(key).digest('hex').slice(0, 16) : null
}

/** An account hold from app_state, or null. A value that does not parse is a hold all the same. */
function loadAccountHold(): AccountHold | null {
  const raw = readAppState(getDb(), 'account_hold')
  if (raw == null) return null
  try {
    const h = JSON.parse(raw) as Partial<AccountHold>
    if (typeof h.reason === 'string' && (h.cause === 'credit' || h.cause === 'runway')) {
      return {
        reason: h.reason,
        balance: typeof h.balance === 'number' ? h.balance : null,
        since: typeof h.since === 'number' ? h.since : Date.now(),
        cause: h.cause,
        perHour: typeof h.perHour === 'number' ? h.perHour : 0
      }
    }
  } catch {
    // Unreadable: held all the same, below.
  }
  return {
    reason: 'renting was paused for the Vast balance when the app last ran',
    balance: null,
    since: Date.now(),
    cause: 'credit',
    perHour: 0
  }
}

/**
 * The states in which the app wants a node's instance gone: it is being
 * destroyed, it failed, or it was destroyed and Vast has not confirmed that.
 */
const DESTROY_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'failed',
  'destroying',
  'destroyed'
])

/**
 * Vast answered a destroy, and showInstance still finds the instance. A
 * DELETE can answer 200 and leave the instance running (#140), so this is
 * not a destroy until Vast stops knowing the instance.
 */
class InstanceStillListed extends Error {
  override readonly name = 'InstanceStillListed'

  constructor(instanceId: number, status: string | undefined) {
    super(`Vast still lists instance ${instanceId} after its destroy (${status ?? 'no status'})`)
  }
}

/**
 * Vast did not answer: a network error, a timeout, a 5xx or a 429. That says
 * nothing about the instance asked about, or about the machine it is on.
 */
function vastDown(e: unknown): boolean {
  const kind = vastErrorKind(e)
  return kind === 'unknown' || kind === 'transient'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * How one rental ended, for requestNodes: the node it rented (or, cancelled,
 * the row that stands for it), or why it rented nothing. `stop` ends the
 * batch: its create got no answer, so an instance may exist that nothing has
 * found yet (plan 1.4), or Vast refused it in a way the next offer would meet
 * too.
 */
type Rental = ({ id: string } | { error: Error }) & { stop?: boolean }

interface NodeRow {
  id: string
  instance_id: number | null
  state: NodeState
  gpu_name: string | null
  num_gpus: number
  dph_total: number | null
  ssh_host: string | null
  ssh_port: number | null
  host_key: string | null
  started_at: number | null
  accumulated_cost: number
  eevee_capable: number | null
  octane_ready: number
  blender_versions: string
  last_error: string | null
  geolocation: string | null
  destroyed_at: number | null
  label: string | null
  octane_state: string
  create_unknown_since: number | null
}

/** The columns the reconcile matches an instance to its row by. */
interface ReconcileRow {
  id: string
  instance_id: number | null
  state: NodeState
  label: string | null
}

/**
 * A rental batch's offer search came back empty, and what bounded it: the
 * spend cap's headroom ('spendCap'), a price the caller named ('price'), or
 * the offer filters alone ('filters'). The scheduler reads the first as the
 * cap, not a failure: the fleet sits at its cap, and this module already
 * leaves such a search alone for CAP_EMPTY_BACKOFF_MS.
 */
export class NoMatchingOffersError extends Error {
  override readonly name = 'NoMatchingOffersError'

  constructor(
    message: string,
    readonly bound: 'spendCap' | 'price' | 'filters'
  ) {
    super(message)
  }
}

/** How far one requestNodes batch may go (plan 1.5). */
export interface RequestNodesOptions {
  /**
   * The scheduler's plan (planScaling's budget). Its demand, the exclusive
   * lanes and shared slots still wanted, is carried across the batch and
   * spent down by what each rental brings (subtractRental); the batch stops
   * once it is covered. Its caps are not used: before each rental they are
   * taken afresh from the live fleet and settings (withDemand). Without it
   * the batch is bounded by `count` and the caps alone.
   */
  budget?: CapacityBudget
  /**
   * The user confirmed renting past the spend cap: RequestNodeOptions'
   * overSpendCap, for a manual request only. maxActiveNodes still holds.
   */
  overSpendCap?: boolean
  /** The engine the rentals are for, which decides the lanes an offer brings. */
  engine?: EngineId | null
  /**
   * No rental above this $/hr, whatever the cap leaves: the bound an
   * over-cap confirmation names ("past the cap, at most $X/hr"). Without it
   * an overSpendCap request is bounded by the offer filter alone.
   */
  maxPerHour?: number | null
}

/**
 * What a node was rented as, this session (plan 1.18): the engine the
 * rental was for, the docker image it runs (rentalImage), and whether only
 * datacenter (secure cloud) hosts could take it. octaneLicense sends OTOY
 * credentials under secure cloud only to a node rented that way; the
 * scheduler can keep Octane chunks to nodes rented with the Octane image.
 */
export interface RentalFacts extends OctaneRentalFacts {
  image: string
}

/** What the billing predicates (shared/nodeState.ts) read, from a row. */
function rowFacts(r: NodeRow): NodeCostFacts {
  return {
    state: r.state,
    instanceId: r.instance_id,
    destroyedAt: r.destroyed_at,
    createUnknownSince: r.create_unknown_since,
    dphTotal: r.dph_total
  }
}

/** What the scheduler currently has in flight on a node. */
export type ActiveWork = NodeWorkRef

/** Injected by index.ts (avoids a scheduler ↔ nodeManager import cycle). */
let activeWorkProvider: ((nodeId: string) => ActiveWork[]) | null = null
export function setActiveWorkProvider(fn: (nodeId: string) => ActiveWork[]): void {
  activeWorkProvider = fn
}

/** The scheduler's auto-judged concurrency for a node. */
export interface SlotInfo {
  inUse: number
  target: number
}

/** Injected by index.ts, same reason as activeWorkProvider. */
let slotInfoProvider: ((nodeId: string) => SlotInfo) | null = null
export function setSlotInfoProvider(fn: (nodeId: string) => SlotInfo): void {
  slotInfoProvider = fn
}

/** Lets the scheduler drop a destroyed node's learned concurrency. */
let forgetNodeProvider: ((nodeId: string) => void) | null = null
export function setForgetNodeProvider(fn: (nodeId: string) => void): void {
  forgetNodeProvider = fn
}

/** Latest usage sample per node (in-memory — no need to persist). */
const metricsByNode = new Map<string, NodeMetrics>()

/**
 * When a probe last got through to each node (epoch ms), this session:
 * NodeSnapshot.lastContactAt, which says how long an 'unreachable' node has
 * been silent (plan 1.7).
 */
const lastContactByNode = new Map<string, number>()

/** Previous `/proc/stat` jiffie totals per node, for the CPU% delta. */
const cpuStatByNode = new Map<string, { total: number; idle: number }>()

/**
 * GPU energy per node (Wh), integrated from power samples. Kept for destroyed
 * nodes too so the session total doesn't drop when a node goes away — and, as
 * a session figure, deliberately not persisted.
 */
const energyByNode = new Map<string, number>()

/**
 * How much of `energyByNode` has already been written to usage_log. The
 * difference is the Wh burned since the last accrual tick. Both maps are
 * in-memory, so a restart zeroes them together and no energy is double-counted.
 */
const energyFlushedByNode = new Map<string, number>()

/** Wh burned on this node since the previous accrual tick; advances the mark. */
function flushEnergy(nodeId: string): number {
  const total = energyByNode.get(nodeId) ?? 0
  const delta = total - (energyFlushedByNode.get(nodeId) ?? 0)
  energyFlushedByNode.set(nodeId, total)
  return delta > 0 ? delta : 0
}

export function sessionEnergyWh(): number {
  let total = 0
  for (const wh of energyByNode.values()) total += wh
  return total
}

/**
 * Session CO2e (grams), each node's energy costed against its own country's
 * grid rather than one blended figure — the whole point of recording where a
 * machine is. Destroyed nodes still count: their row survives and the carbon
 * was still emitted.
 */
function sessionCo2Grams(): number {
  if (energyByNode.size === 0) return 0
  const overhead = getSettings().co2OverheadFactor
  const geoById = new Map(
    (
      getDb().prepare('SELECT id, geolocation FROM nodes').all() as Array<{
        id: string
        geolocation: string | null
      }>
    ).map((r) => [r.id, r.geolocation])
  )
  let total = 0
  for (const [nodeId, wh] of energyByNode) {
    total += co2Grams(wh, geoById.get(nodeId) ?? null, overhead)
  }
  return total
}

interface UsageRow {
  ts: number
  nodeId: string
  jobId: string | null
  chunkId: string | null
  cost: number
  wh: number
  powerW: number | null
  gpuUtil: number | null
}

/**
 * Divide one node's minute between the jobs it was actually rendering. A node
 * running two chunks of different jobs splits 50/50; two chunks of the *same*
 * job collapse into one row carrying the whole share, so a per-job SUM is right
 * either way. A node rendering nothing yields a single job_id = NULL row — that
 * is real money spent on idle or provisioning time and the History screen shows
 * it as overhead rather than hiding it.
 */
function splitUsage(nodeId: string, ts: number, cost: number, wh: number): UsageRow[] {
  const m = metricsByNode.get(nodeId)
  // 0 W means "this card doesn't report power", not "it drew nothing" — keep it
  // null so it doesn't drag the averages down.
  const powerW = m && m.powerW > 0 ? m.powerW : null
  const gpuUtil = m ? m.gpuUtil : null
  const base = { ts, nodeId }

  const work = activeWorkProvider?.(nodeId) ?? []
  if (work.length === 0) {
    return [{ ...base, jobId: null, chunkId: null, cost, wh, powerW, gpuUtil }]
  }

  const chunksByJob = new Map<string, string[]>()
  for (const w of work) {
    const ids = chunksByJob.get(w.jobId)
    if (ids) ids.push(w.chunkId)
    else chunksByJob.set(w.jobId, [w.chunkId])
  }
  return [...chunksByJob].map(([jobId, chunkIds], i) => {
    const share = chunkIds.length / work.length
    return {
      ...base,
      jobId,
      chunkId: chunkIds.join(', '),
      cost: cost * share,
      wh: wh * share,
      // Cost and energy divide between jobs, but draw does not — the node pulls
      // those watts once. Record the sample on the first row only, so summing
      // power_w across a tick gives true fleet draw rather than counting a
      // two-job node twice.
      powerW: i === 0 ? powerW : null,
      gpuUtil: i === 0 ? gpuUtil : null
    }
  })
}

/**
 * Persist a tick's usage rows and roll the attributed spend into
 * `jobs.cost_so_far` — the column the Jobs list and job header have always
 * displayed but which nothing used to write.
 */
function writeUsage(rows: UsageRow[]): void {
  if (rows.length === 0) return
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO usage_log (ts, node_id, job_id, chunk_id, delta_cost, delta_wh, power_w, gpu_util)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const charge = db.prepare('UPDATE jobs SET cost_so_far = cost_so_far + ? WHERE id = ?')
  db.transaction(() => {
    for (const r of rows) {
      insert.run(r.ts, r.nodeId, r.jobId, r.chunkId, r.cost, r.wh, r.powerW, r.gpuUtil)
      if (r.jobId) charge.run(r.cost, r.jobId)
    }
  })()
}

/** Append a balance reading, but only when it has actually moved. */
function recordBalance(ts: number, balance: number): void {
  const db = getDb()
  const last = db.prepare('SELECT balance FROM balance_log ORDER BY ts DESC LIMIT 1').get() as
    { balance: number } | undefined
  if (last && last.balance === balance) return
  db.prepare('INSERT OR REPLACE INTO balance_log (ts, balance) VALUES (?, ?)').run(ts, balance)
}

/**
 * True CPU utilisation from consecutive `/proc/stat` samples. Load average is
 * NOT a percentage — on Linux it counts uninterruptible-I/O tasks too, so a
 * node stuck on disk reads as "busy" while its cores idle. Until a second
 * sample exists (first poll after connect), fall back to load/cores.
 */
function cpuUtilFromStat(nodeId: string, memPart: string, load1: number, cores: number): number {
  const fallback = cores > 0 ? Math.min(100, (load1 / cores) * 100) : 0
  const line = /^cpu\s+(.+)$/m.exec(memPart)
  if (!line) return fallback
  const f = line[1].trim().split(/\s+/).map(Number)
  if (f.length < 5 || f.some((x) => !Number.isFinite(x))) return fallback
  // user nice system idle iowait irq softirq steal … — idle time is idle+iowait.
  const total = f.reduce((a, x) => a + x, 0)
  const idle = f[3] + f[4]
  const prev = cpuStatByNode.get(nodeId)
  cpuStatByNode.set(nodeId, { total, idle })
  if (!prev || total <= prev.total) return fallback
  const dTotal = total - prev.total
  const dIdle = Math.max(0, idle - prev.idle)
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
}

function rowToSnapshot(r: NodeRow): NodeSnapshot {
  const slots = slotInfoProvider?.(r.id) ?? { inUse: 0, target: 1 }
  return {
    id: r.id,
    instanceId: r.instance_id,
    state: r.state,
    gpuName: r.gpu_name,
    numGpus: r.num_gpus,
    dphTotal: r.dph_total,
    sshHost: r.ssh_host,
    sshPort: r.ssh_port,
    startedAt: r.started_at,
    accumulatedCost: r.accumulated_cost,
    energyWh: energyByNode.get(r.id) ?? 0,
    co2g: co2Grams(energyByNode.get(r.id) ?? 0, r.geolocation, getSettings().co2OverheadFactor),
    geolocation: r.geolocation,
    currentWork: activeWorkProvider?.(r.id) ?? [],
    slotsInUse: slots.inUse,
    slotTarget: slots.target,
    eeveeCapable: r.eevee_capable === null ? null : r.eevee_capable === 1,
    // octane_state alone (plan 1.18): octane_ready was set by the log check
    // #85 found read failures as licences, and an older build may still.
    octaneReady: r.octane_state === 'licensed',
    octaneNeedsManualLogin: r.octane_state === 'needsLogin',
    octaneState: asOctaneState(r.octane_state),
    blenderVersions: JSON.parse(r.blender_versions) as string[],
    lastError: r.last_error,
    metrics: metricsByNode.get(r.id) ?? null,
    // Without these two every destroyed node would read as billing, and a
    // create of unknown outcome as not billing (shared/nodeState.ts).
    destroyedAt: r.destroyed_at,
    createUnknownSince: r.create_unknown_since,
    label: r.label,
    lastContactAt: lastContactByNode.get(r.id) ?? null
  }
}

class ManagedNode {
  ssh: SshConnection | null = null
  /**
   * What this session rented the node as (rentOffer), or null for a node
   * from before a restart: kept in memory only, until nodes has a column
   * for it.
   */
  rental: RentalFacts | null = null
  /**
   * Times the node's connection dropped (SshConnection's 'disconnected')
   * since the supervisor last looked: each counts as a failed probe, unless
   * the next probe gets through (plan 1.7).
   */
  private drops = 0
  /** The app is shutting down: see retire. */
  private retired = false

  constructor(public readonly id: string) {}

  private get row(): NodeRow {
    return getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(this.id) as NodeRow
  }

  get snapshot(): NodeSnapshot {
    return rowToSnapshot(this.row)
  }

  get state(): NodeState {
    return this.row.state
  }

  /** What the billing predicates read (shared/nodeState.ts), without a whole snapshot. */
  get facts(): NodeCostFacts {
    return rowFacts(this.row)
  }

  /** Where Octane is on this node (plan 1.18): nodes.octane_state. */
  get octaneState(): OctaneState {
    return asOctaneState(this.row.octane_state)
  }

  /**
   * SSH has answered on this node at least once (its host key is pinned).
   * Nothing, OctaneServer included, can have been started on one where it
   * never has.
   */
  get sshEverAnswered(): boolean {
    return this.row.host_key != null
  }

  /**
   * Destroying or destroyed: the node is on its way out, and no lifecycle
   * step still running for it may move it back into the fleet.
   */
  get gone(): boolean {
    const s = this.state
    return s === 'destroying' || s === 'destroyed'
  }

  /**
   * For a lifecycle step (driveToReady, resumeNode, recoverUnreachable,
   * restoreAgent) back from an await: whether the node has left `held`, the
   * state the step last found it in or put it in. While a step holds a node
   * nothing but a destroy moves it: destroyNode ('destroying', then
   * 'destroyed', or 'failed' when Vast never confirmed the instance gone and
   * it may still be billing). The step must then stop without writing a
   * state over the destroy's, or a node the user destroyed comes back into
   * the fleet, and a destroyed one gets a second DELETE. Not `gone`: a
   * 'failed' destroy is not gone. A row the last exit left 'destroying' is
   * never held by a step: init destroys it instead. The liveness supervisor
   * only takes up a node in a state no step holds (SUPERVISED), and at most
   * one recovery runs per node. Plan 2.2 makes every transition a
   * compare-and-set instead.
   */
  movedOn(held: NodeState): boolean {
    return this.state !== held
  }

  /**
   * GPU count and latest metrics WITHOUT building a snapshot. The scheduler
   * sizes GPU lanes from these, and the snapshot itself asks the scheduler for
   * slot info — going through `snapshot` here would recurse.
   */
  get laneInputs(): { numGpus: number; metrics: NodeMetrics | null } {
    const row = getDb().prepare('SELECT num_gpus FROM nodes WHERE id = ?').get(this.id) as
      { num_gpus: number } | undefined
    return { numGpus: row?.num_gpus ?? 1, metrics: metricsByNode.get(this.id) ?? null }
  }

  /** Push a fresh snapshot without changing any persisted field. */
  emitChanged(): void {
    emit('node:changed', this.snapshot)
  }

  update(patch: Partial<Record<keyof NodeRow, unknown>>): void {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    getDb()
      .prepare(`UPDATE nodes SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => patch[k as keyof NodeRow]), this.id)
    // Whichever path destroyed it: its VNC login's local listener, which
    // only a destroy over a live connection used to close, goes with it.
    if (patch.state === 'destroyed') forgetOctaneNode(this.id)
    emit('node:changed', this.snapshot)
  }

  setState(state: NodeState, lastError: string | null = null): void {
    this.update({ state, last_error: lastError })
  }

  /**
   * Establish the pooled SSH connection (TOFU-pinning the host key), and
   * return it: the one this call connected, even if a destroy closed it and
   * nulled `this.ssh` while it connected. It used to re-read `this.ssh` after
   * the await and so returned null then, and the callers' check for exactly
   * that (resumeNode, recoverUnreachable: "end the session it opened") threw
   * instead of running, while a connect in flight, which ssh2 completes on a
   * closed connection all the same, kept its session to the dying box.
   */
  async connectSsh(): Promise<SshConnection> {
    // The app is quitting: nothing may open a connection to a node the user
    // chose to leave running (see retire).
    if (this.retired) throw new Error('connection closed: the app is shutting down')
    const row = this.row
    if (!row.ssh_host || !row.ssh_port) throw new Error('no SSH endpoint yet')
    let ssh = this.ssh
    if (!ssh) {
      const opened = new SshConnection({
        host: row.ssh_host,
        port: row.ssh_port,
        username: 'root',
        privateKey: readPrivateKey(),
        pinnedHostKey: row.host_key
      })
      opened.on('hostKey', (hash: string) => {
        if (!this.row.host_key) this.update({ host_key: hash })
      })
      opened.on('disconnected', () => {
        if (this.ssh === opened) this.drops++
      })
      this.ssh = ssh = opened
    }
    await ssh.acquire()
    return ssh
  }

  closeSsh(): void {
    this.ssh?.close()
    this.ssh = null
  }

  /**
   * shutdown(): close the connection, and refuse to open another. A step
   * still running for the node (a recovery waiting on Vast, say) would
   * otherwise connect again after the quit, and could restart the agent of a
   * node left running.
   */
  retire(): void {
    this.retired = true
    this.closeSsh()
  }

  /** The connection drops since the last call (see drops). */
  takeDrops(): number {
    const n = this.drops
    this.drops = 0
    return n
  }

  /**
   * Point the node's connection at `endpoints` when the one it uses is no
   * longer among them: a restarted container can come back on other ports.
   * True if it moved.
   */
  retargetTo(endpoints: Array<{ host: string; port: number }>): boolean {
    const row = this.row
    const [ep] = endpoints
    if (!ep || endpoints.some((e) => e.host === row.ssh_host && e.port === row.ssh_port)) {
      return false
    }
    this.update({ ssh_host: ep.host, ssh_port: ep.port })
    this.ssh?.setTarget({
      host: ep.host,
      port: ep.port,
      username: 'root',
      privateKey: readPrivateKey(),
      pinnedHostKey: row.host_key
    })
    return true
  }
}

export class NodeManager {
  private nodes = new Map<string, ManagedNode>()
  /** machine ids that failed this session — skipped when picking offers. */
  private blacklist = new Set<number>()
  private costTimer: NodeJS.Timeout | null = null
  private metricsTimer: NodeJS.Timeout | null = null
  private destroyTimer: NodeJS.Timeout | null = null
  private balance: number | null = null
  /**
   * ensureInstanceGone calls in flight, by instance id. A second caller for
   * the same instance (the retry timer, clearFailed, the destroy button
   * pressed again) waits on the first instead of sending its own DELETE.
   */
  private goneChecks = new Map<number, Promise<boolean>>()
  /** Instances whose unconfirmed destroy has been alerted this session. */
  private unconfirmedAlerted = new Set<number>()
  private retryingDestroys = false
  /** Nodes whose createInstance is in flight right now (rentOffer). */
  private creating = new Set<string>()
  /**
   * Nodes whose create got no answer, whose instance is being looked for by
   * its label right now (findLostCreate). The lookup settles the row, and
   * adopts or destroys what it finds.
   */
  private lookingUp = new Set<string>()
  /**
   * Rows the last run left with a create of unknown outcome. The reconcile
   * settles them against the account's instances (reconcileOrphans): the
   * first one after start-up, or the first that gets an answer from Vast.
   */
  private unknownAtBoot = new Set<string>()
  /** The reconcile running now, and whether another was asked for meanwhile. */
  private reconciling: Promise<void> | null = null
  private reconcileAgain = false
  /** When the cost timer next runs a reconcile (epoch ms). */
  private nextReconcileAt = 0
  /** Instances on the account that no row here holds, by id (plan 1.3). */
  private unclaimed = new Map<number, UnclaimedInstance>()
  /** When each listed instance was first seen, for one Vast gives no start date. */
  private firstSeen = new Map<number, number>()
  /** Instances of another install or profile already announced this session. */
  private foreignAlerted = new Set<string>()
  /** Why each unconfirmed destroy failed, by instance, until it is confirmed. */
  private destroyErrors = new Map<number, string>()
  /**
   * When Vast confirmed each instance gone (epoch ms), kept for
   * RECONCILE_MIN_AGE_MS. A reconcile whose list came before such a destroy
   * finished, or from a Vast still listing it for a moment after, must not
   * list it as unclaimed again: the user's destroyUnclaimed, which said ok,
   * would read as undone until the next pass.
   */
  private goneAt = new Map<number, number>()
  private lastOrphanLine = ''
  private unclaimedListeners = new Set<(list: UnclaimedInstance[]) => void>()
  /** The account hold (plan 1.20), or null while renting is free. */
  private hold: AccountHold | null = null
  /** The runway was under RUNWAY_HOLD_MIN at the last reading, hold or no hold. */
  private runwayLow = false
  /** The low-runway warning has been given, and not re-armed since. */
  private runwayWarned = false
  private holdListeners = new Set<(holds: FleetHolds) => void>()
  private bootListeners = new Set<(nodeId: string, failure: string | null) => void>()
  /** The last search the spend cap left empty, for CAP_EMPTY_BACKOFF_MS. */
  private capEmpty: { headroom: number; filters: string; at: number } | null = null
  /** Each supervised node's run of failed probes, while it lasts (plan 1.7). */
  private strikes = new Map<string, Strikes>()
  /** Nodes with a probe in flight: the next round leaves them to it. */
  private probing = new Set<string>()
  /** Nodes whose Octane state is being read now, and when each was last read (plan 1.18). */
  private octaneReading = new Set<string>()
  private octaneReadAt = new Map<string, number>()
  private octaneUnsubscribe: (() => void) | null = null
  /** Nodes whose probes time out while the node answers, since it was last logged. */
  private slowProbes = new Set<string>()
  /** Each node's stale heartbeats seen in a row. */
  private staleBeats = new Map<string, number>()
  /**
   * Nodes a recovery is running for (recoverUnreachable, restoreAgent): one
   * at a time per node.
   */
  private recovering = new Set<string>()
  /**
   * Nodes onReady has run to the end on this session. One resumed at
   * start-up that SSH did not reach has not been, and nothing short of the
   * whole of onReady makes it this build's.
   */
  private provisioned = new Set<string>()
  /** When the supervisor restarted each node's agent (epoch ms), within AGENT_RESTART_WINDOW_MS. */
  private agentRestarts = new Map<string, number[]>()
  /**
   * shutdown() has run. Its closing every connection is not the nodes
   * failing: a recovery under way must not take it for that and destroy a
   * node the user chose to leave running.
   */
  private shutDown = false
  /** Phase 3 hook: called when a node reaches SSH-reachable. */
  onReady: ((node: { id: string; ssh: SshConnection }) => Promise<void>) | null = null

  init(): void {
    this.hold = loadAccountHold()
    // A node's Octane state changes outside this module (the scheduler's
    // setupOctane, the licence poll): its snapshot goes out with it.
    this.octaneUnsubscribe = onOctaneState((id) => this.nodes.get(id)?.emitChanged())
    // Which nodes the OTOY credentials may go to under secure cloud only.
    setRentalFacts((id) => this.rentalOf(id))
    const rows = getDb().prepare('SELECT * FROM nodes').all() as NodeRow[]
    for (const r of rows) {
      const facts = rowFacts(r)
      // A destroyed row is done with, unless Vast never confirmed its
      // instance gone: an older build's destroy, whose 200 was taken on
      // trust, or a create cut short by a quit after its destroy.
      if (r.state === 'destroyed' && !holdsInstance(facts)) continue
      const n = new ManagedNode(r.id)
      this.nodes.set(r.id, n)
      if (createOutcomeUnknown(facts)) this.unknownAtBoot.add(r.id)
      // Anything mid-lifecycle at boot needs re-verification against vast.
      // Not a node the last run was destroying, or had failed: resuming one
      // re-provisioned it back into the fleet (#168). retryDestroys below
      // finishes its destroy instead.
      if (r.instance_id != null && holdsInstance(facts) && !DESTROY_STATES.has(r.state)) {
        void this.resumeNode(n)
      }
    }
    this.costTimer = setInterval(() => void this.accrueCosts(), 60_000)
    this.metricsTimer = setInterval(() => this.pollMetrics(), PROBE_EVERY_MS)
    this.destroyTimer = setInterval(() => void this.retryDestroys(0), DESTROY_RETRY_MS)
    void this.retryDestroys(DESTROY_BUDGET_MS)
    void this.reconcile()
    // The balance, the credit guard and the fleet totals now, not a minute
    // from now: the toolbar read $0.00 until the first accrual tick.
    void this.refreshCost()
  }

  /**
   * Check the account's instances against this profile's rows now (plan
   * 1.3): from init, every RECONCILE_EVERY_MS from the cost timer, and from
   * the app shell on waking from sleep (powerMonitor 'resume') and after an
   * API key is saved (onApiKeySaved). A call while one runs waits for it and
   * then one more, so a key saved mid-pass is used. Never rejects.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) {
      this.reconcileAgain = true
      return this.reconciling
    }
    const run = async (): Promise<void> => {
      try {
        do {
          this.reconcileAgain = false
          await this.reconcileOrphans().catch(() => {})
        } while (this.reconcileAgain)
      } finally {
        this.reconciling = null
      }
    }
    this.reconciling = run()
    return this.reconciling
  }

  /**
   * The app shell calls this once a Vast API key is saved: the account may be
   * another one now, and a hold the old key caused (a 401 or 403) says
   * nothing about the new one. Reconciles, and reads the balance, at once.
   */
  async onApiKeySaved(): Promise<void> {
    if (this.hold?.cause === 'auth')
      this.releaseHold('Renting resumes: a new Vast.ai API key was saved')
    await Promise.all([this.reconcile(), this.refreshCost()])
  }

  /**
   * The instances on the account that no node of this profile holds, with
   * what they cost (plan 1.3), as the last reconcile found them. The Fleet
   * lists them until they are gone.
   */
  listUnclaimed(): UnclaimedInstance[] {
    return [...this.unclaimed.values()]
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.instanceId - b.instanceId)
      .map((u) => ({ ...u }))
  }

  /**
   * Called with the whole list whenever a reconcile, or a destroy of one,
   * changes it (for fleet:unclaimed). Returns the unsubscribe function.
   */
  onUnclaimedChanged(listener: (list: UnclaimedInstance[]) => void): () => void {
    this.unclaimedListeners.add(listener)
    return () => {
      this.unclaimedListeners.delete(listener)
    }
  }

  /**
   * Destroy one unclaimed instance, on the user's explicit, confirmed say-so
   * (fleet:destroyUnclaimed). Only an id the last reconcile listed as
   * unclaimed: an instance a node of this profile holds is destroyed through
   * that node, never from here, and nothing outside the list is touched.
   */
  async destroyUnclaimed(instanceId: number): Promise<{ ok: boolean; message: string }> {
    const entry = this.unclaimed.get(instanceId)
    if (!entry) {
      return { ok: false, message: `instance ${instanceId} is not an unclaimed instance` }
    }
    // A row may have taken it since the list was made (a create that just
    // answered, or a lookup that found it).
    if (this.heldInstances().has(instanceId)) {
      this.unclaimed.delete(instanceId)
      this.unclaimedChanged()
      return {
        ok: false,
        message: `instance ${instanceId} belongs to a node of this profile now: destroy that node instead`
      }
    }
    const gone = await this.ensureInstanceGone(instanceId)
    const now = this.unclaimed.get(instanceId)
    if (gone) {
      this.unclaimed.delete(instanceId)
      this.unclaimedChanged()
      return { ok: true, message: `instance ${instanceId} destroyed` }
    }
    const reason = this.destroyErrors.get(instanceId) ?? 'Vast has not confirmed it gone'
    if (now) {
      now.destroyError = reason
      this.unclaimedChanged()
    }
    return {
      ok: false,
      message: `instance ${instanceId} may still be billing (${reason}): check the Vast.ai console`
    }
  }

  private unclaimedChanged(): void {
    const list = this.listUnclaimed()
    for (const l of [...this.unclaimedListeners]) {
      try {
        l(list)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /**
   * Instance ids a row here holds unconfirmed, read from the database rather
   * than the managed nodes, so a row another process on this profile wrote
   * counts too. So does one confirmed gone within RECONCILE_MIN_AGE_MS: Vast
   * may list an instance for a moment after the destroy it confirmed, and a
   * second destroy then would be announced as an orphan's.
   */
  private heldInstances(): Set<number> {
    const rows = getDb()
      .prepare(
        'SELECT instance_id FROM nodes WHERE instance_id IS NOT NULL AND (destroyed_at IS NULL OR destroyed_at > ?)'
      )
      .all(Date.now() - RECONCILE_MIN_AGE_MS) as Array<{ instance_id: number }>
    return new Set(rows.map((r) => r.instance_id))
  }

  /**
   * Plan 1.3: every instance on the account, checked against this profile's
   * rows. Billing-leak protection that used to run once, at start-up.
   *
   * - An instance a row holds, in any state, is that row's: a live node's,
   *   or one retryDestroys is destroying.
   * - An orphan, whose label names a row of this profile that does not hold
   *   it (a create whose reply was lost, one a crash cut short, one Vast
   *   carried out after its lookup gave up, a destroy an older build took on
   *   trust), is claimed by that row and destroyed.
   * - Anything else is unclaimed, listed with its rate and never destroyed
   *   here: another install's or profile's rental (a packaged app and a dev
   *   build on one account; destroying it would kill that app's live render),
   *   one under this install's id that no row names (ownerOf), or no Vast
   *   Render rental at all. Only the user destroys one (destroyUnclaimed).
   *
   * Left for a later pass: an instance younger than RECONCILE_MIN_AGE_MS,
   * and one whose row's create may still answer: in flight or being looked
   * for in this session, or a row 'requested' with no instance id that the
   * last run did not leave (another process's create in flight).
   *
   * Returns whether Vast answered.
   */
  private async reconcileOrphans(): Promise<boolean> {
    const started = Date.now()
    this.nextReconcileAt = started + RECONCILE_EVERY_MS
    for (const [id, at] of this.goneAt) {
      if (at < started - RECONCILE_MIN_AGE_MS) this.goneAt.delete(id)
    }
    // Before the list is asked for, as well as after. An instance held when
    // Vast answers is left alone even if its row is confirmed gone meanwhile:
    // the list predates that destroy.
    const heldBefore = this.heldInstances()
    let instances: RawInstance[]
    try {
      instances = await listInstances()
    } catch {
      // No key, offline, Vast down: the next pass asks again.
      return false
    }
    const now = Date.now()
    // Asked afresh for each instance: destroying an orphan awaits Vast, and
    // meanwhile a create can answer and its row take its instance.
    const held = (id: number): boolean => heldBefore.has(id) || this.heldInstances().has(id)
    const rows = getDb()
      .prepare('SELECT id, instance_id, state, label FROM nodes')
      .all() as ReconcileRow[]
    // The row an instance belongs to is the one whose own label it carries:
    // rentOffer writes the row, label and all, before it asks Vast to rent.
    // A row an older build wrote has no label column, and only ever rented
    // under the legacy label, so it is found by its id.
    const byLabel = new Map<string, ReconcileRow>()
    const byPrefix = new Map<string, ReconcileRow>()
    for (const r of rows) {
      if (r.label) byLabel.set(r.label, r)
      else byPrefix.set(r.id.slice(0, 8), r)
    }
    const rowFor = (label: string | undefined): ReconcileRow | undefined => {
      if (!label) return undefined
      const exact = byLabel.get(label)
      if (exact) return exact
      const parts = parseRentalLabel(label)
      return parts && parts.install == null ? byPrefix.get(parts.node) : undefined
    }
    const listed = new Set(instances.map((i) => i.id))
    for (const id of [...this.firstSeen.keys()]) if (!listed.has(id)) this.firstSeen.delete(id)
    const unclaimed = new Map<number, UnclaimedInstance>()
    // Rows a listed instance's label names: their create went through.
    const found = new Set<string>()
    let tracked = 0
    for (const inst of instances) {
      if (!this.firstSeen.has(inst.id)) this.firstSeen.set(inst.id, now)
      if (held(inst.id)) {
        tracked++
        continue
      }
      if (this.goneAt.has(inst.id)) continue
      // Being destroyed now (the retry timer, or the user's destroy of an
      // unclaimed one): that destroy settles it. Listed as it was meanwhile.
      if (this.goneChecks.has(inst.id)) {
        const prev = this.unclaimed.get(inst.id)
        if (prev) unclaimed.set(inst.id, prev)
        continue
      }
      const bornAt =
        inst.start_date != null && Number.isFinite(inst.start_date)
          ? inst.start_date * 1000
          : this.firstSeen.get(inst.id)!
      const young = now - bornAt < RECONCILE_MIN_AGE_MS
      if (young) {
        // Looked at again as soon as it is old enough, not five minutes on.
        this.nextReconcileAt = Math.min(this.nextReconcileAt, bornAt + RECONCILE_MIN_AGE_MS)
      }
      const named = rowFor(inst.label)
      if (named) {
        found.add(named.id)
        // As it is now, not as it was when the list came.
        const row =
          (getDb()
            .prepare('SELECT id, instance_id, state, label FROM nodes WHERE id = ?')
            .get(named.id) as ReconcileRow | undefined) ?? named
        // The rental's own create may still answer with this instance: in
        // flight (creating), being looked for (lookingUp), or another
        // process's (a 'requested' row with no instance id the last run did
        // not leave). It is that create's to take.
        if (this.creating.has(row.id) || this.lookingUp.has(row.id)) continue
        if (
          row.state === 'requested' &&
          row.instance_id == null &&
          !this.unknownAtBoot.has(row.id)
        ) {
          continue
        }
        if (young) continue
        emit('alert', {
          level: 'warn',
          message: `destroying orphaned instance ${inst.id} (${inst.label})`
        })
        const node = this.claim(row, inst.id)
        this.unknownAtBoot.delete(row.id)
        // 'destroying' while it goes: a last run's 'requested' row read as a
        // node booting (isBooting) for the destroy's minute or more, and
        // scale-up counted it as capacity on its way (n1 review).
        if (node && !DESTROY_STATES.has(node.state)) {
          node.setState('destroying', `orphaned instance ${inst.id}`)
        }
        const gone = await this.ensureInstanceGone(inst.id, { node })
        // Claimed, it is its row's to retry and count. A row that holds
        // another instance could not take it: listed until it is gone.
        if (!gone && !node) {
          unclaimed.set(inst.id, this.unclaimedEntry(inst, 'thisProfile', now))
        }
        continue
      }
      if (young) continue
      const owner = this.ownerOf(inst.label)
      unclaimed.set(inst.id, this.unclaimedEntry(inst, owner, now))
      // Once per other install, not per instance: the reconcile runs every
      // 5 minutes, and another Vast Render on the account (Elliot's second
      // checkout) raised a sticky warning for each node it rented, all
      // session long (n3 review). Its later rentals are in the Unclaimed
      // list, with their rate, and count toward the credit guard's runway.
      const key = this.foreignKey(inst, owner)
      if (key && !this.foreignAlerted.has(key)) {
        this.foreignAlerted.add(key)
        emit('alert', { level: 'warn', message: this.foreignMessage(inst, owner) })
      }
    }
    this.settleUnknownCreates(found)
    // Confirmed gone while this pass awaited Vast (an orphan's destroy): an
    // entry copied above while its destroy was in flight is stale now.
    for (const id of [...unclaimed.keys()]) if (this.goneAt.has(id)) unclaimed.delete(id)
    const before = JSON.stringify(this.listUnclaimed())
    this.unclaimed = unclaimed
    if (JSON.stringify(this.listUnclaimed()) !== before) this.unclaimedChanged()
    // One stdout line, when what it says changes, so a scripted run can
    // confirm what the reconcile saw.
    const line =
      `[orphans] ${instances.length} instance(s) on the account, ${tracked} tracked here, ` +
      `${unclaimed.size} unclaimed: ` +
      instances.map((i) => `${i.id}(${i.label ?? 'no label'})`).join(', ')
    if (line !== this.lastOrphanLine) {
      this.lastOrphanLine = line
      console.log(line)
    }
    return true
  }

  /** One unclaimed instance as the Fleet lists it, keeping when it was first found and why a destroy failed. */
  private unclaimedEntry(inst: RawInstance, owner: UnclaimedOwner, now: number): UnclaimedInstance {
    const prev = this.unclaimed.get(inst.id)
    return {
      instanceId: inst.id,
      label: inst.label ?? null,
      owner,
      gpuName: inst.gpu_name ?? null,
      numGpus: inst.num_gpus ?? 1,
      dphTotal: inst.dph_total ?? null,
      status: inst.actual_status ?? null,
      startedAt: inst.start_date != null ? Math.round(inst.start_date * 1000) : null,
      firstSeenAt: prev?.firstSeenAt ?? now,
      destroyError: this.destroyErrors.get(inst.id) ?? prev?.destroyError ?? null
    }
  }

  /**
   * Whose an unclaimed instance looks to be, from its label: 'thisProfile'
   * when it carries this install's id, though no row here names it (a lost
   * or reset database, or a settings file copied from here); another Vast
   * Render's when it carries another id, or none (a legacy label no row
   * here has); 'unlabelled' for anything else on the account.
   */
  private ownerOf(label: string | undefined): UnclaimedOwner {
    if (!label?.startsWith(LABEL_PREFIX)) return 'unlabelled'
    const install = getSettings().installId?.slice(0, 8)
    const parts = parseRentalLabel(label)
    return install && parts?.install === install ? 'thisProfile' : 'otherVastRender'
  }

  /**
   * The one alert for a Vast Render rental that no row here names, left
   * running either way. Only a row says this database rented an instance:
   * this install's id in its label is only a claim, since a settings file
   * copied from here carries the id too, and destroying the other copy's
   * rental would kill its live render. The wording must not send the user
   * off to "its own app" for an instance that has none.
   */
  private foreignMessage(inst: RawInstance, owner: UnclaimedOwner): string {
    if (owner === 'thisProfile') {
      return `instance ${inst.id} (${inst.label}) carries this install's id but no node here knows it — left running; destroy it from the Vast.ai console if it is stray`
    }
    return `instance ${inst.id} (${inst.label}) was not rented by this profile — left running; destroy it from its own app or the Vast.ai console if it is stray. Its install's other rentals are listed under Fleet › Unclaimed without another alert`
  }

  /**
   * What the one-off alert for an unclaimed instance is keyed by: another
   * install's id, so that install is announced once however many nodes it
   * rents; the instance itself for a legacy label with no install id, or one
   * carrying this install's id; none for an instance with no Vast Render
   * label, which is listed and never announced.
   */
  private foreignKey(inst: RawInstance, owner: UnclaimedOwner): string | null {
    if (owner === 'unlabelled') return null
    const install = parseRentalLabel(inst.label)?.install
    return owner === 'otherVastRender' && install ? `install:${install}` : `instance:${inst.id}`
  }

  /**
   * An orphan the sweep found under the label of one of our rows: record it
   * on that row, so that until Vast confirms it gone it counts against the
   * caps, is metered and is retried like any other failed destroy. The row
   * either never learned the instance id (a create whose reply was lost, or
   * one a crash cut short) or took a destroy as confirmed that Vast now
   * contradicts by listing the instance. A row that holds a different
   * instance keeps it: this one is destroyed with no row to show for it.
   */
  private claim(
    row: { id: string; instance_id: number | null },
    instanceId: number
  ): ManagedNode | undefined {
    if (row.instance_id != null && row.instance_id !== instanceId) return undefined
    getDb()
      .prepare(
        'UPDATE nodes SET instance_id = ?, destroyed_at = NULL, create_unknown_since = NULL WHERE id = ?'
      )
      .run(instanceId, row.id)
    let node = this.nodes.get(row.id)
    if (!node) {
      node = new ManagedNode(row.id)
      this.nodes.set(row.id, node)
    }
    node.emitChanged()
    return node
  }

  /**
   * Rows the last run left with a create of unknown outcome whose label the
   * account's instances do not carry: that create rented nothing, so they
   * stop counting as billing. Without this, each such row (a crash mid-create,
   * a create whose reply was a 5xx) would hold a place under maxActiveNodes
   * and the spend cap for good. Only rows from before this session: the last
   * run is gone, so any create it sent has been answered by now. A create of
   * this session with no known outcome keeps counting until its own label
   * lookup (findLostCreate) settles it.
   *
   * A row whose instance was found stays pending until the reconcile claims
   * that instance: a young one is left to a later pass, and the row must
   * stay counted, and claimable, until then.
   */
  private settleUnknownCreates(found: ReadonlySet<string>): void {
    for (const id of this.unknownAtBoot) {
      if (found.has(id)) continue
      this.unknownAtBoot.delete(id)
      const node = this.nodes.get(id)
      if (!node || !createOutcomeUnknown(node.facts)) continue
      const state = node.state
      if (state === 'requested') {
        node.update({
          state: 'failed',
          create_unknown_since: null,
          last_error: 'the app stopped while renting; Vast has no instance under its label'
        })
      } else if (state === 'destroying') {
        node.update({ state: 'destroyed', create_unknown_since: null })
      } else {
        node.update({ create_unknown_since: null })
      }
    }
  }

  shutdown(): void {
    this.shutDown = true
    if (this.costTimer) clearInterval(this.costTimer)
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    if (this.destroyTimer) clearInterval(this.destroyTimer)
    this.octaneUnsubscribe?.()
    for (const n of this.nodes.values()) n.retire()
  }

  /**
   * Probe every SSH-connected node: sample its GPU/CPU/RAM usage and its
   * agent's heartbeat, which is also how the supervisor (plan 1.7) learns
   * that a node or its agent has stopped answering. One probe per node at a
   * time, all nodes at once: they used to run one after another, so a dead
   * node's timeouts held up everyone's samples and could stack up past the
   * next round.
   */
  private pollMetrics(): void {
    for (const node of this.nodes.values()) {
      const ssh = node.ssh
      if (!ssh || !PROBED.has(node.state)) {
        // Not probed, and paid for all the same while it holds an instance
        // (booting, unreachable, a destroy not yet confirmed): its GPUs are
        // rented and unmeasured, a gap in the history (Feature G).
        const facts = node.facts
        if (facts.instanceId != null && holdsInstance(facts)) this.recordHistory(node, null)
        continue
      }
      if (this.probing.has(node.id)) continue
      this.probing.add(node.id)
      void this.probe(node, ssh).finally(() => this.probing.delete(node.id))
    }
    this.pollOctane()
  }

  /**
   * The licence poll (plan 1.18): every OCTANE_POLL_MS, read the Octane
   * state of each node in the fleet that has run Octane. A sign-in by hand
   * over VNC moves a node from needsLogin to licensed here, and Octane
   * chunks can go to it; nothing else would notice, since the sign-in
   * happens on the node. A server that died reads as none, so the next
   * Octane chunk sets it up again instead of rendering unlicensed.
   */
  private pollOctane(now = Date.now()): void {
    for (const node of this.nodes.values()) {
      const ssh = node.ssh
      if (!ssh || !SUPERVISED.has(node.state) || this.octaneReading.has(node.id)) continue
      if (now - (this.octaneReadAt.get(node.id) ?? 0) < OCTANE_POLL_MS) continue
      if (node.octaneState === 'none') continue
      this.octaneReading.add(node.id)
      this.octaneReadAt.set(node.id, now)
      void refreshOctaneState(ssh, node.id).finally(() => this.octaneReading.delete(node.id))
    }
  }

  /**
   * One poll of a node into the GPU usage history (Feature G), with the
   * runs the scheduler has on each of its GPUs now: `metrics` is the
   * probe's sample, or null for a poll with no reading. The history is a
   * view: nothing in it may stand in a probe's way.
   */
  private recordHistory(node: ManagedNode, metrics: NodeMetrics | null): void {
    try {
      const { numGpus } = node.laneInputs
      const work = activeWorkProvider?.(node.id) ?? []
      recordMetrics(node.id, metrics, runsPerGpu(work, numGpus), { numGpus })
    } catch {
      // A sample the history could not take is one missing point.
    }
  }

  private async probe(node: ManagedNode, ssh: SshConnection): Promise<void> {
    // Still out at PROBE_SLOW_MS: does the node answer at all?
    let alive: Promise<string | null> | null = null
    const slow = setTimeout(() => {
      alive = ssh
        .exec(LIVENESS_COMMAND, {
          timeoutMs: PROBE_TIMEOUT_MS - PROBE_SLOW_MS,
          label: 'node liveness check'
        })
        .then(
          (a) => (/^ok$/m.test(a.stdout) ? a.stdout : null),
          () => null
        )
    }, PROBE_SLOW_MS)
    let r: ExecResult
    try {
      r = await ssh.exec(PROBE_COMMAND, { timeoutMs: PROBE_TIMEOUT_MS, label: 'node probe' })
    } catch (e) {
      clearTimeout(slow)
      // Closed under it by a destroy or a recovery: says nothing of the node.
      if (node.ssh !== ssh) return
      const c = classify(e, { via: 'ssh' })
      const answered = c.rule === 'ssh-exec-timeout' && alive ? await alive : null
      if (node.ssh !== ssh) return
      if (answered != null) this.probeSlow(node, answered)
      else this.probeFailed(node, c.reason)
      this.recordHistory(node, null)
      return
    }
    clearTimeout(slow)
    if (node.ssh !== ssh) return
    // What ssh2 hands back for a channel whose connection went: no exit
    // status (undefined; null for a signal) and no output. Only null was
    // read so, and on real ssh2 a probe the link dropped under reset the
    // node's strikes and stamped it as answering.
    if (exitStatus(r.code) === null && !r.stdout.trim()) {
      this.probeFailed(node, 'the connection dropped under the probe')
      this.recordHistory(node, null)
      return
    }
    this.probeAnswered(node)
    this.slowProbes.delete(node.id)
    const [gpuPart, cpuPart, memPart, beatPart] = r.stdout.split('----')
    this.heartbeatSeen(node, heartbeatAge(beatPart))
    let sample: NodeMetrics | null = null
    try {
      sample = this.recordSample(node, gpuPart, cpuPart, memPart)
    } catch {
      // A sample that does not parse is skipped: a gap in the history.
    }
    this.recordHistory(node, sample)
  }

  /**
   * Store one probe's usage sample, integrate its energy, and push it.
   * Returns it, or null when the probe's output held no GPU reading.
   */
  private recordSample(
    node: ManagedNode,
    gpuPart: string | undefined,
    cpuPart: string | undefined,
    memPart: string | undefined
  ): NodeMetrics | null {
    if (!gpuPart || !cpuPart) return null
    // Only the first four columns must parse: cards that don't report
    // power give "[N/A]" and would otherwise drop the whole sample.
    const gpuRows = gpuPart
      .trim()
      .split('\n')
      .map((line) => line.split(',').map((x) => parseFloat(x)))
      .filter((xs) => xs.length >= 4 && xs.slice(0, 4).every((x) => Number.isFinite(x)))
    if (gpuRows.length === 0) return null
    const sumCol = (i: number): number =>
      gpuRows.reduce((a, xs) => a + (Number.isFinite(xs[i]) ? xs[i] : 0), 0)
    const powerW = sumCol(4)
    const cpuLines = cpuPart.trim().split('\n')
    const load1 = parseFloat(cpuLines[0]?.split(' ')[0] ?? '0')
    const cores = parseInt(cpuLines[1] ?? '0', 10)
    // /proc/meminfo is in kB; "used" = total - available (the number that
    // actually predicts an OOM, unlike total - free).
    const meminfo = (key: string): number => {
      const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(memPart ?? '')
      return m ? parseInt(m[1], 10) / (1024 * 1024) : 0
    }
    const ramTotalGb = meminfo('MemTotal')
    const ramAvailGb = meminfo('MemAvailable')
    // Energy: rectangle-integrate this power reading over the gap since
    // the previous sample (skipping absurd gaps after a sleep/disconnect).
    const now = Date.now()
    const prevAt = metricsByNode.get(node.id)?.updatedAt
    const gapMs = prevAt ? now - prevAt : 0
    if (powerW > 0 && gapMs > 0 && gapMs < 10 * 60_000) {
      energyByNode.set(node.id, (energyByNode.get(node.id) ?? 0) + (powerW * gapMs) / 3_600_000)
    }
    const sample: NodeMetrics = {
      cpuUtil: cpuUtilFromStat(node.id, memPart ?? '', load1, cores),
      gpuUtil: gpuRows.reduce((a, xs) => a + xs[0], 0) / gpuRows.length,
      vramUsedGb: gpuRows.reduce((a, xs) => a + xs[1], 0) / 1024,
      vramTotalGb: gpuRows.reduce((a, xs) => a + xs[2], 0) / 1024,
      gpuTemp: Math.max(...gpuRows.map((xs) => xs[3])),
      powerW,
      powerLimitW: sumCol(5),
      cpuLoad1: Number.isFinite(load1) ? load1 : 0,
      cpuCores: Number.isFinite(cores) ? cores : 0,
      ramUsedGb: Math.max(0, ramTotalGb - ramAvailGb),
      ramTotalGb,
      updatedAt: now,
      gpus: gpuRows.map((xs, i): GpuSample => ({
        index: Number.isFinite(xs[6]) ? xs[6] : i,
        util: xs[0],
        vramUsedGb: xs[1] / 1024,
        vramTotalGb: xs[2] / 1024,
        temp: xs[3],
        powerW: Number.isFinite(xs[4]) ? xs[4] : 0
      }))
    }
    metricsByNode.set(node.id, sample)
    emit('node:changed', node.snapshot)
    return sample
  }

  // -- liveness supervision (plan 1.7) -------------------------------------------

  /**
   * A probe got through: whatever run of failures the node had is over, a
   * dropped connection included (it reconnected).
   */
  private probeAnswered(node: ManagedNode): void {
    node.takeDrops()
    this.strikes.delete(node.id)
    lastContactByNode.set(node.id, Date.now())
  }

  /**
   * A probe timed out, and the node answered the liveness check sent beside
   * it (PROBE_SLOW_MS): it answers, only its sample is slow. No sample this
   * round; the heartbeat the check read is taken as the probe's would be.
   */
  private probeSlow(node: ManagedNode, stdout: string): void {
    this.probeAnswered(node)
    this.heartbeatSeen(node, heartbeatAge(stdout))
    if (this.slowProbes.has(node.id)) return
    this.slowProbes.add(node.id)
    emit('render:logLine', {
      nodeId: node.id,
      chunkId: null,
      line: `the usage probe (nvidia-smi) took over ${PROBE_TIMEOUT_MS / 1000}s, but the node answers: kept in the fleet, without usage samples until it is quicker`,
      ts: Date.now()
    })
  }

  /**
   * A probe failed. Past UNREACHABLE_STRIKES in a row, over at least
   * UNREACHABLE_AFTER_MS, the node is taken out of the fleet and looked
   * into (nodeSilent). Only a node work is sent to is counted: one being
   * provisioned or recovered has a deadline of its own.
   */
  private probeFailed(node: ManagedNode, reason: string): void {
    if (!SUPERVISED.has(node.state) || this.recovering.has(node.id)) {
      this.strikes.delete(node.id)
      return
    }
    const now = Date.now()
    const s = this.strikes.get(node.id) ?? { count: 0, since: now, reason }
    s.count += 1 + node.takeDrops()
    s.reason = reason
    this.strikes.set(node.id, s)
    if (s.count < UNREACHABLE_STRIKES || now - s.since < UNREACHABLE_AFTER_MS) return
    this.strikes.delete(node.id)
    this.nodeSilent(node, s)
  }

  /**
   * The node has not answered a probe for UNREACHABLE_AFTER_MS or more: out
   * of the fleet ('unreachable', which tick() sends nothing to), and then
   * Vast is asked what became of it (recoverUnreachable).
   *
   * Its chunks are not given back yet. A node that comes back with its agent
   * alive carries on with them, as if nothing happened; a node Vast has
   * stopped or lost, or one that does not come back, gives them back then.
   * Giving them back at once would have another node render them while this
   * one, back a minute later, rendered them too, paid for twice.
   */
  private nodeSilent(node: ManagedNode, s: Strikes): void {
    const last = lastContactByNode.get(node.id) ?? s.since
    const secs = Math.max(0, Math.round((Date.now() - last) / 1000))
    node.setState('unreachable', `no answer over SSH for ${secs}s: ${s.reason}`)
    void this.recoverUnreachable(node, { askVast: true, why: s.reason })
  }

  /**
   * What a probe said of the agent's heartbeat. Stale on AGENT_STALE_PROBES
   * probes in a row, on a node work is sent to, and the agent is taken for
   * dead (restoreAgent): SSH answers, but nothing takes the chunks sent to
   * the node, and those it had stop where they were. A container restart
   * does that, since nothing on the node starts the agent again.
   */
  private heartbeatSeen(node: ManagedNode, age: number | null | undefined): void {
    const stale = age === null || (age !== undefined && age > AGENT_STALE_S)
    if (!stale || !SUPERVISED.has(node.state) || this.recovering.has(node.id)) {
      this.staleBeats.delete(node.id)
      return
    }
    const seen = (this.staleBeats.get(node.id) ?? 0) + 1
    this.staleBeats.set(node.id, seen)
    if (seen < AGENT_STALE_PROBES) return
    this.staleBeats.delete(node.id)
    void this.restoreAgent(node, age == null ? 'no agent heartbeat' : `agent heartbeat ${age}s old`)
  }

  /**
   * A node SSH answers whose agent looks dead: out of the fleet
   * ('provisioning', sent nothing) while reviveAgent looks at the agent and
   * restarts it if it is, then back. Given up on if the agent cannot be
   * brought back, or that passes PROVISION_DEADLINE_MS.
   *
   * A check that tells nothing about the agent is not that: the link going
   * under it, or another restart-agent holding the node. The node is then
   * taken for one that stopped answering, out of the fleet ('unreachable'),
   * and recover() brings it back or lets it go, in reconnect rounds with
   * Vast asked after each, and never destroys it while Vast is silent too.
   * One such blip used to destroy the node.
   */
  private async restoreAgent(node: ManagedNode, why: string): Promise<void> {
    const ssh = node.ssh
    if (!ssh || this.recovering.has(node.id)) return
    this.recovering.add(node.id)
    try {
      const before = (activeWorkProvider?.(node.id) ?? []).map((w) => w.chunkId)
      node.setState('provisioning', `${why}: checking the agent`)
      const held: NodeState = 'provisioning'
      try {
        const revival = await withDeadline(
          this.reviveAgent(node, ssh, before),
          PROVISION_DEADLINE_MS,
          'bringing the agent back'
        )
        if (node.movedOn(held)) return
        this.backInService(node, revival, why)
      } catch (e) {
        if (node.movedOn(held) || this.shutDown) return
        const reason = failureReason(e)
        if (linkFailed(e) || e instanceof AgentBusyError) {
          node.setState('unreachable', `${why}, and checking the agent failed: ${reason}`)
          await this.recover(node, { askVast: true, why: reason })
          return
        }
        await this.giveUp(node, `${why}, and the agent could not be brought back: ${reason}`, {
          connected: true
        })
      }
    } finally {
      this.recovering.delete(node.id)
    }
  }

  /**
   * Bring the agent of a node that answers over SSH to a known state before
   * it takes work again. It used to be marked 'ready' on a bare reconnect,
   * whatever its agent was doing, so the chunks of a restarted container
   * waited for good on an agent nobody had started (#33 #139, audit A6).
   *
   * - A node this session never provisioned (resumed at start-up while SSH
   *   was down) gets the whole of onReady, as resumeNode would have given
   *   it. So does one whose tree has no agent-status.
   * - A live agent running this build's code is kept, renders and all, as
   *   long as the app still holds work on the node, or it has none: the
   *   node carries on where it was. Chunks of `before` (what the node had
   *   when it went silent) that the app gave back meanwhile are stopped
   *   there first (withdrawGivenBack).
   * - A live agent rendering work the app no longer holds at all (the
   *   scheduler gave the chunks back while the node was silent) is
   *   restarted: its renders would be paid for with nobody to collect them.
   * - A dead one is restarted (deps first if they are not this build's),
   *   unless it has been AGENT_RESTARTS_MAX times within the hour already.
   *
   * The node's runs are forgotten exactly when the agent was restarted,
   * since that killed their renders (restartAgent); never on a check made
   * beforehand, which can go stale in between. A restart-agent that ended
   * without a verdict (the link went, it timed out, another one held the
   * node) may have restarted it, and counts as one.
   */
  private async reviveAgent(
    node: ManagedNode,
    ssh: SshConnection,
    before: readonly string[] = []
  ): Promise<AgentRevival> {
    if (!this.provisioned.has(node.id)) return this.reprovision(node, ssh)
    const status = await agentStatus(ssh)
    if (!status) return this.reprovision(node, ssh)
    const held = activeWorkProvider?.(node.id).length ?? 0
    const now = Date.now()
    const recent = (this.agentRestarts.get(node.id) ?? []).filter(
      (t) => now - t < AGENT_RESTART_WINDOW_MS
    )
    if (!status.restartNeeded) {
      if (held > 0) {
        const withdrawn = await this.withdrawGivenBack(node, ssh, before)
        return { kind: 'kept', renders: Math.max(0, status.blenderProcs - withdrawn), withdrawn }
      }
      if (status.blenderProcs === 0 && status.inboxSpecs === 0) {
        return { kind: 'kept', renders: 0, withdrawn: 0 }
      }
    } else {
      if (recent.length >= AGENT_RESTARTS_MAX) {
        throw new Error(
          `its agent had to be restarted ${recent.length} times within the hour (now: ${status.restartReason})`
        )
      }
      if (!status.depsCurrent) await provisionDeps(ssh, node.id)
    }
    let r: AgentRestart
    try {
      r = await restartAgent(ssh, node.id, { force: !status.restartNeeded })
    } catch (e) {
      forgetNodeProvider?.(node.id)
      throw e
    }
    if (!r.restarted) return { kind: 'kept', renders: status.blenderProcs, withdrawn: 0 }
    forgetNodeProvider?.(node.id)
    if (status.restartNeeded) this.agentRestarts.set(node.id, [...recent, Date.now()])
    return {
      kind: 'restarted',
      reason: status.restartNeeded ? r.reason : 'it was rendering work the app no longer holds'
    }
  }

  /**
   * Stop on a node that answers again the chunks of `before` the app has
   * given back since it went silent: a cancel whose own pkill could not
   * reach the node, a run the scheduler gave up on (STATE_UNREADABLE_MS)
   * while a sibling's had not yet. Their specs are removed and their renders
   * killed, as retractSpec does. Kept, they rendered there as well as where
   * they went, paid for twice, on lanes the app counts as free. The node's
   * other renders go on. How many chunks it withdrew.
   */
  private async withdrawGivenBack(
    node: ManagedNode,
    ssh: SshConnection,
    before: readonly string[]
  ): Promise<number> {
    const holds = new Set((activeWorkProvider?.(node.id) ?? []).map((w) => w.chunkId))
    const given = before.filter((id) => !holds.has(id))
    if (given.length === 0) return 0
    const label = 'withdraw given-back chunks'
    const r = await ssh.exec(withdrawCommand(given), { timeoutMs: WITHDRAW_TIMEOUT_MS, label })
    // No exit status: the link went, and whether the renders were stopped is
    // not known. Taken as done, they rendered on, paid for twice.
    if (exitStatus(r.code) === null) throw new ConnectionLostError(label)
    emit('render:logLine', {
      nodeId: node.id,
      chunkId: null,
      line: `stopped ${given.length} chunk(s) given back while the node was silent: ${given.join(', ')}`,
      ts: Date.now()
    })
    return given.length
  }

  /**
   * The whole of onReady on a node that answers again. It restarts the
   * agent, so every run on the node goes first.
   */
  private async reprovision(node: ManagedNode, ssh: SshConnection): Promise<AgentRevival> {
    forgetNodeProvider?.(node.id)
    if (this.onReady) await this.onReady({ id: node.id, ssh })
    this.provisioned.add(node.id)
    return { kind: 'reprovisioned' }
  }

  /** A recovered node takes work again: 'rendering' if the scheduler still holds some on it. */
  private backInService(node: ManagedNode, revival: AgentRevival, why: string): void {
    const busy = (activeWorkProvider?.(node.id).length ?? 0) > 0
    node.setState(busy ? 'rendering' : 'ready')
    const done =
      revival.kind === 'kept'
        ? `its agent was alive and kept its ${revival.renders} render(s)` +
          (revival.withdrawn > 0 ? `, less ${revival.withdrawn} chunk(s) given back meanwhile` : '')
        : revival.kind === 'restarted'
          ? `its agent was restarted${revival.reason ? ` (${revival.reason})` : ''}`
          : 'it was provisioned again'
    emit('render:logLine', {
      nodeId: node.id,
      chunkId: null,
      line: `back in service after ${why}: ${done}`,
      ts: Date.now()
    })
    if (revival.kind !== 'kept') {
      emit('alert', {
        level: 'info',
        message: `Node ${nodeName(node.snapshot)} is back after ${why}: ${done}`
      })
    }
  }

  /** What Vast says about an instance SSH no longer reaches. Never rejects. */
  private async askVast(instanceId: number): Promise<InstanceFate> {
    try {
      const inst = await showInstance(instanceId)
      if (!inst) return { kind: 'gone' }
      return instanceStopped(inst) ? { kind: 'stopped', inst } : { kind: 'up', inst }
    } catch (e) {
      return { kind: 'silent', reason: classify(e, { via: 'vast' }).reason }
    }
  }

  /**
   * A node SSH lost whose instance Vast has stopped or no longer knows: its
   * chunks go back to the queue, and the instance is destroyed. A stopped
   * one still bills for its disk, and Vast will not start it again by
   * itself. One Vast no longer knows is destroyed all the same, and its
   * DELETE's 404 is what confirms it gone: showInstance answering null is
   * not proof on its own (a 200 without an instance reads the same), and
   * only a confirmed destroy settles a row (ensureInstanceGone). Not
   * blacklisted: at a $0 balance Vast stops every instance of the account,
   * whatever the machine (1d59516c).
   */
  private async lost(
    node: ManagedNode,
    instanceId: number,
    fate: Extract<InstanceFate, { kind: 'gone' | 'stopped' }>,
    why: string
  ): Promise<void> {
    const status =
      fate.kind === 'gone'
        ? 'Vast no longer knows its instance'
        : `Vast reports its instance ${fate.inst.actual_status ?? fate.inst.intended_status ?? 'stopped'}`
    const reason = `SSH stopped answering (${why}) and ${status}`
    forgetNodeProvider?.(node.id)
    emit('alert', {
      level: 'warn',
      message: `Node ${nodeName(node.snapshot)}: ${reason}. ${fate.kind === 'gone' ? 'It is gone.' : 'Destroying it.'}`
    })
    node.closeSsh()
    node.setState('destroying', reason)
    await this.ensureInstanceGone(instanceId, { node, reason })
  }

  list(): NodeSnapshot[] {
    return [...this.nodes.values()].map((n) => n.snapshot)
  }

  get(id: string): ManagedNode | undefined {
    return this.nodes.get(id)
  }

  /**
   * What this session rented the node as (RentalFacts), or null for one it
   * did not rent: from before a restart, or unknown to it.
   */
  rentalOf(id: string): RentalFacts | null {
    const r = this.nodes.get(id)?.rental
    return r ? { ...r } : null
  }

  /**
   * The nodes that count against maxActiveNodes and the spend cap, and their
   * $/hr: every node that may be billing (shared/nodeState.ts
   * countsTowardCaps). That is booting, working and being destroyed, and
   * also 'failed' with its destroy unconfirmed, or with a create whose
   * outcome is unknown. Leaving those out, as each inline list of states
   * here once did, let the scheduler rent a replacement next to an instance
   * that was still billing (#64 #194). scalePolicy can read the same from
   * list() through capacityBudget: snapshots carry destroyedAt and
   * createUnknownSince.
   */
  capUsage(): { nodes: number; perHour: number } {
    return capUsage([...this.nodes.values()].map((n) => n.facts))
  }

  /** Nodes that count against maxActiveNodes: see capUsage. */
  activeCount(): number {
    return this.capUsage().nodes
  }

  /** $/hr of every node that may be billing: see capUsage. */
  billingPerHour(): number {
    return this.capUsage().perHour
  }

  /**
   * Rent the best matching offer and drive it to ready: the Fleet's button
   * (fleet:requestNode). It stops at the spend cap, as scale-up does, unless
   * the user confirmed going past it (`overSpendCap`, plan 1.5), and then
   * rents nothing dearer than `maxPerHour` when the confirmation named one.
   * It used to ignore the cap altogether. It never goes past maxActiveNodes,
   * nor rents while the account is on hold. `engine` rents for that engine
   * (its docker image, and for Octane its secure-cloud setting).
   */
  async requestNode(
    opts: RequestNodeOptions & { maxPerHour?: number | null; engine?: EngineId | null } = {}
  ): Promise<string> {
    const held = this.accountHold()
    if (held) throw new Error(`Renting is paused: ${held.reason}`)
    const settings = getSettings()
    if (this.activeCount() >= settings.maxActiveNodes) {
      throw new Error(`max active nodes (${settings.maxActiveNodes}) reached`)
    }
    const overSpendCap = opts.overSpendCap === true
    if (!overSpendCap) {
      const caps = this.liveCaps(settings)
      if (caps.headroomPerHour != null && !(caps.headroomPerHour > 0)) {
        throw new Error(spendCapReached(caps, settings))
      }
    }
    const ids = await this.rentBatch(
      1,
      { overSpendCap, maxPerHour: opts.maxPerHour, engine: opts.engine },
      true
    )
    if (ids.length > 0) return ids[0]
    // Vast refused for the account in this very request: its hold says why.
    const refused = this.accountHold()
    if (refused) throw new Error(`Renting is paused: ${refused.reason}`)
    throw new Error('no node could be rented')
  }

  /**
   * The caps as they stand now: maxActiveNodes and the spend cap, over every
   * node that may be billing (nodeState.capacityBudget). A null cap without
   * noSpendCap is $0/hr, as capacityBudget reads it. `overSpendCap` lifts
   * the money part only.
   */
  private liveCaps(settings: SettingsPublic, overSpendCap = false): CapacityBudget {
    const caps = capacityBudget(
      [...this.nodes.values()].map((n) => n.facts),
      settings
    )
    return overSpendCap ? { ...caps, spendCap: null, headroomPerHour: null } : caps
  }

  /**
   * What renting `offer` brings to the fleet, for spending a scheduler
   * budget's demand down (plan 1.5, #227 #237): its GPU lanes for `engine`
   * and the shared slots it will start at.
   */
  private contribution(
    offer: Offer,
    settings: SettingsPublic,
    engine: EngineId | null | undefined
  ): RentalContribution {
    let learned: number | null = null
    try {
      learned = learnedSlots(offer.gpuName)?.bestSlots ?? null
    } catch {
      // Nothing learned readable: the default seed.
    }
    return offerContribution(offer, {
      slotsPerGpu: normaliseSlotsPerGpu(settings.slotsPerGpu),
      maxNodeSlots: settings.maxNodeSlots ?? 0,
      learnedSlotsPerGpu: learned,
      engine: engine ?? null
    })
  }

  /**
   * Rent up to `count` nodes from ONE offer search, best-ranked first.
   *
   * One search per batch rather than per node: it is the slow call, and
   * renting down the ranked list is exactly what repeated searches would do
   * anyway. Machines are never rented twice in a batch, and an offer that
   * fails to rent (taken by someone else meanwhile) blacklists its machine and
   * moves on to the next.
   *
   * The spend cap is a budget, not a yes/no (plan 1.5, audit A7). The search
   * asks only for offers priced within what the cap has left
   * (maxDphTotal = min(filter, headroom)), and before each rental the caps
   * are taken afresh from the live fleet and settings, and the offer must fit
   * them after its own price: under a $2/h cap with $1.95/h running, only an
   * offer at $0.05/h or less. "Still under the cap" used to be enough, and
   * rented an $8/h box on top of it. maxActiveNodes is re-read before every
   * rental too: each create awaits Vast, and meanwhile the user can lower it,
   * or a quit's destroy-all start. `budget` (the scheduler's plan) adds the
   * demand still to cover; `overSpendCap` (a confirmed manual request) lifts
   * the money part.
   *
   * A create that gets no answer ends the batch (plan 1.4): the instance may
   * exist, billing, under the row's label, and renting the next offer at once
   * is how one lost reply became two instances (#223 #231). The batch waits
   * for the label lookup to find it or confirm there is none, a minute at
   * most. So does a refusal that is no fault of the offer's (a 429): the next
   * offer would meet it too. And so does an account refusal (plan 1.20): it
   * sets the account hold, and nothing is rented until that is released.
   *
   * A search the cap left empty is not repeated at that headroom for
   * CAP_EMPTY_BACKOFF_MS: such a call returns [] without asking Vast.
   *
   * For Octane (`engine`), a sign-in by hand bounds the batch as well
   * (octaneRentalRoom): no more nodes waiting for a sign-in than are signed
   * in, one before any is, and none after a sign-in nobody made.
   */
  async requestNodes(count: number, opts: RequestNodesOptions = {}): Promise<string[]> {
    return this.rentBatch(count, opts, false)
  }

  /**
   * How many Octane nodes scale-up may rent now (plan 1.18 review). A
   * sign-in by hand needs the user at each node's desktop, and nothing says
   * they are there until one is signed in. Field incident A1's shape: the
   * user away overnight, and every node rented for the queue waiting on a
   * sign-in nobody made, billing idle, let go, and rented again.
   *
   * - None while a sign-in has been missed (octaneLicense's
   *   octaneSignInHold), until the user acts.
   * - Signed in by hand: no more nodes waiting for a sign-in than there are
   *   signed in, and one before any is. Waiting is a live node rented for
   *   Octane, or with OctaneServer up, that is not licensed.
   * - A scripted sign-in waits on nobody: the caps alone.
   */
  private octaneRentalRoom(settings: SettingsPublic): number {
    if (octaneSignInHold()) return 0
    const secureCloud = settings.octane?.secureCloudOnly === true
    if (scriptedSignInFor({ engine: 'octane', secureCloud })) return Infinity
    let licensed = 0
    let waiting = 0
    for (const n of this.nodes.values()) {
      if (DESTROY_STATES.has(n.state) || !holdsInstance(n.facts)) continue
      const octane = n.octaneState
      if (octane === 'licensed') licensed++
      else if (octane !== 'none' || n.rental?.engine === 'octane') waiting++
    }
    return Math.max(0, Math.max(1, licensed) - waiting)
  }

  /** requestNodes, and requestNode's rental (`manual`), which always searches. */
  private async rentBatch(
    count: number,
    opts: RequestNodesOptions,
    manual: boolean
  ): Promise<string[]> {
    if (count <= 0) return []
    // Held for the account (plan 1.20): the hold's one alert has said why.
    // Scale-up asks every tick, and each ask used to add a failed row.
    if (this.hold) return []
    let settings = getSettings()
    // Octane signed in by hand waits on the user (plan 1.18): the Fleet's
    // own request is the user acting, and is not bounded here.
    if (opts.engine === 'octane' && !manual) {
      count = Math.min(count, this.octaneRentalRoom(settings))
      if (count <= 0) return []
    }
    // activeCount rather than the budget's own count: quit's destroy-all
    // stops renting by making it read as full (lifecycle.ts fleetPort).
    if (this.activeCount() >= settings.maxActiveNodes) return []
    const overSpendCap = opts.overSpendCap === true
    const first = this.liveCaps(settings, overSpendCap)
    const firstBudget = opts.budget ? withDemand(first, opts.budget) : first
    if (!budgetOpen(firstBudget)) return []

    const bound = opts.maxPerHour != null && opts.maxPerHour >= 0 ? opts.maxPerHour : null
    const filterMax = settings.offerFilters.maxDphTotal
    const headroom = first.headroomPerHour
    let maxDphTotal = filterMax
    for (const c of [headroom, bound]) {
      if (c != null && (maxDphTotal == null || c < maxDphTotal)) maxDphTotal = c
    }
    const capBound = headroom != null && maxDphTotal === headroom
    // Plan 1.18: what the rentals are for decides their image, and whether
    // only datacenter hosts may take them (an Octane sign-in, by hand or
    // scripted, is disclosed to whoever has root on the node).
    const image = rentalImage(settings, opts.engine)
    const secureCloudOnly = opts.engine === 'octane' && settings.octane?.secureCloudOnly === true
    const filters = JSON.stringify({ ...settings.offerFilters, secureCloudOnly })
    const lastEmpty = this.capEmpty
    if (
      !manual &&
      capBound &&
      lastEmpty &&
      headroom <= lastEmpty.headroom + 1e-9 &&
      lastEmpty.filters === filters &&
      Date.now() - lastEmpty.at < CAP_EMPTY_BACKOFF_MS
    ) {
      return []
    }
    let offers: Offer[]
    try {
      await ensureKeyRegistered()
      offers = await findOffers({ ...settings.offerFilters, maxDphTotal }, this.blacklist, {
        secureCloudOnly
      })
    } catch (e) {
      // Vast refusing the account before any create (a key it rejects, or
      // one without the permission to register an SSH key or search): the
      // account hold and its one alert, as a create refused for it gets,
      // not a scale-up failure on every tick (n3 review).
      const c = classify(e, { via: 'vast' })
      if (c.kind !== 'account') throw e
      this.accountRefused(c)
      return []
    }
    if (offers.length === 0) {
      // The cap may be what left nothing: say so, and do not cry "no offers"
      // on every tick while the fleet sits just under its cap.
      const where = secureCloudOnly ? ' on datacenter (secure cloud) hosts' : ''
      if (capBound) {
        this.capEmpty = { headroom, filters, at: Date.now() }
        throw new NoMatchingOffersError(
          `no matching offers${where} at or under ${money(headroom)}/hr, what the spend cap of ${money(first.spendCap ?? 0)}/hr leaves`,
          'spendCap'
        )
      }
      if (bound != null && maxDphTotal === bound) {
        throw new NoMatchingOffersError(
          `no matching offers${where} at or under ${money(bound)}/hr`,
          'price'
        )
      }
      if (secureCloudOnly) {
        emit('alert', {
          level: 'warn',
          message:
            'No matching Vast.ai offers on datacenter (secure cloud) hosts, which the Octane ' +
            'settings rent from only'
        })
        throw new NoMatchingOffersError(
          'no matching offers on datacenter (secure cloud) hosts',
          'filters'
        )
      }
      emit('alert', { level: 'warn', message: 'No matching Vast.ai offers found' })
      throw new NoMatchingOffersError('no matching offers', 'filters')
    }
    if (capBound) this.capEmpty = null
    const ids: string[] = []
    const usedMachines = new Set<number>()
    let lastErr: Error | null = null
    let failures = 0
    let carried: CapacityBudget | null = opts.budget ?? null
    for (const offer of offers) {
      if (ids.length >= count) break
      // A systemic refusal (no credit, a bad key) fails every offer the same
      // way; stop before it turns into a failed node row per offer.
      if (failures >= 3) break
      if (this.hold) break
      settings = getSettings()
      if (this.activeCount() >= settings.maxActiveNodes) break
      const live = this.liveCaps(settings, overSpendCap)
      const budget = carried ? withDemand(live, carried) : live
      if (!budgetOpen(budget)) break
      if (usedMachines.has(offer.machineId) || this.blacklist.has(offer.machineId)) continue
      // Too dear for what is left now; one further down the ranking may fit.
      if (!fitsBudget(budget, offer.dphTotal)) continue
      if (bound != null && offer.dphTotal > bound) continue
      usedMachines.add(offer.machineId)
      let r: Rental
      try {
        r = await this.rentOffer(offer, settings.offerFilters.minDiskGb, {
          engine: opts.engine ?? null,
          image,
          secureCloud: secureCloudOnly
        })
      } catch (e) {
        // Not a failure rentOffer knows (those it returns): whatever it left
        // behind, rent nothing more on top of it.
        r = { error: e as Error, stop: true }
      }
      if ('error' in r) {
        lastErr = r.error
        failures++
      } else {
        ids.push(r.id)
        if (carried) {
          carried = subtractRental(budget, offer, this.contribution(offer, settings, opts.engine))
        }
      }
      if (r.stop) break
    }
    // An account refusal set the hold, and its alert has said why; a throw
    // on top would be a second alert (scale-up failed: …) for one refusal.
    if (ids.length === 0 && lastErr && !this.hold) throw lastErr
    return ids
  }

  // -- the account hold (plan 1.20) ---------------------------------------------

  /**
   * The holds on renting this module owns: the account's (plan 1.20). The
   * scheduler adds its own (recovery, local sink) to build FleetHolds.
   */
  getHolds(): FleetHolds {
    const account = this.accountHold()
    return account ? { account } : {}
  }

  /** The account hold as FleetHolds carries it, or null while renting is free. */
  accountHold(): NonNullable<FleetHolds['account']> | null {
    const h = this.hold
    return h ? { reason: h.reason, balance: h.balance, since: h.since } : null
  }

  /**
   * Called when a rental's boot ends (driveToReady): `failure` is null once
   * the node is ready, else why it never became usable (a machine that
   * would not boot, provisioning that failed or ran past its deadline). Not
   * for an account refusal (the account hold) or Vast being silent the
   * whole boot: neither says anything about renting again. The scheduler
   * counts failures toward its scale backoff (plan 1.17). Returns the
   * unsubscribe function.
   */
  onBootEnded(listener: (nodeId: string, failure: string | null) => void): () => void {
    this.bootListeners.add(listener)
    return () => {
      this.bootListeners.delete(listener)
    }
  }

  private bootEnded(nodeId: string, failure: string | null): void {
    for (const l of [...this.bootListeners]) {
      try {
        l(nodeId, failure)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /**
   * Called with this module's holds whenever one is set or released (for
   * fleet:holds). Returns the unsubscribe function.
   */
  onHoldsChanged(listener: (holds: FleetHolds) => void): () => void {
    this.holdListeners.add(listener)
    return () => {
      this.holdListeners.delete(listener)
    }
  }

  /**
   * The user releases the account hold (fleet:releaseHold('account')).
   * Renting may resume at once. A runway still under RUNWAY_HOLD_MIN does not
   * set it again until it has recovered first; Vast refusing a rental for
   * credit does, at once. Returns the holds left.
   */
  releaseAccountHold(): FleetHolds {
    if (this.hold) this.releaseHold('Renting resumes: the account hold was released by hand')
    return this.getHolds()
  }

  private holdsChanged(): void {
    const holds = this.getHolds()
    for (const l of [...this.holdListeners]) {
      try {
        l(holds)
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /**
   * Pause renting for the account, with one alert. The first reason stands
   * while held. A credit or runway hold is kept in app_state, so a relaunch
   * does not rent into an empty account; an auth hold is for the session.
   */
  private setHold(h: Omit<AccountHold, 'since'>, message: string, level: 'warn' | 'error'): void {
    if (this.hold) return
    this.hold = { ...h, since: Date.now() }
    this.saveHold()
    emit('alert', { level, message })
    this.holdsChanged()
  }

  private saveHold(): void {
    const h = this.hold
    const keep = h && h.cause !== 'auth'
    writeAppState(getDb(), 'account_hold', keep ? JSON.stringify(h) : null)
  }

  private releaseHold(message: string): void {
    if (!this.hold) return
    this.hold = null
    writeAppState(getDb(), 'account_hold', null)
    this.runwayWarned = false
    emit('alert', { level: 'info', message })
    this.holdsChanged()
  }

  /**
   * Vast refused for the account (classify kind 'account'): no credit, or a
   * key it rejects or that may not rent. No machine is at fault, so none is
   * blacklisted, and the next offer would meet the same refusal: hold.
   * Field incident 1d59516c: with the balance at $0, scale-up made 12 rent
   * attempts, each refused with 400 insufficient_credit, each a failed row
   * and a blacklisted machine, and no alert said why.
   */
  private accountRefused(c: Classification): void {
    const credit = c.rule === 'vast-credit' || c.rule === 'vast-402'
    const perHour = this.accountPerHour().total
    if (credit) {
      const b = this.balance
      this.setHold(
        { reason: c.reason, balance: b, cause: 'credit', perHour },
        `Vast balance ${b != null ? money(b) : 'unknown'}: Vast refused a rental for lack of credit, so renting is paused until the balance goes up. Top up in the Vast.ai console; no machine was blacklisted. (${c.reason})`,
        'error'
      )
      return
    }
    this.setHold(
      {
        reason: c.reason,
        balance: this.balance,
        cause: 'auth',
        perHour,
        rule: c.rule,
        key: keyFingerprint()
      },
      `Vast refused the account (${c.reason}): renting is paused until the Vast.ai API key is fixed in Settings`,
      'error'
    )
  }

  /**
   * What the Vast balance pays for per hour (plan 1.20): this fleet's nodes
   * that may be billing, and every other instance on the account that the
   * last reconcile listed as unclaimed (another install's fleet, a stray),
   * since one balance pays for them all. On this fleet's rate alone, two
   * apps renting on one account each read a runway that would last, and
   * neither warned before the account hit $0. An unclaimed instance Vast
   * has stopped ('exited', 'stopped') bills its storage only and is left
   * out.
   */
  private accountPerHour(): AccountRate {
    const fleet = this.billingPerHour()
    let others = 0
    let otherCount = 0
    for (const u of this.unclaimed.values()) {
      if (u.dphTotal == null || !(u.dphTotal > 0)) continue
      if (u.status === 'exited' || u.status === 'stopped') continue
      others += u.dphTotal
      otherCount++
    }
    return { fleet, others, otherCount, total: fleet + others }
  }

  /**
   * The credit guard (plan 1.20), on every balance reading: the runway is
   * the balance over what the account bills (accountPerHour). Field incident
   * 1d59516c: the balance hit $0 mid-render and nothing had said it was
   * running low.
   *
   * - Under RUNWAY_WARN_MIN: one warning, until the runway is back over
   *   RUNWAY_REARM_MIN.
   * - Under RUNWAY_HOLD_MIN, or nothing left: the account hold, set as the
   *   runway crosses the line (so a hold released by hand is not set again
   *   until the runway has recovered first).
   * - Held: released once the balance has gone up, a top-up, and lasts at
   *   least RUNWAY_RELEASE_MIN at the higher of the account's rate now and
   *   when it was held. An auth hold waits for a key, not for money: it
   *   lifts once Vast answers a key other than the one it refused (saved in
   *   Settings before onApiKeySaved is wired, or with it).
   */
  private guardCredit(balance: number, rate: AccountRate): void {
    const perHour = rate.total
    const runway = runwayMinutes(balance, perHour)
    const h = this.hold
    if (h) {
      if (h.cause === 'auth') {
        if (keyFingerprint() !== h.key) {
          this.releaseHold('Renting resumes: Vast answers the new API key')
        }
        return
      }
      if (h.balance == null) {
        // Held before any balance was known: this reading is the mark a
        // top-up has to beat.
        h.balance = balance
        this.saveHold()
        return
      }
      const toppedUp = balance >= h.balance + TOP_UP_MIN
      if (toppedUp && runwayMinutes(balance, Math.max(perHour, h.perHour)) >= RUNWAY_RELEASE_MIN) {
        this.runwayLow = runway < RUNWAY_HOLD_MIN
        this.releaseHold(`Vast balance ${money(balance)}: renting resumes`)
      }
      return
    }
    if (runway < RUNWAY_HOLD_MIN) {
      if (this.runwayLow) return
      this.runwayLow = true
      const lasts =
        perHour > 0 && balance > 0 ? `, about ${Math.floor(runway)} min at ${rateWords(rate)}` : ''
      this.setHold(
        {
          reason: `Vast balance ${money(balance)}${lasts}`,
          balance,
          cause: 'runway',
          perHour
        },
        `Vast balance ${money(balance)}${lasts}: renting is paused until the balance goes up. Top up in the Vast.ai console.` +
          (rate.fleet > 0
            ? ' Nodes already rented are left running, and Vast stops them when the balance runs out.'
            : ''),
        perHour > 0 ? 'error' : 'warn'
      )
      return
    }
    if (runway >= RUNWAY_RELEASE_MIN) this.runwayLow = false
    if (runway < RUNWAY_WARN_MIN) {
      if (this.runwayWarned) return
      this.runwayWarned = true
      emit('alert', {
        level: 'warn',
        message: `Vast balance ${money(balance)} lasts about ${Math.floor(runway)} min at ${rateWords(rate)}. Renting pauses under ${RUNWAY_HOLD_MIN} min: top up in the Vast.ai console.`
      })
    } else if (runway >= RUNWAY_REARM_MIN) {
      this.runwayWarned = false
    }
  }

  /** Create an instance from one offer, with `image`, and start driving it to ready. */
  private async rentOffer(offer: Offer, diskGb: number, rental: RentalFacts): Promise<Rental> {
    const id = randomUUID()
    // This profile's install id and the node's (plan 1.3): the reconcile
    // matches the instance back to this row by it.
    const label = rentalLabel(id, getSettings().installId)
    getDb()
      .prepare(
        `INSERT INTO nodes (id, state, gpu_name, num_gpus, dph_total, accumulated_cost, blender_versions, geolocation, label, create_unknown_since)
         VALUES (?, 'requested', ?, ?, ?, 0, '[]', ?, ?, ?)`
      )
      // The offer is the only place vast.ai ever tells us where the machine is
      // — /instances/ doesn't report it — so capture it at rent time or lose it.
      // create_unknown_since: from here until Vast answers, an instance may
      // exist under `label` that no row knows the id of.
      .run(id, offer.gpuName, offer.numGpus, offer.dphTotal, offer.geolocation, label, Date.now())
    const node = new ManagedNode(id)
    node.rental = rental
    this.nodes.set(id, node)
    this.creating.add(id)
    emit('node:changed', node.snapshot)

    let instanceId: number
    try {
      instanceId = await createInstance({
        offerId: offer.id,
        image: rental.image,
        diskGb,
        onstart: ONSTART,
        env: { NVIDIA_DRIVER_CAPABILITIES: 'all' },
        label
      })
    } catch (e) {
      this.creating.delete(id)
      return this.createFailed(node, offer.machineId, e as Error)
    }
    this.creating.delete(id)
    node.update({ instance_id: instanceId, create_unknown_since: null })
    // The row is in the Fleet, destroy button and all, from before the
    // create; a destroy that landed while it was in flight found no
    // instance id and so destroyed nothing (and nothing else would ever
    // touch the instance: the orphan sweep leaves an instance its row
    // holds alone). The instance is ours to kill.
    if (node.gone) {
      await this.ensureInstanceGone(instanceId, { node })
      return { id }
    }
    void this.driveToReady(node, offer.machineId)
    return { id }
  }

  /**
   * The create threw. What that means turns on whether Vast answered it
   * (classify's outcomeUnknown):
   *
   * - No answer that says what happened (a lost reply, a 5xx, a timeout, a
   *   reply that is not JSON): the instance may exist. findLostCreate looks
   *   for it by its label, and the batch stops (plan 1.4).
   * - Vast answered, or the create was never sent (no API key, a name that
   *   did not resolve): nothing was rented, and the row stops counting as
   *   billing.
   *
   * Destroyed while the create was in flight: the user cancelled this
   * rental. That is no fault of the machine's (no blacklist), and it must not
   * be replaced by the next offer (its row is returned, as the success path
   * returns it).
   */
  private async createFailed(node: ManagedNode, machineId: number, e: Error): Promise<Rental> {
    const c = classify(e, { via: 'vast' })
    if (c.outcomeUnknown) return this.createUnanswered(node, machineId, c.reason, e)
    if (node.gone) {
      node.update({ create_unknown_since: null })
      return { id: node.id }
    }
    node.update({ state: 'failed', last_error: e.message, create_unknown_since: null })
    // The account, not the machine (plan 1.20): no credit, or a key Vast
    // rejects. Every offer would be refused the same way. Hold renting, with
    // one alert, and blacklist nothing.
    if (c.kind === 'account') {
      this.accountRefused(c)
      return { error: e, stop: true }
    }
    // Refused before anything was done (a 429), or never sent (a name that
    // did not resolve). Not this machine's doing, and the next offer would
    // meet the same. Asking again once PUT /asks is refused is the next
    // batch's call, never the client's (vastClient never repeats a create).
    if (c.kind === 'transient') return { error: e, stop: true }
    this.blacklist.add(machineId)
    return { error: e }
  }

  /**
   * Plan 1.4: the create got no answer (#223 #231). It used to be recorded
   * as "not rented", and the batch rented the next offer at once, while an
   * instance Vast had rented billed under the row's label, known to nobody
   * until the next start's orphan sweep.
   *
   * Now the row keeps create_unknown_since, so it counts against the caps
   * and in the fleet $/hr all along, and findLostCreate looks for the
   * instance by its label. The batch waits for the answer, a minute at most
   * (CREATE_LOOKUP_MS). If Vast has not answered by then the lookup goes on
   * in the background, the row still counted, and the batch ends without it.
   * Never a second PUT /asks: that would rent a second instance.
   */
  private async createUnanswered(
    node: ManagedNode,
    machineId: number,
    reason: string,
    e: Error
  ): Promise<Rental> {
    const id = node.id
    const label = node.snapshot.label ?? rentalLabel(id)
    this.lookingUp.add(id)
    // Cancelled while the create was in flight: 'destroying', not the
    // 'destroyed' destroyNode left it in, since there may be an instance to
    // destroy, and the row shows so until the lookup knows.
    if (node.gone) {
      node.setState(
        'destroying',
        `cancelled while renting, and Vast did not answer the create (${reason})`
      )
    } else {
      node.update({
        last_error: `Vast did not answer the create (${reason}); looking for its instance by label`
      })
    }
    let windowOver: () => void = () => {}
    const unanswered = new Promise<'unanswered'>((r) => (windowOver = () => r('unanswered')))
    const lookup = this.findLostCreate(node, label, machineId, reason, () => windowOver())
    const outcome = await Promise.race([lookup, unanswered])
    // Found and used, found and destroyed (cancelled), or cancelled and still
    // looked for: its row stands for the rental, as in createFailed.
    if (outcome === 'adopted' || outcome === 'destroyed' || node.gone) return { id, stop: true }
    const error =
      outcome === 'unanswered'
        ? new Error(
            `Vast.ai did not answer the create (${reason}), nor for a minute the search for its instance: "${label}" counts as billing while the app keeps looking`,
            { cause: e }
          )
        : new Error(
            `Vast.ai did not answer the create (${reason}), and no instance appeared under its label: nothing was rented`,
            { cause: e }
          )
    return { error, stop: true }
  }

  /**
   * Look for the instance of a create that got no answer, by its label, and
   * settle its row by what is found. listInstances is asked from at once,
   * backing off from 2 s to 15 s:
   *
   * - Listed: the create went through. The row takes the instance id
   *   (claim), and the rental carries on to ready as if the reply had come
   *   ('adopted'), unless it was cancelled meanwhile: then the instance is
   *   destroyed ('destroyed').
   * - Not listed by any answer asked for CREATE_LOOKUP_MS or more after the
   *   lookup began: the create rented nothing ('absent'). The row stops
   *   counting: 'failed' with the reason, or 'destroyed' if cancelled.
   * - Vast not answering says nothing either way. After the window the user
   *   is told once (`onUnanswered` too), and the lookup asks every
   *   LOOKUP_SLOW_MS until Vast answers, the row counted as billing all the
   *   while.
   *
   * Never rejects.
   */
  private async findLostCreate(
    node: ManagedNode,
    label: string,
    machineId: number,
    reason: string,
    onUnanswered: () => void
  ): Promise<'adopted' | 'destroyed' | 'absent'> {
    const start = Date.now()
    let delay = LOOKUP_FIRST_DELAY_MS
    let unanswered = false
    try {
      for (;;) {
        const asked = Date.now()
        let listed: RawInstance[] | null = null
        try {
          listed = await listInstances()
        } catch {
          // No answer: nothing learned either way.
        }
        if (listed) {
          const inst = listed.find((i) => i.label === label)
          if (inst) return await this.adoptLostCreate(node, inst.id, machineId, unanswered)
          if (asked - start >= CREATE_LOOKUP_MS) {
            this.noLostCreate(node, label, reason, unanswered)
            return 'absent'
          }
        } else if (!unanswered && Date.now() - start >= CREATE_LOOKUP_MS) {
          unanswered = true
          this.lostCreateUnanswered(node, label, reason)
          onUnanswered()
        }
        // One look lands at the window's end, so absence is known then.
        const toWindowEnd = start + CREATE_LOOKUP_MS - Date.now()
        await sleep(
          unanswered ? LOOKUP_SLOW_MS : toWindowEnd > 0 ? Math.min(delay, toWindowEnd) : delay
        )
        delay = Math.min(delay * 2, LOOKUP_MAX_DELAY_MS)
      }
    } finally {
      this.lookingUp.delete(node.id)
    }
  }

  /** The lost create's instance was found: the row takes it, and uses or destroys it. */
  private async adoptLostCreate(
    node: ManagedNode,
    instanceId: number,
    machineId: number,
    toldUser: boolean
  ): Promise<'adopted' | 'destroyed'> {
    this.claim({ id: node.id, instance_id: null }, instanceId)
    const label = node.snapshot.label
    if (node.state === 'requested') {
      node.update({ last_error: null })
      emit('alert', {
        level: 'info',
        message: `Found instance ${instanceId} (${label}): Vast rented it although its create got no answer. Using it.`
      })
      void this.driveToReady(node, machineId)
      return 'adopted'
    }
    if (toldUser) {
      emit('alert', {
        level: 'info',
        message: `Found instance ${instanceId} (${label}), whose create got no answer: destroying it`
      })
    }
    await this.ensureInstanceGone(instanceId, { node })
    return 'destroyed'
  }

  /** Vast answered, a minute on, without the lost create's label: nothing was rented. */
  private noLostCreate(node: ManagedNode, label: string, reason: string, toldUser: boolean): void {
    if (node.state === 'requested') {
      node.update({
        state: 'failed',
        create_unknown_since: null,
        last_error: `Vast did not answer the create (${reason}), and no instance appeared under its label: nothing was rented`
      })
    } else {
      node.update({ state: 'destroyed', create_unknown_since: null, last_error: null })
    }
    if (toldUser) {
      emit('alert', {
        level: 'info',
        message: `No instance "${label}" on Vast: the create that got no answer rented nothing`
      })
    }
  }

  /**
   * A minute gone and Vast has not answered the lookup: say so, once. A
   * rental the user cancelled is a billing risk nothing may be managing if
   * the app is closed now; one still wanted is counted, and the lookup keeps
   * at it.
   */
  private lostCreateUnanswered(node: ManagedNode, label: string, reason: string): void {
    const wanted = node.state === 'requested'
    emit('alert', {
      level: wanted ? 'warn' : 'error',
      message: wanted
        ? `Vast.ai has not said whether the rental "${label}" went through (${reason}). It counts as billing until the app finds its instance or finds there is none, and the app keeps looking — check the Vast.ai console if this lasts.`
        : `A rental cancelled mid-create may be billing: Vast.ai has not said whether its create went through (${reason}). The app keeps looking for "${label}" to destroy it — check the Vast.ai console!`
    })
  }

  /**
   * Make sure a Vast instance is gone, and record that only once it is: the
   * one destroy path (plan 1.2), for destroyNode, clearFailed, the failure
   * paths of driveToReady and recoverUnreachable, a rental destroyed while
   * its create was in flight, the retry timer and the orphan sweep. Each of
   * those used to send one DELETE of its own and trust the answer, so one
   * Vast blip left an instance billing that the app had written off, and a
   * 404 on an instance already gone raised a false "check the console" (#34
   * #64 #140 #194).
   *
   * - With `node`, and SSH having answered on it, OctaneServer is stopped
   *   first, bounded, so it can release its floating license. The node's
   *   connection is then closed: nothing may use it on a dying box.
   * - DELETE is retried with backoff on anything classify() calls transient
   *   (a network error, a 5xx, a 429, a timeout) for `budgetMs`. A 404 means
   *   gone. A DELETE Vast accepted is confirmed with showInstance, since a
   *   200 can leave the instance running.
   * - Confirmed: every row holding the instance is stamped destroyed_at and
   *   set 'destroyed'. That stamp is what stops a node counting as billing
   *   (shared/nodeState.ts holdsInstance), and nothing else stamps it.
   * - Not confirmed: every row holding it is 'failed', still counted against
   *   the caps and metered, and retryDestroys tries again every minute until
   *   it is confirmed. The user is told; the retries (`quiet`) do not tell
   *   them again, and they hear when it is confirmed.
   *
   * Resolves true once the instance is confirmed gone; never rejects. A call
   * for an instance already being destroyed waits on that one. `reason`, why
   * the instance had to go, stays on its rows once it is confirmed gone.
   */
  ensureInstanceGone(
    instanceId: number,
    opts: {
      node?: ManagedNode
      budgetMs?: number
      quiet?: boolean
      reason?: string
      /** The most the Octane stop may take: see destroyUntilGone. 0 skips it. */
      octaneStopMs?: number
    } = {}
  ): Promise<boolean> {
    const running = this.goneChecks.get(instanceId)
    if (running) return running
    const check = this.destroyUntilGone(instanceId, opts).finally(() =>
      this.goneChecks.delete(instanceId)
    )
    this.goneChecks.set(instanceId, check)
    return check
  }

  private async destroyUntilGone(
    instanceId: number,
    opts: {
      node?: ManagedNode
      budgetMs?: number
      quiet?: boolean
      reason?: string
      octaneStopMs?: number
    }
  ): Promise<boolean> {
    const { node } = opts
    if (node) {
      // Its VNC login first, connection or none (plan 1.18 review).
      forgetOctaneNode(node.id)
      // Best effort: nothing about the license may stand between the
      // instance and its DELETE. A caller with a budget of its own (a quit's
      // destroy) gets the stop within OCTANE_STOP_BUDGET_MS, which is what it
      // allows for: the 35 s a server known to have run gets otherwise came
      // out of the DELETE's window, so a licensed node gone quiet, and two
      // 502s, left the quit reporting it billing, and 'Quit anyway' left it
      // live (n5 review). 0 skips the stop: the process may be ended any
      // moment, and the instance matters more than the seat.
      const stopMs =
        opts.octaneStopMs ?? (opts.budgetMs != null ? OCTANE_STOP_BUDGET_MS : undefined)
      if (stopMs !== 0) await this.stopOctane(node, stopMs).catch(() => {})
      node.closeSsh()
    }
    let last: unknown = null
    try {
      await retryWithBackoff(
        async () => {
          try {
            await destroyInstance(instanceId)
          } catch (e) {
            // Gone already: 404, or 410 (vastClient's notFound). A 410 read
            // as a refusal was retried every minute with alerts, for an
            // instance that no longer existed (n2 review).
            if (vastErrorKind(e) === 'notFound') return
            last = e
            throw e
          }
          let still: RawInstance | null
          try {
            still = await showInstance(instanceId)
          } catch (e) {
            last = e
            throw e
          }
          if (still) {
            last = new InstanceStillListed(instanceId, still.actual_status)
            throw last
          }
        },
        {
          budgetMs: opts.budgetMs ?? DESTROY_BUDGET_MS,
          initialDelayMs: DESTROY_FIRST_DELAY_MS,
          maxDelayMs: DESTROY_MAX_DELAY_MS,
          isRetryable: (e) =>
            e instanceof InstanceStillListed || classify(e, { via: 'vast' }).kind === 'transient'
        }
      )
    } catch (e) {
      this.destroyUnconfirmed(instanceId, last ?? e, opts.quiet === true)
      return false
    }
    this.instanceGone(instanceId, opts.reason ?? null)
    return true
  }

  /**
   * Stop OctaneServer before its instance goes, so its floating license is
   * released rather than held until OTOY times it out. Only where SSH has
   * answered (nothing can run on a node where it never has) and over the
   * node's own connection, which exec reconnects if it dropped. The script
   * runs only when the node has an OctaneServer pidfile, and a wedged or dead
   * node holds the destroy up for OCTANE_STOP_BUDGET_MS at most, or
   * OCTANE_STOP_RUNNING_BUDGET_MS where the server is known to have run.
   * Neither is billing's concern: the instance bills the same either way.
   */
  private async stopOctane(node: ManagedNode, capMs?: number): Promise<void> {
    const ssh = node.ssh
    if (!ssh || !node.sshEverAnswered) return
    const timeoutMs = Math.min(
      node.octaneState === 'none' ? OCTANE_STOP_BUDGET_MS : OCTANE_STOP_RUNNING_BUDGET_MS,
      capMs ?? Number.POSITIVE_INFINITY
    )
    await stopOctaneServer(ssh, { timeoutMs, onlyIfStarted: true })
  }

  /** The managed nodes whose row holds `instanceId` unconfirmed. */
  private holders(instanceId: number): ManagedNode[] {
    const ids = getDb()
      .prepare('SELECT id FROM nodes WHERE instance_id = ? AND destroyed_at IS NULL')
      .all(instanceId) as Array<{ id: string }>
    return ids.map((r) => {
      // Every row that holds an instance is managed (init, claim); a row
      // that somehow is not joins the map, so the retry timer finds it.
      let n = this.nodes.get(r.id)
      if (!n) {
        n = new ManagedNode(r.id)
        this.nodes.set(r.id, n)
      }
      return n
    })
  }

  /**
   * Vast confirmed the instance gone: a 404, or showInstance no longer finds
   * it. Stamp destroyed_at on every row holding it; only this settles them.
   */
  private instanceGone(instanceId: number, lastError: string | null = null): void {
    const now = Date.now()
    for (const n of this.holders(instanceId)) {
      n.update({ state: 'destroyed', destroyed_at: now, last_error: lastError })
    }
    this.goneAt.set(instanceId, now)
    this.destroyErrors.delete(instanceId)
    if (this.unconfirmedAlerted.delete(instanceId)) {
      emit('alert', {
        level: 'info',
        message: `Instance ${instanceId} is destroyed now: Vast has confirmed it gone`
      })
    }
  }

  /**
   * The destroy went unconfirmed: Vast refused it, kept failing, or still
   * lists the instance. Its rows go (or stay) 'failed' holding the instance,
   * which counts it and meters it, and retryDestroys goes on trying.
   */
  private destroyUnconfirmed(instanceId: number, e: unknown, quiet: boolean): void {
    const reason =
      e instanceof InstanceStillListed ? e.message : classify(e, { via: 'vast' }).reason
    this.destroyErrors.set(instanceId, reason)
    const holders = this.holders(instanceId)
    for (const n of holders) n.update({ state: 'failed', last_error: `destroy failed: ${reason}` })
    if (holders.length === 0) {
      // Only the reconcile destroys an instance no row holds: an orphan no
      // row could take, or an unclaimed one the user said to destroy.
      emit('alert', {
        level: 'error',
        message: `orphan destroy failed for ${instanceId}: ${reason} — check the Vast.ai console!`
      })
      return
    }
    if (quiet && this.unconfirmedAlerted.has(instanceId)) return
    this.unconfirmedAlerted.add(instanceId)
    emit('alert', {
      level: 'error',
      message: `Destroy failed for instance ${instanceId} (${reason}). It may still be billing; the app retries every minute — check the Vast.ai console!`
    })
  }

  /**
   * Try again to destroy every node whose destroy Vast has not confirmed:
   * one the app was destroying, one that failed holding its instance, and
   * one 'destroyed' by a build that took the DELETE's word for it. From
   * init with a full budget, then from the timer with one attempt per node
   * per round. One node at a time: Vast rate-limits DELETE, and a round
   * still running when the timer fires again is left to finish.
   */
  private async retryDestroys(budgetMs: number): Promise<void> {
    if (this.retryingDestroys) return
    this.retryingDestroys = true
    try {
      for (const node of [...this.nodes.values()]) {
        const f = node.facts
        if (f.instanceId == null || !holdsInstance(f) || !DESTROY_STATES.has(f.state)) continue
        await this.ensureInstanceGone(f.instanceId, { node, budgetMs, quiet: true })
      }
    } finally {
      this.retryingDestroys = false
    }
  }

  /** Poll vast until running + SSH reachable, then hand to provisioning. */
  private async driveToReady(node: ManagedNode, machineId: number | null): Promise<void> {
    const instanceId = node.snapshot.instanceId
    if (!instanceId) return
    // A backstop no caller reaches today. Callers hand over a node they have
    // just put in 'requested', never one destroyNode is destroying (which
    // reads the id from the row and destroys the instance itself). So a node
    // already gone here was destroyed before its instance id was recorded,
    // the race rentOffer checks for too, and nothing has destroyed the
    // instance. A caller that broke that rule would only join destroyNode's
    // ensureInstanceGone, or find the instance gone (a 404, which is done).
    if (node.gone) {
      await this.ensureInstanceGone(instanceId, { node })
      return
    }
    // The state this run holds the node in: 'requested' until SSH answers,
    // then 'provisioning'. A destroy from here on moves the node off it and
    // is destroyNode's to finish, so the returns below leave the node and
    // its instance alone (see movedOn).
    let held: NodeState = node.state
    const deadline = Date.now() + 8 * 60_000
    // The status poll's failure while Vast is not answering it, if the boot
    // ends on one: not the machine's doing, so no blacklist below.
    let vastSilent: unknown = null
    try {
      let inst: RawInstance | null = null
      for (;;) {
        if (node.movedOn(held)) return
        try {
          inst = await showInstance(instanceId)
          vastSilent = null
        } catch (e) {
          // A Vast blip (a 5xx, a 429, a timeout, this computer's network)
          // says nothing about the instance. It used to fail the node here,
          // blacklist a good machine and destroy an instance whose image pull
          // was already paid for (#39 #236). Poll on until the deadline; any
          // other answer (a key Vast refuses) ends the boot as before.
          if (!vastDown(e)) throw e
          vastSilent = e
          emit('render:logLine', {
            nodeId: node.id,
            chunkId: null,
            line: `Vast.ai did not answer the status poll (${classify(e, { via: 'vast' }).reason}) — polling on`,
            ts: Date.now()
          })
        }
        if (!vastSilent && inst?.actual_status === 'running') {
          const eps = sshEndpoints(inst)
          if (eps.length > 0) break
        }
        if (Date.now() > deadline) {
          if (vastSilent) throw vastSilent
          throw new Error(
            `instance not running after 8 min (status: ${inst?.actual_status ?? 'unknown'})`
          )
        }
        await sleep(10_000)
      }

      const startedAt = inst!.start_date ? Math.round(inst!.start_date * 1000) : Date.now()
      // "running" means the container started, not that sshd is listening: the
      // first attempt is routinely refused. Retry every endpoint (direct
      // preferred, proxy fallback) with backoff for a few minutes, re-reading
      // the instance each round in case its endpoints moved.
      let endpoints = sshEndpoints(inst!)
      await retryWithBackoff(
        async (attempt) => {
          if (attempt > 1) {
            const fresh = await showInstance(instanceId).catch(() => null)
            const eps = fresh ? sshEndpoints(fresh) : []
            if (eps.length > 0) endpoints = eps
          }
          let lastErr: Error | null = null
          for (const ep of endpoints) {
            node.update({ ssh_host: ep.host, ssh_port: ep.port, started_at: startedAt })
            try {
              node.closeSsh()
              const ssh = await node.connectSsh()
              const r = await ssh.exec(
                'echo ok && cat /proc/driver/nvidia/version 2>/dev/null | head -1',
                { timeoutMs: 30_000 }
              )
              if (r.stdout.includes('ok')) return
              lastErr = new Error(`unexpected echo result: ${r.stderr || r.stdout}`)
            } catch (e) {
              lastErr = e as Error
            }
          }
          throw lastErr ?? new Error('no SSH endpoints')
        },
        {
          budgetMs: FIRST_CONNECT_BUDGET_MS,
          initialDelayMs: 5_000,
          maxDelayMs: 30_000,
          shouldAbort: () => node.movedOn(held),
          onRetry: (e, n, delayMs) =>
            emit('render:logLine', {
              nodeId: node.id,
              chunkId: null,
              line: `ssh attempt ${n} failed (${e.message}) — retrying in ${Math.round(delayMs / 1000)}s`,
              ts: Date.now()
            })
        }
      )

      // shouldAbort is only asked between attempts. A destroy that lands
      // during one closes the node's connection, but the attempt then opens a
      // fresh one on its next endpoint, and that can succeed while the
      // instance is still being torn down (or is still up: its DELETE
      // failed). Going on would bring the node back as 'provisioning' over
      // the destroy's state; drop the connection.
      if (node.movedOn(held)) {
        node.closeSsh()
        return
      }
      node.setState('provisioning')
      held = 'provisioning'
      if (this.onReady && node.ssh) {
        // Past the deadline the node fails like any other provision, below:
        // blacklisted, alerted and destroyed, which closes the connection
        // the stalled step is waiting on.
        await withDeadline(
          this.onReady({ id: node.id, ssh: node.ssh }),
          PROVISION_DEADLINE_MS,
          'provisioning'
        )
      }
      // Provisioning takes minutes, plenty of time to be destroyed in; a
      // node that was must not end 'ready', where the scheduler would use it.
      if (node.movedOn(held)) return
      this.provisioned.add(node.id)
      node.setState('ready')
      emit('alert', { level: 'info', message: `Node ${node.snapshot.gpuName} ready` })
      this.bootEnded(node.id, null)
    } catch (e) {
      // Destroyed meanwhile: the retry gave up because of it (RetryAbortedError),
      // or the connection destroyNode closed failed a command. Neither is the
      // node failing. No 'failed' over the destroy's state, no blacklisted
      // machine, no error alert, and no second destroy racing destroyNode's.
      // A destroy Vast never confirmed has left the node 'failed' with its
      // instance id, which the retry timer and clearFailed retry.
      if (node.movedOn(held)) return
      node.setState('failed', (e as Error).message)
      const c = classify(e)
      // Vast refusing the account (no credit, a key it rejects) says nothing
      // against the machine, and holds renting (plan 1.20).
      if (c.kind === 'account') this.accountRefused(c)
      // Nor does Vast being silent for the whole boot.
      else if (machineId != null && e !== vastSilent) this.blacklist.add(machineId)
      emit('alert', { level: 'error', message: `Node failed: ${(e as Error).message}` })
      if (c.kind !== 'account' && e !== vastSilent) this.bootEnded(node.id, c.reason)
      // Clean up the rented instance — never leave a failed node billing.
      await this.ensureInstanceGone(instanceId, { node })
    }
  }

  /**
   * resumeNode's question to Vast about a node's instance, asked until Vast
   * answers it: the instance, or null when Vast no longer knows it (gone).
   * Undefined if the node was destroyed meanwhile.
   *
   * No answer (Vast or this computer's network down, a 5xx, a key Vast
   * refuses) says nothing about the instance: the control plane being down
   * is not the instance being gone. It used to send the node to
   * recoverUnreachable, which marked it 'ready' without re-provisioning when
   * SSH worked, and 'failed', uncounted and still billing, when it did not
   * (#33, audit A8). Now the node waits 'unreachable', counted as billing and
   * given no work, and Vast is asked again, from 5 s backing off to a
   * minute, for as long as it takes.
   */
  private async askUntilAnswered(
    node: ManagedNode,
    instanceId: number,
    held: NodeState
  ): Promise<RawInstance | null | undefined> {
    let delay = RESUME_FIRST_DELAY_MS
    let waiting = false
    for (;;) {
      try {
        const inst = await showInstance(instanceId)
        return node.movedOn(held) ? undefined : inst
      } catch (e) {
        if (node.movedOn(held)) return undefined
        if (!waiting) {
          waiting = true
          const reason = classify(e, { via: 'vast' }).reason
          node.setState(
            'unreachable',
            `Vast.ai did not answer about instance ${instanceId} at start-up (${reason}); asking again`
          )
          held = 'unreachable'
        }
      }
      await sleep(delay)
      delay = Math.min(delay * 2, RESUME_MAX_DELAY_MS)
      if (node.movedOn(held)) return undefined
    }
  }

  /** Re-attach to an instance after app restart. */
  private async resumeNode(node: ManagedNode): Promise<void> {
    const instanceId = node.snapshot.instanceId
    if (!instanceId) {
      node.setState('failed', 'no instance id at resume')
      return
    }
    // The Fleet shows the row, destroy button and all, from start-up, and a
    // resume takes minutes when it re-provisions. So, as in driveToReady,
    // every await below is followed by a check that the node is still in the
    // state this step holds it in: first the one the last exit left it in.
    let held: NodeState = node.state
    try {
      const inst = await this.askUntilAnswered(node, instanceId, held)
      if (inst === undefined) return
      held = node.state
      if (!inst) {
        // Vast no longer knows the instance, or answered without it: its
        // DELETE's 404 confirms it gone, as in lost(). showInstance's null is
        // no proof on its own, and the row, stamped destroyed on it, stopped
        // counting while the instance could bill on.
        const reason = 'instance missing at resume'
        node.setState('destroying', reason)
        await this.ensureInstanceGone(instanceId, { node, reason })
        return
      }
      if (instanceStopped(inst)) {
        // Vast stopped it while the app was away: at a $0 balance Vast stops
        // every instance on the account (field incident 1d59516c, the app
        // relaunched after). It will not come back by itself, and it is no
        // fault of the machine's, so it is destroyed as lost() destroys one,
        // with no blacklist. It used to be polled for 8 min as a boot, then
        // failed and its machine blacklisted (n4 review).
        const reason = `Vast reports its instance ${inst.actual_status ?? inst.intended_status ?? 'stopped'} at resume`
        forgetNodeProvider?.(node.id)
        emit('alert', {
          level: 'warn',
          message: `Node ${nodeName(node.snapshot)}: ${reason}. Destroying it.`
        })
        node.setState('destroying', reason)
        await this.ensureInstanceGone(instanceId, { node, reason })
        return
      }
      if (inst.actual_status !== 'running') {
        // Still booting (or wedged) — never leave it billing: drive it like a
        // fresh request (poll → ready) with the same timeout + destroy path.
        node.setState('requested', `resumed while ${inst.actual_status ?? 'unknown'}`)
        void this.driveToReady(node, inst.machine_id ?? null)
        return
      }
      // 'provisioning' BEFORE the SSH handle exists — never 'ready' early.
      // The node row still carries its pre-restart state ('ready' or
      // 'rendering'), and the scheduler dispatches to any such node the
      // moment `.ssh` is set; a dispatch racing provisionBase corrupts
      // state: the base setup clears the job inbox (deleting freshly
      // written specs → "No such file" renames or silently stranded chunks)
      // and restarts the agent underneath the dispatch.
      node.setState('provisioning')
      held = 'provisioning'
      const ssh = await node.connectSsh()
      if (node.movedOn(held)) {
        // destroyNode closed this connection while it was connecting, and a
        // connect in flight still lands on a closed SshConnection: end the
        // session it opened to the dying box.
        ssh.close()
        return
      }
      const r = await ssh.exec('echo ok', { timeoutMs: 30_000 })
      if (node.movedOn(held)) return
      if (!r.stdout.includes('ok')) throw new Error('echo failed')
      if (this.onReady && node.ssh) {
        await withDeadline(
          this.onReady({ id: node.id, ssh: node.ssh }),
          PROVISION_DEADLINE_MS,
          'provisioning'
        )
      }
      // Destroyed while provisioning: not 'ready', where the scheduler would
      // dispatch to it and scale-down would destroy it a second time.
      if (node.movedOn(held)) return
      this.provisioned.add(node.id)
      node.setState('ready')
    } catch (e) {
      // The destroy closed the connection under the connect, the echo or
      // provisioning. That is not the node becoming unreachable: no
      // 'unreachable' over the destroy's state, and no recovery that would
      // end 'failed' and destroy the instance again.
      if (node.movedOn(held)) return
      // SSH answered, and provisioning stalled on it: waiting for the node to
      // answer again would not help, and it bills meanwhile (plan 1.8).
      if (e instanceof ProvisionTimeout) {
        await this.giveUp(node, e.message, { connected: true })
        return
      }
      node.setState('unreachable', (e as Error).message)
      void this.recoverUnreachable(node)
    }
  }

  /**
   * Give up on a node: fail it, give its chunks back to the queue, say so,
   * and destroy its instance. For a node whose connection is dead
   * (`connected: false`) the connection is closed first, so the destroy does
   * not wait out an Octane stop over it.
   */
  private async giveUp(
    node: ManagedNode,
    reason: string,
    opts: { connected: boolean }
  ): Promise<void> {
    node.setState('failed', reason)
    // A node lost mid-render never reaches destroyNode, so the scheduler
    // would otherwise keep polling it for chunks it can no longer finish.
    forgetNodeProvider?.(node.id)
    const s = node.snapshot
    emit('alert', { level: 'warn', message: `Node ${nodeName(s)}: ${reason}. Destroying it.` })
    if (!opts.connected) node.closeSsh()
    if (s.instanceId != null) await this.ensureInstanceGone(s.instanceId, { node, reason })
  }

  /**
   * Bring an 'unreachable' node back, or let it go (plan 1.7). From
   * resumeNode, for a node SSH did not reach at start-up, from the
   * supervisor (nodeSilent), and from restoreAgent when its check lost the
   * link, the last two with `askVast` since Vast has not been asked. One at
   * a time per node.
   *
   * - Vast has stopped the instance or no longer knows it: let go (lost).
   * - Otherwise the node's own connection reconnects with backoff, for up to
   *   10 min, to the endpoint Vast now lists: a restarted container can come
   *   back on other ports. Once SSH answers, the agent is checked and, if it
   *   is dead, restarted, before the node takes work again (reviveAgent). It
   *   used to go 'ready' on a bare reconnect.
   * - A round that fails, SSH not answering or the link going again under
   *   the agent check (linkFailed), or another restart-agent holding the
   *   node: Vast is asked again. Stopped or gone: let go. Running: another
   *   round, until the budget is spent, and then given up on and destroyed.
   *   No answer: this computer's network may be what is down, not the node,
   *   so the node stays 'unreachable', counted as billing and sent nothing,
   *   and both are tried again. A laptop offline for ten minutes used to come
   *   back to a fleet destroyed, and one whose link dropped once more under
   *   the agent check to a node destroyed.
   * - The agent check's own verdict (the agent cannot be restarted, or
   *   bringing it back ran past PROVISION_DEADLINE_MS): given up on.
   *
   * The chunks the node had are not given back until one of those settles
   * it (see nodeSilent).
   */
  private async recoverUnreachable(
    node: ManagedNode,
    opts: { askVast?: boolean; why?: string } = {}
  ): Promise<void> {
    if (this.recovering.has(node.id)) return
    this.recovering.add(node.id)
    try {
      await this.recover(node, opts)
    } finally {
      this.recovering.delete(node.id)
    }
  }

  private async recover(
    node: ManagedNode,
    opts: { askVast?: boolean; why?: string }
  ): Promise<void> {
    // 'unreachable', set by resumeNode, nodeSilent or restoreAgent just now.
    // See movedOn.
    const held = node.state
    const instanceId = node.facts.instanceId
    // What the node had when it went silent: what the app gives back
    // meanwhile is stopped there if it comes back (reviveAgent).
    const before = (activeWorkProvider?.(node.id) ?? []).map((w) => w.chunkId)
    let why = opts.why ?? node.snapshot.lastError ?? 'no answer over SSH'
    if (opts.askVast && instanceId != null) {
      const fate = await this.askVast(instanceId)
      // Shut down meanwhile: the node's connection is closed, and going on
      // would open another to a node the user chose to leave running.
      if (node.movedOn(held) || this.shutDown) return
      if (fate.kind === 'gone' || fate.kind === 'stopped') {
        await this.lost(node, instanceId, fate, why)
        return
      }
      if (fate.kind === 'up') node.retargetTo(sshEndpoints(fate.inst))
    }
    // SSH gets RECONNECT_BUDGET_MS to answer again and the agent to be
    // brought back, counted afresh when Vast lists the instance on other
    // ports or does not answer either.
    let deadline = Date.now() + RECONNECT_BUDGET_MS
    let graces = 0
    for (;;) {
      // SSH answered this round: what fails after that failed under the
      // agent check.
      let answered = false
      try {
        const ssh = node.ssh ?? (await node.connectSsh())
        // Closed by destroyNode mid-connect, as in resumeNode: end the session
        // the connect opened anyway.
        if (node.movedOn(held)) {
          ssh.close()
          return
        }
        const left = Math.max(0, deadline - Date.now())
        await ssh.reconnectWithBackoff(Math.min(RECONNECT_SLICE_MS, left))
        if (node.movedOn(held)) {
          ssh.close()
          return
        }
        // Connected is not answering: ssh2 hands back a connection whose far
        // end went silent as live until its keepalive gives up on it (about
        // 30 s), and every command on it waits for nothing meanwhile.
        const r = await ssh.exec('echo ok', {
          timeoutMs: ANSWER_TIMEOUT_MS,
          label: 'reconnect check'
        })
        if (node.movedOn(held)) return
        if (!r.stdout.includes('ok'))
          throw new Error(`no answer after reconnecting (exit ${exitStatus(r.code)})`)
        answered = true
        lastContactByNode.set(node.id, Date.now())
        node.takeDrops()
        if (graces < ANSWERED_GRACE_MAX && deadline < Date.now() + RECONNECT_SLICE_MS) {
          graces++
          deadline = Date.now() + RECONNECT_SLICE_MS
        }
        const revival = await withDeadline(
          this.reviveAgent(node, ssh, before),
          PROVISION_DEADLINE_MS,
          'bringing the agent back'
        )
        if (node.movedOn(held)) return
        this.backInService(node, revival, why)
        return
      } catch (e) {
        // Destroyed meanwhile: destroyNode closed the connection the
        // reconnect was retrying on, which is what ended it. The destroy is
        // not this node failing, and destroying the instance again here
        // would only join destroyNode's.
        if (node.movedOn(held) || this.shutDown) return
        why = failureReason(e)
        const busy = e instanceof AgentBusyError
        const unrevived = `SSH answers again, but the agent could not be brought back: ${why}`
        // The agent's own answer, not the link's: it cannot be brought back.
        if (answered && !busy && !linkFailed(e)) {
          await this.giveUp(node, unrevived, { connected: true })
          return
        }
        // Another machine answers at the endpoint (waiting will not change
        // that), or Vast running the instance while the rounds keep failing:
        // given up on. Nothing else destroys a node that fails this way,
        // since scale-down takes only idle nodes. A connection that just
        // died is closed first: an Octane stop over it would only wait out
        // its budget before the destroy.
        const abandon = (): Promise<void> =>
          this.giveUp(node, answered ? unrevived : `SSH did not come back: ${why}`, {
            connected: busy
          })
        if (e instanceof HostKeyMismatchError || instanceId == null) return abandon()
        const fate = await this.askVast(instanceId)
        if (node.movedOn(held) || this.shutDown) return
        if (fate.kind === 'gone' || fate.kind === 'stopped') {
          return this.lost(node, instanceId, fate, why)
        }
        // Vast lists it on other ports now: the budget starts again, there.
        if (fate.kind === 'up' && node.retargetTo(sshEndpoints(fate.inst))) {
          deadline = Date.now() + RECONNECT_BUDGET_MS
          continue
        }
        if (Date.now() < deadline) {
          await sleep(RECONNECT_PAUSE_MS)
          if (node.movedOn(held) || this.shutDown) return
          continue
        }
        if (fate.kind === 'silent') {
          node.update({
            last_error: `no answer over SSH (${why}), nor from Vast.ai (${fate.reason}): trying both again`
          })
          await sleep(RESUME_MAX_DELAY_MS)
          if (node.movedOn(held) || this.shutDown) return
          deadline = Date.now() + RECONNECT_BUDGET_MS
          continue
        }
        return abandon()
      }
    }
  }

  /**
   * Destroy a node's instance (ensureInstanceGone). Resolves once Vast has
   * confirmed it gone, or once `budgetMs` (default DESTROY_BUDGET_MS) of
   * retrying transient failures has passed without that: the node is then
   * 'failed', still counted as billing, and the retry timer carries on. A
   * caller with a deadline of its own (quit's destroy-all) passes it; 0 is
   * one attempt. A refused DELETE (a 4xx) is never retried within the call.
   */
  /**
   * Destroy a node's instance (ensureInstanceGone). `budgetMs` bounds the
   * retries of its DELETE, and with it the Octane stop to
   * OCTANE_STOP_BUDGET_MS; `octaneStopMs` sets that bound itself, 0 to skip
   * the stop (a quit the OS may end at any moment).
   */
  async destroyNode(
    id: string,
    opts: { budgetMs?: number; octaneStopMs?: number } = {}
  ): Promise<void> {
    const node = this.nodes.get(id)
    if (!node) return
    const facts = node.facts
    // Already confirmed gone (the button pressed twice, #113): nothing to do,
    // and a second DELETE would only be a 404.
    if (facts.state === 'destroyed' && !holdsInstance(facts)) return
    const instanceId = facts.instanceId
    // A create that got no answer, whose instance is being looked for by its
    // label (plan 1.4): there is no id to destroy yet. 'destroying' until the
    // lookup knows: it destroys the instance if it finds one, and settles the
    // row 'destroyed' if there is none.
    if (instanceId == null && this.lookingUp.has(id)) {
      forgetNodeProvider?.(id)
      node.setState('destroying')
      return
    }
    // A create the last run never heard back from, not yet looked for (the
    // start-up sweep settles it): there is no id to destroy. The row stays
    // as it is, visible and counted as billing, until the instance is found
    // by its label. 'destroyed' would hide from the Fleet a row that still
    // counts against the caps.
    if (instanceId == null && createOutcomeUnknown(facts) && !this.creating.has(id)) {
      emit('alert', {
        level: 'warn',
        message: `Node ${id.slice(0, 8)} has no instance id to destroy: Vast never answered its create. Check the Vast.ai console for "${node.snapshot.label ?? rentalLabel(id)}".`
      })
      return
    }
    forgetNodeProvider?.(id)
    node.setState('destroying')
    if (instanceId == null) {
      // Not rented yet: its create is still in flight, and rentOffer destroys
      // whatever that returns once it sees the node gone.
      node.closeSsh()
      node.setState('destroyed')
      return
    }
    // Octane drain ordering (a clean OctaneServer exit releases the floating
    // license before the instance goes) is ensureInstanceGone's.
    await this.ensureInstanceGone(instanceId, {
      node,
      budgetMs: opts.budgetMs,
      octaneStopMs: opts.octaneStopMs
    })
  }

  /**
   * Retire every 'failed' node. A failed node can still own a billing
   * instance (a destroy Vast never confirmed), so re-attempt the destroy
   * rather than just hiding the row; one that still won't die stays 'failed'
   * and alerts. One whose create has an unknown outcome has no id to destroy
   * and stays too (see destroyNode). Returns how many were retired.
   */
  async clearFailed(): Promise<number> {
    const failed = [...this.nodes.values()].filter((n) => n.state === 'failed')
    const results = await Promise.allSettled(
      failed.map(async (node) => {
        forgetNodeProvider?.(node.id)
        const f = node.facts
        if (f.instanceId != null && holdsInstance(f)) {
          return this.ensureInstanceGone(f.instanceId, { node })
        }
        if (createOutcomeUnknown(f)) return false
        node.closeSsh()
        node.setState('destroyed')
        return true
      })
    )
    return results.filter((r) => r.status === 'fulfilled' && r.value).length
  }

  /**
   * The cost timer's tick: accumulate $ cost from dph × elapsed, read the
   * balance (and guard the credit), push the fleet totals, run the
   * reconcile when it is due (plan 1.3), and age the GPU usage history.
   */
  private async accrueCosts(): Promise<void> {
    const db = getDb()
    const ts = Date.now() // one timestamp for the tick, so buckets line up
    // The GPU usage history's memory and its 7-day table (Feature G).
    pruneMetrics(ts)
    const usage: UsageRow[] = []
    for (const node of this.nodes.values()) {
      const s = node.snapshot
      // Metered while it may be billing, whatever its state: a 'failed' node
      // whose destroy Vast never confirmed is billed all the same, and
      // skipping it hid the leak from History and the session total (#64).
      // From when Vast started it: a node still booting is in the fleet
      // $/hr below but not yet charged here.
      if (!holdsInstance(s) || s.dphTotal == null || !s.startedAt) continue
      const delta = s.dphTotal / 60 // one minute tick
      node.update({ accumulated_cost: s.accumulatedCost + delta })
      db.prepare(
        'INSERT INTO cost_log (node_id, ts, dph_total, delta_cost) VALUES (?, ?, ?, ?)'
      ).run(s.id, ts, s.dphTotal, delta)
      usage.push(...splitUsage(s.id, ts, delta, flushEnergy(s.id)))
    }
    writeUsage(usage)
    await this.refreshCost(ts)
    if (Date.now() >= this.nextReconcileAt) void this.reconcile()
  }

  /**
   * Meter time this process did not see: the computer asleep (plan 1.1,
   * app/lifecycle.ts on powerMonitor 'resume'). The cost timer charges one
   * minute a tick, and a sleeping computer runs no ticks, so a night asleep
   * with the fleet billing showed up nowhere: not in the session total, not
   * in History, not in a job's cost (#66). Each node that may be billing is
   * charged its $/hr for `ms`, less the minute the first tick after waking
   * charges anyway, and the totals and credit guard are refreshed at once.
   * The nodes went on rendering meanwhile (their agents do not need this
   * computer), so the time is split over their work as a tick's is.
   */
  accrueElapsed(ms: number): void {
    const extra = ms - 60_000
    if (!Number.isFinite(extra) || extra <= 0) return
    const db = getDb()
    const ts = Date.now()
    const usage: UsageRow[] = []
    for (const node of this.nodes.values()) {
      const s = node.snapshot
      if (!holdsInstance(s) || s.dphTotal == null || !s.startedAt) continue
      const delta = (s.dphTotal * extra) / 3_600_000
      node.update({ accumulated_cost: s.accumulatedCost + delta })
      db.prepare(
        'INSERT INTO cost_log (node_id, ts, dph_total, delta_cost) VALUES (?, ?, ?, ?)'
      ).run(s.id, ts, s.dphTotal, delta)
      usage.push(...splitUsage(s.id, ts, delta, 0))
    }
    writeUsage(usage)
    void this.refreshCost(ts)
  }

  /**
   * Read the Vast balance, run the credit guard on it (plan 1.20) and push
   * fleet:cost. From every cost tick, and from init, so the toolbar has its
   * figures from the start rather than a minute in. Never rejects.
   */
  private async refreshCost(ts = Date.now()): Promise<void> {
    let fresh: number | null = null
    try {
      const u = await currentUser()
      const credit = Number(u.credit ?? u.balance)
      if ((u.credit ?? u.balance) != null && Number.isFinite(credit)) {
        fresh = credit
        this.balance = credit
        recordBalance(ts, credit)
      }
    } catch {
      // keep last known balance (no key / offline)
    }
    // Only a balance read just now is judged: an old one says nothing about
    // the runway left.
    if (fresh != null) this.guardCredit(fresh, this.accountPerHour())
    emit('fleet:cost', this.fleetCost())
  }

  /**
   * The fleet totals fleet:cost pushes, as they stand, with the last balance
   * read. For a window that opens between pushes.
   */
  fleetCost(): FleetCost {
    const sessionTotal = (
      getDb().prepare('SELECT COALESCE(SUM(delta_cost), 0) AS t FROM cost_log').get() as {
        t: number
      }
    ).t
    return {
      // The fleet rate the caps use: every node that may be billing.
      perHour: this.billingPerHour(),
      sessionTotal,
      sessionWh: sessionEnergyWh(),
      sessionCo2g: sessionCo2Grams(),
      balance: this.balance
    }
  }
}

export const nodeManager = new NodeManager()
