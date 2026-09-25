/**
 * Quit, sleep and session end while rented machines bill (plan 1.1; audit A1:
 * #4 #18 #32 #45 #63 #138 #167 #195 #208).
 *
 * Vast bills an instance until it is destroyed, whatever this app is doing,
 * and nothing but this app destroys one: the idle scale-down runs in this
 * process. So quitting, or closing the laptop lid, left the whole fleet
 * billing until the next launch, with nothing rendering or downloading in
 * the meantime. Now:
 *
 * - Quit (Cmd+Q, the menu, the last window closing on Windows, or Ctrl+C,
 *   SIGTERM or a hangup from the terminal the app was started in). If any node
 *   may be billing, the quit waits on a dialog, "N nodes are billing $X/hr",
 *   with Destroy all & quit, Leave running and Cancel. It asks every time
 *   (Elliot, 2026-09-25). On Windows the window being closed stays open
 *   while it asks, so that a shutdown still has a window to ask (below);
 *   with it gone, a dialog left unanswered overnight, then an update's
 *   restart, ended the app with the fleet billing and nothing destroyed
 *   (1.1 review). Destroy all stops the scheduler, destroys every
 *   node, and quits only once each destroy is confirmed. Any it cannot
 *   confirm are listed with the Vast.ai console link, and the app stays up
 *   until the user retries or chooses to quit anyway.
 * - Sleep. Nodes keep billing while the computer sleeps, and nothing renders
 *   or downloads. The app says so as it goes to sleep (an alert and an OS
 *   notification), and on waking says roughly what the sleep cost.
 * - Windows session end (shut down, restart, log off). Nobody can answer a
 *   dialog, so the fleet is destroyed as Destroy all would, and the shutdown
 *   is held while that happens. Windows asks every window first
 *   ('query-session-end'), and while anything bills the app says no, which
 *   puts it on Windows' "preventing shutdown" screen until it exits. Once
 *   'session-end' fires the process may be ended at any moment, too soon for
 *   a DELETE that first waits on an SSH stop, a TLS handshake and a confirm,
 *   so that event is only the fallback for a query that never came.
 * - Windows console closing (SIGHUP there). Windows ends the process about
 *   5 to 10 s later, whatever it is doing (Node's docs). Nobody can answer
 *   a dialog in that time, so it goes as a session end does.
 * - Either way, once the process may be ended at any moment ('session-end',
 *   the console closing), the destroys still waiting their DESTROY_STAGGER_MS
 *   turn start sooner (`hurry`): each once the one before it has settled.
 *   Staggered, only the first 2 to 4 DELETEs went out before Windows ended
 *   the process (1.1 review). destroyFleet says why not all at once.
 * - Headless runs (VR_JOB_SPEC, VR_E2E_BLEND) never show a dialog.
 *   VR_QUIT_POLICY decides what happens on SIGINT, SIGTERM or SIGHUP, on a
 *   quit, on a Windows session end, and at the end of the campaign:
 *   - `destroy` (the default): destroy every node, then exit. When the
 *     campaign is done (no job queued or running), the run stops by itself,
 *     and so it does at once when the campaign's settings could not be put
 *     in force for the run (endCampaign).
 *   - `leave`: exit and leave the nodes as they are. The next launch on the
 *     profile picks them back up. A finished campaign does not stop the run:
 *     it stays up, as it always did, and the idle scale-down retires the
 *     nodes.
 *   The exit status is EXIT_BILLING_LEFT (3) when something the run knows of
 *   may be left billing: a destroy that could not be confirmed (listed on
 *   stderr), or nodes left by `leave`. Otherwise it is EXIT_NOT_SUBMITTED (1)
 *   for a campaign that ended with part of it never submitted (a spec that
 *   did not parse, a blend createJob refused, settings that could not be
 *   put in force), and 0 when all is well.
 *   A signal during the destroy does not cut it short by itself. SIGHUP
 *   never does: it says the terminal went away, so nobody is there to want
 *   out, and closing a terminal delivers it twice, 0.4 ms apart (the shell
 *   resends it to its jobs, then the kernel sends it to the foreground
 *   group; seen on macOS, 1.1 review). Taking the second for "exit now"
 *   abandoned the destroy it had just started, with nobody left to read that
 *   the fleet was billing. One Ctrl+C can arrive twice too (the `electron`
 *   CLI forwards the SIGINT its child already had). So only a SIGINT or
 *   SIGTERM that comes SECOND_SIGNAL_MS or more after an earlier one the run
 *   acted on exits at once, with 3. A first one during a destroy the run
 *   started for another reason (the campaign done, a quit, a session end)
 *   only says how to exit now.
 *
 * Destroy all must rent nothing while it destroys. scheduler.stop() only
 * clears the tick timer, and a kick still ticks. Every destroy kicks
 * (forgetNode requeues the node's chunks), so a stopped scheduler sent the
 * requeued chunks straight back to the dying nodes and rented into the room
 * each destroy freed (1.1 review). And a scale-up batch already in
 * requestNodes read the caps before its first await, so each destroy freed
 * room for its next rental (Phase 0 review, carried into 1.1). So
 * stopScheduling (fleetPort) stops both for good: the scheduler's tick does
 * nothing, and requestNodes finds the fleet full before its next rental. A
 * create already sent is waited for and what it rented destroyed
 * (settleNode). destroyFleet still works in rounds, each one taking the
 * nodes that are billing and have not been tried yet, until a round finds
 * none, for anything that slips past. The app then exits in the same
 * synchronous run as that last look at the fleet. That is enough: the row of
 * a rental is written before its create goes out, so a create that may have
 * rented something is always on a row.
 *
 * The decisions are pure functions. installLifecycle is the Electron adapter.
 * Every Electron object is passed in, and nothing here imports electron, so a
 * test drives the adapter against the real nodeManager and scheduler on the
 * lifecycle harness (lifecycle.quit.test.ts).
 */

