/**
 * Why the fleet is not renting, as HoldsBanner says it (plans 1.9, 1.10,
 * 1.17, 1.20; finding #200). Each hold in FleetHolds stops scale-up on its
 * own, and before this nothing on screen said which one had: a spent Vast
 * balance, a full disk and a backing-off scale-up all looked like "working,
 * please wait", with jobs sitting queued. Pure, so each row's words and
 * buttons have a test.
 */

import type { FleetHoldKind, FleetHolds } from '../../../shared/models'

/** What a row's release button does, when it has one. */
export interface HoldRelease {
  label: string
  title: string
  /** the primary action of its row (Resume), rather than a secondary one */
  primary?: boolean
}

export interface HoldRow {
  /** the FleetHolds key; a key this build does not know yet is still shown */
  kind: string
  /** 'danger' for money (the account), 'warn' for the rest */
  tone: 'danger' | 'warn'
  text: string
  /** when it was set; null = not known */
  since: number | null
  release: HoldRelease | null
  /** offer the Vast billing page */
  topUp: boolean
  /** offer Settings' API key section: Vast refused the key, not the balance */
  apiKey: boolean
}

const KNOWN: ReadonlySet<string> = new Set<FleetHoldKind>([
  'account',
  'recovery',
  'localSink',
  'scale'
])

/**
 * An account hold for the key rather than the balance: classify()'s account
 * reasons name the 401 or 403, or the key. Only which buttons to offer rides
 * on this; the reason is shown as main wrote it either way.
 */
const AUTH_REASON = /\b40[13]\b|api key|unauthori[sz]ed|forbidden|permission|refused the account/i

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

/** Ensure a reason ends as a sentence does, without doubling main's own full stop. */
function sentence(s: string): string {
  const t = s.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/**
 * One row per hold in force, money first: the account, then this
 * computer's disk (which pauses work already rented, not only renting),
 * then scale-up's back-off, then recovered work waiting for a yes.
 */
export function holdRows(holds: FleetHolds | null | undefined): HoldRow[] {
  if (!holds) return []
  const rows: HoldRow[] = []
  const a = holds.account
  if (a) {
    const auth = AUTH_REASON.test(a.reason)
    // Main's runway reason already names the balance ("Vast balance $0.42,
    // lasts ..."); said twice it reads as two different figures.
    const balance =
      a.balance != null && !/balance/i.test(a.reason)
        ? ` Vast balance $${a.balance.toFixed(2)}.`
        : ''
    rows.push({
      kind: 'account',
      tone: 'danger',
      text: `Renting is paused: ${sentence(a.reason)}${balance} Nodes already rented keep rendering and billing.`,
      since: a.since,
      release: {
        label: 'Try now',
        title: auth
          ? 'Ask Vast.ai again now, for a key fixed in Settings'
          : 'Ask Vast.ai again now, after a top-up. It comes back if the balance is still short.'
      },
      topUp: !auth,
      apiKey: auth
    })
  }
  const d = holds.localSink
  if (d) {
    rows.push({
      kind: 'localSink',
      tone: 'warn',
      text: `Downloads and new work are paused: ${sentence(d.reason)} Frames stay on the nodes until this computer can take them.`,
      since: d.since,
      release: {
        label: 'Check again',
        title: 'Check the disk now, after freeing space or reconnecting the drive'
      },
      topUp: false,
      apiKey: false
    })
  }
  const s = holds.scale
  if (s) {
    const when = s.retryAt != null ? ` Trying again at ${clock(s.retryAt)}.` : ''
    rows.push({
      kind: 'scale',
      tone: 'warn',
      text: `Scale-up is backing off: ${sentence(s.reason)}${when}`,
      since: s.since,
      release: { label: 'Try now', title: 'Let scale-up rent again now' },
      topUp: false,
      apiKey: false
    })
  }
  if (holds.recovery != null && holds.recovery > 0) {
    rows.push({
      kind: 'recovery',
      tone: 'warn',
      text:
        `${plural(holds.recovery, 'unfinished chunk')} recovered from your last session. ` +
        "Renting is paused so this doesn't start a fleet you weren't expecting; " +
        'nodes already up still take the work.',
      since: null,
      release: {
        label: 'Resume rendering',
        title: 'Let the fleet scale up for the recovered work',
        primary: true
      },
      topUp: false,
      apiKey: false
    })
  }
  // A hold main adds before this build knows its name: still a reason the
  // fleet is not renting, so it is said, with the release it has.
  for (const [kind, v] of Object.entries(holds as Record<string, unknown>)) {
    if (KNOWN.has(kind) || v == null || typeof v !== 'object') continue
    const reason = (v as { reason?: unknown }).reason
    if (typeof reason !== 'string') continue
    const since = (v as { since?: unknown }).since
    rows.push({
      kind,
      tone: 'warn',
      // Plan 1.18's: only Octane rentals wait on it.
      text:
        kind === 'octaneSignIn'
          ? `Octane rentals are paused: ${sentence(reason)} Open the VNC login on a node waiting for a sign-in, or release this.`
          : `Renting is paused: ${sentence(reason)}`,
      since: typeof since === 'number' ? since : null,
      release: { label: 'Release', title: 'Let the fleet rent again' },
      topUp: false,
      apiKey: false
    })
  }
  return rows
}