import type { NodeSnapshot } from '../../shared/models'
import { capUsage, createOutcomeUnknown, holdsInstance } from '../../shared/nodeState'
import { emit } from '../events'

/** Where the user can see and destroy the account's instances by hand. */
export const VAST_CONSOLE = 'https://cloud.vast.ai/instances/'

/**
 * How long one node's destroy may keep at it before the quit reports it
 * unconfirmed. Passed to destroyNode, whose retries of transient failures
 * stop there (plan 1.2's ensureInstanceGone), rather than its own minute.
 */
export const DESTROY_BUDGET_MS = 20_000

/**
 * More time for a node SSH may have answered. ensureInstanceGone first stops
 * OctaneServer over SSH wherever its pidfile exists, so the OTOY licence is
 * released, before the DELETE even starts, and fleetPort holds that stop to
 * this, whatever the node's Octane state: a server known to have run gets
 * 35 s otherwise, which came out of the DELETE's 20 s. A node gone quiet
 * (after a sleep, say) can spend all of it. Once the process may be ended
 * at any moment (`hurry`) there is no stop at all.
 */
export const OCTANE_STOP_MS = 20_000

/**
 * The gap between one node's destroy and the next. Vast allows one request
 * per endpoint every 3 s for each API key (its rate-limit docs; a DELETE's
 * 429 says "threshold=3.0"), and vastClient retries a 429 inside the call,
 * backing off, for up to 30 s. Six DELETEs sent at once got through one by
 * one down that backoff, and the last were still refused when their budget
 * ran out, reported as maybe billing. Not once the process may be ended at
 * any moment (DestroyOptions.hurry).
 */
export const DESTROY_STAGGER_MS = 3_000

/** A headless run's exit status when instances it rented may still be billing. */
export const EXIT_BILLING_LEFT = 3

/**
 * A headless run's exit status when its campaign ended with part of it never
 * submitted, and nothing is left billing. The same as a launch refused for
 * another instance on the profile: the run did not do what it was asked.
 */
export const EXIT_NOT_SUBMITTED = 1

/**
 * How long after the SIGINT or SIGTERM that armed it another one may end a
 * headless destroy early. One sooner is taken for the same signal delivered
 * twice (see the header).
 */
export const SECOND_SIGNAL_MS = 2_000

/** Headless destroy attempts before giving up. Nobody is there to press "Try again". */
const HEADLESS_ATTEMPTS = 3
const HEADLESS_RETRY_PAUSE_MS = 5_000

/** How often a headless run checks whether its campaign is done. */
const CAMPAIGN_CHECK_MS = 30_000

/** A wake after less sleep than this is not worth an alert. */
const WAKE_NOTICE_MIN_MS = 60_000

// -- decisions ----------------------------------------------------------------

/**
 * The nodes that may be billing, and what they cost together: nodeState's
 * holdsInstance and capUsage, the predicate the caps, the meter and the
 * toolbar read. That takes in a 'failed' node whose destroy Vast never
 * confirmed, a 'destroyed' one not yet confirmed, and a rental whose create
 * has no answer yet: each is something the quit may be leaving behind.
 */
export interface BillingFleet {
  nodes: NodeSnapshot[]
  perHour: number
}

export function billingFleet(nodes: readonly NodeSnapshot[]): BillingFleet {
  return { nodes: nodes.filter(holdsInstance), perHour: capUsage(nodes).perHour }
}

/** "$3.40/hr", the way the dialog and the alerts state a rate. */
export function fmtRate(perHour: number): string {
  return `$${perHour.toFixed(2)}/hr`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "2 h 5 min", "45 min", "under a minute". */
export function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'under a minute'
  const h = Math.floor(min / 60)
  if (h === 0) return `${min} min`
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
}

/**
 * The instance's label on Vast, which is how the console finds one whose id
 * the app never learned. Plan 1.3 adds the install id to it and to the
 * snapshot; until then, the label rentOffer gives it.
 */
export function vastLabel(n: Pick<NodeSnapshot, 'id' | 'label'>): string {
  return n.label ?? `vastai-blender ${n.id.slice(0, 8)}`
}

/** One node, as a line of the failure list: which instance, and what it costs. */
export function describeNode(n: NodeSnapshot): string {
  const gpus = n.gpuName ? `${n.gpuName}${n.numGpus > 1 ? ` ×${n.numGpus}` : ''}, ` : ''
  const rate = fmtRate(n.dphTotal ?? 0)
  return n.instanceId != null
    ? `instance ${n.instanceId} (${gpus}${rate})`
    : `the rental "${vastLabel(n)}" (${gpus}${rate})`
}

/** A message box, and the choice each of its buttons stands for. */
export interface Prompt<C extends string> {
  type: 'warning' | 'error'
  title: string
  message: string
  detail: string
  buttons: string[]
  /** Enter. */
  defaultId: number
  /** Esc, and closing the box. */
  cancelId: number
  /** What each button means, index for index. */
  choices: C[]
  /** Plain buttons on Windows, not command links. */
  noLink: true
  /**
   * `&&` in a label is a literal ampersand on every platform (electron turns
   * it into `&` on macOS and Linux; Windows reads `&&` as `&` itself).
   */
  normalizeAccessKeys: true
}

/** The choice for a message box's response. Anything unexpected reads as Esc. */
export function choiceOf<C extends string>(prompt: Prompt<C>, response: number): C {
  return prompt.choices[response] ?? prompt.choices[prompt.cancelId]
}

export type QuitChoice = 'destroy' | 'leave' | 'cancel'

/**
 * The question a quit asks when nodes may be billing. Enter destroys: of the
 * three it is the one that cannot cost money. Esc and closing the box cancel
 * the quit.
 */
export function quitPrompt(fleet: BillingFleet): Prompt<QuitChoice> {
  const n = fleet.nodes.length
  const renting = fleet.nodes.filter(createMayStillAnswer).length
  return {
    type: 'warning',
    title: 'Quit Vast Render',
    message: `${plural(n, 'node')} ${n === 1 ? 'is' : 'are'} billing ${fmtRate(fleet.perHour)}`,
    detail:
      'Vast.ai bills a rented machine until it is destroyed, whether or not ' +
      'Vast Render is open, and nothing renders or downloads while it is closed.' +
      (renting > 0
        ? ` (${renting} of them ${renting === 1 ? 'is' : 'are'} still being rented.)`
        : '') +
      // "Counts as a failed attempt": forgetNode requeues each chunk in
      // flight and burns one of its retries, as for a node that died.
      '\n\nDestroy all & quit: destroy every node, then quit. Renders in progress ' +
      'stop and go back in the queue for the next time you open the app. Each ' +
      'counts as a failed attempt, so a chunk on its last retry fails.' +
      '\n\nLeave running: quit now. The nodes keep billing until they are ' +
      "destroyed, by the app's idle scale-down once it is open again, or in " +
      'the Vast.ai console.',
    buttons: ['Destroy all && quit', 'Leave running', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    choices: ['destroy', 'leave', 'cancel'],
    noLink: true,
    normalizeAccessKeys: true
  }
}

/** A node Destroy all could not confirm gone, and why. */
export interface DestroyFailure {
  node: NodeSnapshot
  reason: string
}

export type FailureChoice = 'retry' | 'console' | 'quitAnyway'

/**
 * What Destroy all could not confirm. The quit stops here until the user
 * decides: try again, look in the Vast.ai console (the box comes back), or
 * quit knowing those instances bill. There is no way back into the app from
 * here: its scheduler is stopped for good (stopScheduling), so an app left
 * open would render nothing and never scale down.
 */
export function failurePrompt(failures: readonly DestroyFailure[]): Prompt<FailureChoice> {
  const n = failures.length
  return {
    type: 'error',
    title: 'Quit Vast Render',
    message: `${plural(n, 'instance')} may still be billing`,
    detail:
      `Vast Render could not confirm ${n === 1 ? 'this one' : 'these'} destroyed:\n\n` +
      failures.map((f) => `• ${describeNode(f.node)}: ${f.reason}`).join('\n') +
      `\n\nUntil ${n === 1 ? 'it is' : 'they are'} destroyed, ${n === 1 ? 'it keeps' : 'they keep'} ` +
      `billing. Try again, or destroy ${n === 1 ? 'it' : 'them'} in the Vast.ai console: ${VAST_CONSOLE}`,
    buttons: ['Try again', 'Open Vast.ai console', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    choices: ['retry', 'console', 'quitAnyway'],
    noLink: true,
    normalizeAccessKeys: true
  }
}

export type QuitPolicy = 'destroy' | 'leave'

/** VR_QUIT_POLICY for a headless run. Anything but `leave` destroys, and a typo says so. */
export function parseQuitPolicy(value: string | undefined): {
  policy: QuitPolicy
  warning: string | null
} {
  const v = (value ?? '').trim().toLowerCase()
  if (v === '' || v === 'destroy') return { policy: 'destroy', warning: null }
  if (v === 'leave') return { policy: 'leave', warning: null }
  return {
    policy: 'destroy',
    warning: `VR_QUIT_POLICY=${JSON.stringify(value)} is not "destroy" or "leave": destroying on quit`
  }
}

/**
 * A headless campaign is done: no job is queued or running, and no chunk is
 * in flight on any node. Every job is then complete, partial, failed or
 * cancelled, and nothing more will happen without a person (or a new spec).
 */
export function campaignDone(openJobs: number, nodes: readonly NodeSnapshot[]): boolean {
  return openJobs === 0 && nodes.every((n) => n.currentWork.length === 0)
}

/** What going to sleep means for money, said as it happens. */
export function sleepWarning(fleet: BillingFleet): string {
  const n = fleet.nodes.length
  return (
    `Going to sleep with ${plural(n, 'node')} billing ${fmtRate(fleet.perHour)}: ` +
    `${n === 1 ? 'it keeps' : 'they keep'} billing while this computer sleeps, ` +
    'and nothing renders or downloads until it wakes'
  )
}

/** What the fleet was when the computer went to sleep. */
export interface Asleep {
  at: number
  nodes: number
  perHour: number
}

/**
 * On waking: how long it slept and about what that cost, or null when
 * nothing was billing or the nap was too short to mention. "About", because
 * it is the quoted rate times the time: the meter (accrueCosts) charges one
 * minute per tick while the app runs, and never counted this time (#66).
 */
export function wakeNotice(asleep: Asleep | null, now: number): string | null {
  if (!asleep || asleep.nodes === 0) return null
  const ms = now - asleep.at
  if (ms < WAKE_NOTICE_MIN_MS) return null
  const cost = (asleep.perHour * ms) / 3_600_000
  return (
    `Awake after ${fmtDuration(ms)}: ${plural(asleep.nodes, 'node')} billed about ` +
    `$${cost.toFixed(2)} while this computer slept, with nothing rendering or downloading`
  )
}

// -- destroying the fleet -----------------------------------------------------

/**
 * What the lifecycle needs of the fleet. index.ts builds it from nodeManager
 * and the scheduler (fleetPort below), and so does the test, so the two
 * cannot drift.
 */
export interface FleetPort {
  /** Every node the app knows of this session. */
  list(): NodeSnapshot[]
  /** One node, fresh from the database. */
  snapshot(id: string): NodeSnapshot | undefined
  /**
   * nodeManager.destroyNode, retrying transient failures for at most
   * `budgetMs`, after an Octane stop of at most OCTANE_STOP_MS, or none with
   * `skipOctaneStop` (the process may be ended at any moment: `hurry`).
   */
  destroyNode(id: string, budgetMs: number, opts?: { skipOctaneStop?: boolean }): Promise<void>
  /**
   * Stop dispatching and renting, for good: only ever on the way out. After
   * this nothing is sent to a node and no create goes out, whatever kicks
   * the scheduler. A create already sent is not recalled.
   */
  stopScheduling(): void
  /** Close every node connection and stop the node timers. */
  shutdown(): void
  /**
   * On waking: meter the time asleep (nodeManager.accrueElapsed) and check
   * the account against the rows now (nodeManager.reconcile). index.ts adds
   * both to fleetPort's; a test's port may leave them out.
   */
  accrueSleep?(sleptMs: number): unknown
  reconcile?(): unknown
}

/** The parts of nodeManager and the scheduler that fleetPort reads (and, to stop them, writes). */
interface NodeManagerLike {
  list(): NodeSnapshot[]
  get(id: string): { snapshot: NodeSnapshot } | undefined
  destroyNode(id: string, opts: { budgetMs?: number; octaneStopMs?: number }): Promise<void>
  shutdown(): void
  activeCount(): number
}

interface SchedulerLike {
  stop(): void
  tick(): Promise<void>
}

export function fleetPort(nodes: NodeManagerLike, scheduler: SchedulerLike): FleetPort {
  return {
    list: () => nodes.list(),
    snapshot: (id) => nodes.get(id)?.snapshot,
    destroyNode: (id, budgetMs, opts) =>
      nodes.destroyNode(id, {
        budgetMs,
        octaneStopMs: opts?.skipOctaneStop ? 0 : OCTANE_STOP_MS
      }),
    stopScheduling: () => {
      scheduler.stop()
      // A stopgap, on these two instances, until the scheduler has a stop
      // that holds and requestNodes a way to be told to stop renting (see
      // the header). The timer and every kick (a destroy's forgetNode, a
      // finishing run, a job submitted) call tick, which dispatches and then
      // rents (scalePolicy); from here it does nothing. requestNodes checks
      // activeCount() against maxActiveNodes before each rental, and so does
      // requestNode (the Fleet's button): a fleet that reads as full stops
      // a batch already under way before its next create, and any batch
      // after it. Nothing else reads activeCount. lifecycle.quit.test.ts's
      // "rents nothing" and scale-up batch scenarios fail if either stops
      // holding.
      scheduler.tick = async () => {}
      nodes.activeCount = () => Number.POSITIVE_INFINITY
    },
    shutdown: () => nodes.shutdown()
  }
}

export interface DestroyOptions {
  /** Time allowed for one node. Default DESTROY_BUDGET_MS, plus OCTANE_STOP_MS once it has an SSH endpoint. */
  budgetMs?: (n: NodeSnapshot) => number
  /** How often a wait re-reads a node. */
  pollMs?: number
  /** Rounds before giving up on a fleet that keeps growing. */
  maxRounds?: number
  /** Gap between the start of one node's destroy and the next. Default DESTROY_STAGGER_MS. */
  staggerMs?: number
  /**
   * Aborted when the process may be ended at any moment: a destroy waiting
   * its turn starts once the one before it has settled (see destroyFleet),
   * and the next pass without its pause.
   */
  hurry?: AbortSignal
}

function defaultBudget(n: NodeSnapshot): number {
  // An endpoint is the nearest a snapshot comes to "SSH has answered".
  return DESTROY_BUDGET_MS + (n.sshHost != null ? OCTANE_STOP_MS : 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * `ms`, or less once `hurry` is aborted: no longer than until `previous` has
 * settled, or not at all when there is none.
 */
function pause(
  ms: number,
  hurry: AbortSignal | undefined,
  previous?: Promise<unknown>
): Promise<void> {
  if (!hurry) return sleep(ms)
  return new Promise((resolve) => {
    let settled = previous === undefined
    const done = (): void => {
      clearTimeout(timer)
      hurry.removeEventListener('abort', onHurry)
      resolve()
    }
    const onHurry = (): void => {
      if (settled && hurry.aborted) done()
    }
    const timer = setTimeout(done, ms)
    hurry.addEventListener('abort', onHurry)
    void previous?.then(
      () => ((settled = true), onHurry()),
      () => ((settled = true), onHurry())
    )
    if (hurry.aborted) onHurry()
  })
}

/** Whether `p` settled within `ms`. A destroy that loses the race carries on regardless. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), Math.max(0, ms))))
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true
      ),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A create that may still answer: no instance id, no known outcome, and not
 * ended 'failed'. A create in flight, or one whose reply was lost and whose
 * instance plan 1.4's lookup is looking for by its label, is 'requested', or
 * 'destroying' or 'destroyed' if a destroy landed on it meanwhile (rentOffer
 * then destroys whatever turns up). Either may settle within the quit. A
 * 'failed' row with no known outcome will not: an older build's lost create,
 * left so, that the boot's sweep could not look up (Vast not answering). A
 * row an earlier run left 'requested' that the sweep could not settle reads
 * as in flight too, and costs its budget in waiting.
 */
function createMayStillAnswer(n: NodeSnapshot): boolean {
  return createOutcomeUnknown(n) && n.state !== 'failed'
}

/**
 * Destroy one node within `budgetMs`. Resolves null once it is confirmed not
 * billing, or with the reason it may still be.
 */
async function settleNode(
  fleet: FleetPort,
  id: string,
  budgetMs: number,
  pollMs: number,
  hurry?: AbortSignal
): Promise<string | null> {
  const deadline = Date.now() + budgetMs
  const secs = `${Math.round(budgetMs / 1000)} s`
  let n = fleet.snapshot(id)
  // A create with no answer yet. destroyNode has no instance id to destroy:
  // it marks the node destroyed and leaves whatever the create returns to
  // rentOffer, and the row holds until that destroy is confirmed. Waiting
  // here for the answer, then destroying what it rented, lets this node's
  // budget cover the whole of it.
  while (n && createMayStillAnswer(n) && Date.now() < deadline) {
    await sleep(pollMs)
    n = fleet.snapshot(id)
  }
  if (!n || !holdsInstance(n)) return null
  if (createOutcomeUnknown(n)) {
    // Still out when the budget ran out, and still wanted: destroyed now, so
    // that whatever it rents is destroyed when it answers (rentOffer, or
    // 1.4's lookup), with no Try again. Left 'requested', a reply after the
    // budget (a PUT may take 30 s, the lookup a minute more) drove the
    // instance to ready and billing behind the failure list (1.1 review).
    // One already destroying or destroyed is left to that.
    if (createMayStillAnswer(n) && n.state === 'requested') {
      await fleet.destroyNode(id, 0).catch(() => {})
      n = fleet.snapshot(id)
      if (!n || !holdsInstance(n)) return null
    }
    return `Vast never answered its create; look for "${vastLabel(n)}" in the Vast.ai console`
  }
  // A destroy already under way (the idle scale-down, the Fleet's button) is
  // joined, not repeated: ensureInstanceGone runs one check per instance.
  const left = deadline - Date.now()
  // Hurried, the OctaneServer stop goes: on a node gone quiet it could
  // take all the seconds the OS leaves before this node's DELETE (a1 review).
  const settled = await settlesWithin(
    fleet
      .destroyNode(id, Math.min(DESTROY_BUDGET_MS, left), { skipOctaneStop: hurry?.aborted })
      .catch(() => {}),
    left
  )
  n = fleet.snapshot(id)
  if (!n || !holdsInstance(n)) return null
  if (!settled) return `no answer from Vast.ai within ${secs}`
  return n.lastError ?? 'the destroy did not complete'
}

/**
 * Destroy every node that may be billing, in rounds, until a round finds no
 * billing node it has not tried (see the header: anything that slips past
 * stopScheduling). Each round starts its nodes' destroys one
 * DESTROY_STAGGER_MS apart, dearest first, and lets them overlap; each has
 * its own budget from its own start. Returns what is still billing, with the
 * reason where a destroy was tried.
 *
 * Once `hurry` is aborted, the next destroy starts as soon as the last one
 * has settled, or its 3 s are up, whichever is first. Not all at once:
 * under the per-endpoint limit Vast documents, DELETEs sent together are
 * refused but one, and vastClient retries the rest 2, 6 and 14 s later, so
 * all-at-once got 2 of 6 through in 10 s where one every 3 s gets 4
 * (lifecycle.quit.test.ts, against vastRateLimit). Should the limit turn
 * out to be per instance, each goes the moment the one before it is done.
 *
 * The answer is only as fresh as the last await. A caller that exits on an
 * empty answer must look at the fleet again in the same synchronous run as
 * the exit, as installLifecycle does.
 */
export async function destroyFleet(
  fleet: FleetPort,
  opts: DestroyOptions = {}
): Promise<DestroyFailure[]> {
  const budget = opts.budgetMs ?? defaultBudget
  const pollMs = opts.pollMs ?? 250
  const maxRounds = opts.maxRounds ?? 5
  const staggerMs = opts.staggerMs ?? DESTROY_STAGGER_MS
  const reasons = new Map<string, string | null>()
  for (let round = 0; round < maxRounds; round++) {
    const fresh = fleet
      .list()
      .filter((n) => holdsInstance(n) && !reasons.has(n.id))
      .sort((a, b) => (b.dphTotal ?? 0) - (a.dphTotal ?? 0))
    if (fresh.length === 0) break
    for (const n of fresh) reasons.set(n.id, null)
    const settling: Array<Promise<string | null>> = []
    for (const n of fresh) {
      const previous = settling.at(-1)
      if (previous) await pause(staggerMs, opts.hurry, previous)
      settling.push(
        settleNode(fleet, n.id, budget(n), pollMs, opts.hurry).catch((e: unknown) => String(e))
      )
    }
    const results = await Promise.all(settling)
    results.forEach((reason, i) => reasons.set(fresh[i].id, reason))
  }
  return failuresOf(fleet.list(), reasons)
}

function failuresOf(
  nodes: readonly NodeSnapshot[],
  reasons: ReadonlyMap<string, string | null>
): DestroyFailure[] {
  return nodes.filter(holdsInstance).map((node) => ({
    node,
    reason: reasons.get(node.id) ?? 'rented while the fleet was being destroyed'
  }))
}

// -- the Electron adapter -----------------------------------------------------

/** What `before-quit` hands its listeners. */
export interface QuitEvent {
  preventDefault(): void
}

/** A window, as far as a Windows session end goes. */
export interface SessionWindow {
  /** Windows asks whether the session may end. preventDefault says not yet. */
  on(event: 'query-session-end', listener: (event: QuitEvent) => void): unknown
  /** The session is ending, and nothing can stop it. */
  on(event: 'session-end', listener: () => void): unknown
}

/** electron's `app`, as far as this module uses it. */
export interface LifecycleApp {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown
  on(
    event: 'browser-window-created',
    listener: (event: unknown, window: SessionWindow) => void
  ): unknown
  exit(exitCode?: number): void
}

/** The signals that stop the app: Ctrl+C, a kill, and a terminal (or console) gone away. */
export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'
const SIGNALS: readonly Signal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** `W` is the window a message box is shown against: a BrowserWindow in the app. */
export interface LifecycleDeps<W = unknown> {
  app: LifecycleApp
  powerMonitor: { on(event: 'suspend' | 'resume', listener: () => void): unknown }
  /** dialog.showMessageBox, against `parent` when there is one. Resolves the button index. */
  showMessageBox(parent: W | null, prompt: Prompt<string>): Promise<number>
  openExternal(url: string): unknown
  /** An OS notification. */
  notify(body: string): void
  /** Bring the app forward for a dialog, and return the window to show it against. */
  frontWindow(): W | null
  /**
   * After a cancelled quit: a window, when none is open. On Linux the last
   * window has already closed by the time the quit asks, and the app would
   * otherwise run on, billing, with nothing on screen. (On Windows it is
   * kept open for the question: holdWindowClose.)
   */
  ensureWindow(): void
  fleet: FleetPort
  closeDb(): void
  /** null for the app a person runs; the quit policy for a headless run. */
  headless: { policy: QuitPolicy } | null
  /**
   * Where SIGINT, SIGTERM and SIGHUP arrive: `process`. A headless run
   * follows its policy; a person's app asks, as for Cmd+Q.
   */
  signals: { on(signal: Signal, listener: () => void): unknown }
  /** A line for a script's stderr, written before the process exits. */
  stderr(text: string): void
  /** process.platform, by default. On 'win32' a SIGHUP is the console closing. */
  platform?: NodeJS.Platform
  /** Test knobs for destroyFleet. */
  destroy?: DestroyOptions
}

export interface Lifecycle {
  /**
   * A headless run's campaign is submitted: from now on, once no job is
   * queued or running (`openJobs`), the run destroys its fleet and exits
   * (VR_QUIT_POLICY=destroy). `unsubmitted` says what of the campaign never
   * made it in (a spec that did not parse, a blend createJob refused): with
   * any, the run still ends when the rest is done, but with
   * EXIT_NOT_SUBMITTED, and says why on stderr. A no-op for the app a person
   * runs, and under `leave`.
   */
  watchCampaign(openJobs: () => number, unsubmitted?: readonly string[]): void
  /**
   * A headless run's campaign was refused whole, before any of it was
   * submitted: its spec's settings could not be put in force for this run
   * (app/headless/jobSpec.ts). The run ends now, by its policy, rather than
   * wait out jobs an earlier run left open. The scheduler would render those
   * at the saved settings, a fleet size, spend cap and filters the campaign
   * did not ask for. The exit status is EXIT_NOT_SUBMITTED, with
   * `unsubmitted` on stderr, or EXIT_BILLING_LEFT as ever. A no-op for the
   * app a person runs, and once a quit is under way.
   */
  endCampaign(unsubmitted: readonly string[]): void
  /**
   * A person is closing the app's last window, where that quits it (index.ts
   * asks on Windows). True keeps the window (the caller's preventDefault):
   * with anything billing, the quit asks now, with the window still there,
   * or it is already asking or destroying. The quit's own ending, app.exit,
   * closes it. False lets it close. Always false for a headless run.
   */
  holdWindowClose(): boolean
}

/** A console line that cannot throw (a full disk under stdout: see events.ts). */
function say(line: string): void {
  try {
    console.log(line)
  } catch {
    // Nowhere left to say it.
  }
}

export function installLifecycle<W>(deps: LifecycleDeps<W>): Lifecycle {
  const { fleet } = deps
  // idle: running normally. asking: the quit dialog is up. destroying:
  // Destroy all (or an unattended stop) is under way, its failure dialog
  // included. exiting: app.exit is being called.
  let phase: 'idle' | 'asking' | 'destroying' | 'exiting' = 'idle'
  // Read through a call, where a narrowed `phase` would not see what a call
  // just before it changed.
  const destroying = (): boolean => phase === 'destroying'
  let asleep: Asleep | null = null
  // Aborted once the process may be ended at any moment (see the header).
  const hurry = new AbortController()
  const destroyOptions: DestroyOptions = { ...deps.destroy, hurry: hurry.signal }
  const consoleClosing = (signal: Signal): boolean =>
    signal === 'SIGHUP' && (deps.platform ?? process.platform) === 'win32'

  const contained = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      say(`[lifecycle] ${what} failed on the way out: ${(e as Error)?.message ?? e}`)
    }
  }

  /**
   * Leave. Synchronous from the caller's last look at the fleet to app.exit,
   * so nothing can rent in between. Each step is contained: a throw in one
   * must not keep the app from exiting, with its scheduler already stopped.
   */
  const finish = (code: number): void => {
    phase = 'exiting'
    contained('stopping the scheduler', () => fleet.stopScheduling())
    contained('closing node connections', () => fleet.shutdown())
    contained('closing the database', () => deps.closeDb())
    deps.app.exit(code)
  }

  const listing = (nodes: readonly DestroyFailure[]): string =>
    nodes.map((f) => `  ${describeNode(f.node)}: ${f.reason}\n`).join('')

  /** Ask the user. A box that fails to show counts as its Esc. */
  const ask = async <C extends string>(prompt: Prompt<C>): Promise<C> => {
    try {
      return choiceOf(prompt, await deps.showMessageBox(deps.frontWindow(), prompt))
    } catch (e) {
      say(`[lifecycle] dialog failed: ${(e as Error)?.message ?? e}`)
      return prompt.choices[prompt.cancelId]
    }
  }

  /** Destroy all & quit, for a person: failures are shown, and the quit waits on them. */
  const destroyAndQuit = async (): Promise<void> => {
    phase = 'destroying'
    fleet.stopScheduling()
    const count = billingFleet(fleet.list()).nodes.length
    if (count > 0) {
      emit('alert', {
        level: 'info',
        message: `Destroying ${plural(count, 'node')} before quitting…`
      })
    }
    for (;;) {
      const tried = await destroyFleet(fleet, destroyOptions)
      if (phase !== 'destroying') return
      // In the same synchronous run as the exit: see destroyFleet.
      const still = fleet.list().filter(holdsInstance)
      if (still.length === 0) return finish(0)
      const failures = still.map(
        (node) =>
          tried.find((f) => f.node.id === node.id) ?? {
            node,
            reason: 'rented while the fleet was being destroyed'
          }
      )
      let choice: FailureChoice
      for (;;) {
        choice = await ask(failurePrompt(failures))
        if (choice !== 'console') break
        contained('opening the Vast.ai console', () => deps.openExternal(VAST_CONSOLE))
      }
      if (phase !== 'destroying') return
      if (choice === 'quitAnyway') {
        say(
          `[lifecycle] quitting with ${plural(failures.length, 'instance')} unconfirmed:\n${listing(failures)}`
        )
        return finish(0)
      }
    }
  }

  /**
   * Stop without asking: a headless run, or a Windows session ending.
   * `policy` says what happens to the fleet, `attempts` how many destroy
   * passes before giving up, and `code` the exit status when nothing is left
   * billing.
   */
  const stopUnattended = async (
    why: string,
    policy: QuitPolicy,
    attempts: number,
    code = 0
  ): Promise<void> => {
    phase = 'destroying'
    const billing = billingFleet(fleet.list())
    if (billing.nodes.length === 0) return finish(code)
    if (policy === 'leave') {
      deps.stderr(
        `[vast-render] ${why}: leaving ${plural(billing.nodes.length, 'node')} billing ` +
          `${fmtRate(billing.perHour)}, as VR_QUIT_POLICY=leave asks:\n` +
          listing(billing.nodes.map((node) => ({ node, reason: 'left running' })))
      )
      return finish(EXIT_BILLING_LEFT)
    }
    say(`[vast-render] ${why}: destroying ${plural(billing.nodes.length, 'node')} before exiting`)
    fleet.stopScheduling()
    for (let attempt = 1; ; attempt++) {
      const tried = await destroyFleet(fleet, destroyOptions)
      if (phase !== 'destroying') return
      // In the same synchronous run as the exit: see destroyFleet.
      if (!fleet.list().some(holdsInstance)) return finish(code)
      if (attempt >= attempts) {
        const still = failuresOf(
          fleet.list(),
          new Map(tried.map((f) => [f.node.id, f.reason] as const))
        )
        deps.stderr(
          `[vast-render] ${plural(still.length, 'instance')} may still be billing; ` +
            `check the Vast.ai console (${VAST_CONSOLE}):\n${listing(still)}`
        )
        return finish(EXIT_BILLING_LEFT)
      }
      await pause(HEADLESS_RETRY_PAUSE_MS, hurry.signal)
      if (phase !== 'destroying') return
    }
  }

  /** The dialog, for a person quitting. */
  const askAndQuit = async (): Promise<void> => {
    const billing = billingFleet(fleet.list())
    // Nothing billing: leave at once, in this same run, so no scale-up
    // batch still searching for offers gets to send a create first.
    if (billing.nodes.length === 0) return finish(0)
    phase = 'asking'
    const choice = await ask(quitPrompt(billing))
    // A Windows session end took over while the dialog was up.
    if (phase !== 'asking') return
    if (choice === 'cancel') {
      phase = 'idle'
      deps.ensureWindow()
      return
    }
    if (choice === 'leave') {
      say(`[lifecycle] quitting, leaving ${plural(billing.nodes.length, 'node')} billing`)
      return finish(0)
    }
    await destroyAndQuit()
  }

  const fail = (what: string) => (e: unknown) => {
    say(`[lifecycle] ${what} failed: ${(e as Error)?.stack ?? e}`)
  }

  deps.app.on('before-quit', (event) => {
    if (phase === 'exiting') return
    // Always held: the quit goes ahead through finish() and app.exit, once
    // it is decided, and never on Electron's own schedule meanwhile.
    event.preventDefault()
    if (phase !== 'idle') {
      // A second Cmd+Q while the dialog is up, or while destroying. A
      // headless run has no dialog to bring forward, and on Windows its
      // window may be minimized on purpose (index.ts).
      if (!deps.headless) deps.frontWindow()
      return
    }
    if (deps.headless) {
      void stopUnattended('quit', deps.headless.policy, HEADLESS_ATTEMPTS).catch(fail('quit'))
    } else {
      void askAndQuit().catch(fail('quit'))
    }
  })

  // Windows: shut down, restart or log off. Nobody will answer a dialog, so
  // it goes as Destroy all would (or as VR_QUIT_POLICY says), and takes over
  // from a quit dialog that is up: whatever that says later is ignored
  // (phase). Every window is asked, so each one listens.
  const sessionPolicy = (): QuitPolicy => deps.headless?.policy ?? 'destroy'
  deps.app.on('browser-window-created', (_event, window) => {
    // Asked first, while the session can still be held. With anything
    // billing, the answer is "not yet" (preventDefault), and Windows lists
    // the app as preventing shutdown until the destroy is done and it exits.
    // A user who presses "Shut down anyway" there, or a forced shutdown,
    // still ends it at once. One who cancels the shutdown has the fleet
    // destroyed and the app quit all the same: that is what was asked of it.
    // Under `leave` there is nothing to wait for.
    window.on('query-session-end', (event) => {
      if (phase === 'exiting' || sessionPolicy() === 'leave') return
      if (!fleet.list().some(holdsInstance)) return
      event.preventDefault()
      if (phase === 'destroying') return
      void stopUnattended('session end', 'destroy', HEADLESS_ATTEMPTS).catch(fail('session end'))
    })
    // The session is ending now, and the process may be ended any moment
    // after this returns: too soon, most likely, for the destroy it starts.
    // Only for a session end that was never asked about, or went ahead
    // anyway; after a held one the destroy is already under way.
    window.on('session-end', () => {
      hurry.abort()
      if (phase === 'destroying' || phase === 'exiting') return
      void stopUnattended('session end', sessionPolicy(), 1).catch(fail('session end'))
    })
  })

  deps.powerMonitor.on('suspend', () => {
    const billing = billingFleet(fleet.list())
    asleep = { at: Date.now(), nodes: billing.nodes.length, perHour: billing.perHour }
    if (billing.nodes.length === 0) return
    const warning = sleepWarning(billing)
    emit('alert', { level: 'warn', message: warning })
    // An alert may reach no one: ipc.ts notifies only for errors and billing
    // risks, and only while no window is in front.
    contained('notifying', () => deps.notify(warning))
  })

  deps.powerMonitor.on('resume', () => {
    const notice = wakeNotice(asleep, Date.now())
    const sleptMs = asleep ? Date.now() - asleep.at : 0
    asleep = null
    if (notice) emit('alert', { level: 'warn', message: notice })
    contained('accruing the sleep', () => void fleet.accrueSleep?.(sleptMs))
    contained('reconciling', () => void fleet.reconcile?.())
  })

  if (deps.headless) {
    const { policy } = deps.headless
    // When a SIGINT or SIGTERM the run acted on arrived: the one that started
    // the destroy, or the first during one started otherwise. Only another
    // SECOND_SIGNAL_MS or more after it ends the destroy early (header).
    let armedAt: number | null = null
    const arm = (signal: Signal): void => {
      armedAt = Date.now()
      deps.stderr(
        `[vast-render] ${signal === 'SIGINT' ? 'Ctrl+C' : signal} again, ` +
          `${SECOND_SIGNAL_MS / 1000} s or more from now, exits without waiting for the ` +
          'destroy, and lists what may still be billing\n'
      )
    }
    const onSignal = (signal: Signal) => (): void => {
      if (phase === 'exiting') return
      if (consoleClosing(signal)) hurry.abort()
      if (phase === 'idle') {
        // Synchronous up to its first await: 'destroying' once it returns
        // unless there was nothing to wait for and it has exited.
        void stopUnattended(signal, policy, HEADLESS_ATTEMPTS).catch(fail(signal))
        // A hangup is not armed: nobody is at a terminal that hung up.
        if (destroying() && signal !== 'SIGHUP') arm(signal)
        return
      }
      if (signal === 'SIGHUP') {
        say('[vast-render] SIGHUP: the terminal went away; the destroy carries on')
        return
      }
      if (armedAt === null) return arm(signal)
      // The same signal, delivered twice.
      if (Date.now() - armedAt < SECOND_SIGNAL_MS) return
      // Asked twice, by someone at the terminal: out now, destroy or not.
      const still = billingFleet(fleet.list()).nodes.map((node) => ({
        node,
        reason: 'its destroy was still under way'
      }))
      deps.stderr(
        `[vast-render] ${signal} again: exiting without waiting; ` +
          `${plural(still.length, 'instance')} may still be billing ` +
          `(${VAST_CONSOLE}):\n${listing(still)}`
      )
      return finish(still.length > 0 ? EXIT_BILLING_LEFT : 0)
    }
    for (const signal of SIGNALS) deps.signals.on(signal, onSignal(signal))
  } else {
    // A person's app started from a terminal (`npm run dev`, the working
    // arrangement for renders). Electron's own handler for these signals
    // has one shot: it puts the signal back to its default before it quits,
    // so a closed terminal's second SIGHUP, or a second Ctrl+C, killed the
    // process while the dialog was up, the fleet billing and nothing asked
    // (1.1 review). A listener here takes over from it. A signal quits as
    // Cmd+Q does, through the dialog, which can still be answered in the
    // window once the terminal is gone. More of them while it is up, or
    // while Destroy all runs, change nothing.
    for (const signal of SIGNALS) {
      deps.signals.on(signal, () => {
        if (phase === 'exiting') return
        if (consoleClosing(signal)) {
          // Windows ends the process 5 to 10 s from now: no time for the
          // dialog to be answered. As a session end: the fleet destroyed,
          // taking over from a dialog that is up, each DELETE as soon as
          // it can go (hurry).
          hurry.abort()
          if (phase === 'destroying') return
          void stopUnattended('the console window closed', sessionPolicy(), 1).catch(fail(signal))
          return
        }
        if (phase !== 'idle') return
        say(`[lifecycle] ${signal}: quitting`)
        void askAndQuit().catch(fail(signal))
      })
    }
  }

  return {
    holdWindowClose(): boolean {
      if (deps.headless || phase === 'exiting') return false
      // The dialog, or Destroy all and its failure list, is up against it.
      if (phase !== 'idle') return true
      if (!fleet.list().some(holdsInstance)) return false
      void askAndQuit().catch(fail('quit'))
      return true
    },

    watchCampaign(openJobs: () => number, unsubmitted: readonly string[] = []): void {
      if (deps.headless?.policy !== 'destroy') return
      // A campaign that never made it in has nothing to wait for and ends
      // a check or two later. Exiting 0 for it told the script all went
      // well (1.1 review).
      const code = unsubmitted.length > 0 ? EXIT_NOT_SUBMITTED : 0
      // Done twice in a row, a check apart: a chunk requeued between two
      // states, or a job refreshed a moment late, is not the end.
      let doneBefore = false
      const timer = setInterval(() => {
        if (phase !== 'idle') {
          clearInterval(timer)
          return
        }
        let done: boolean
        try {
          done = campaignDone(openJobs(), fleet.list())
        } catch (e) {
          say(`[lifecycle] campaign check failed: ${(e as Error)?.message ?? e}`)
          return
        }
        if (done && doneBefore) {
          clearInterval(timer)
          if (code !== 0) {
            deps.stderr(
              `[vast-render] campaign done, but not all of it was submitted:\n` +
                unsubmitted.map((u) => `  ${u}\n`).join('')
            )
          }
          void stopUnattended('campaign done', 'destroy', HEADLESS_ATTEMPTS, code).catch(
            fail('campaign end')
          )
        }
        doneBefore = done
      }, CAMPAIGN_CHECK_MS)
    },

    endCampaign(unsubmitted: readonly string[]): void {
      if (!deps.headless || phase !== 'idle') return
      deps.stderr(
        '[vast-render] the campaign was not submitted, so the run ends now:\n' +
          unsubmitted.map((u) => `  ${u}\n`).join('')
      )
      void stopUnattended(
        'campaign not submitted',
        deps.headless.policy,
        HEADLESS_ATTEMPTS,
        EXIT_NOT_SUBMITTED
      ).catch(fail('campaign end'))
    }
  }
}
