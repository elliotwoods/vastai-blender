/**
 * Manifest-driven incremental download: polls a chunk's manifest.jsonl on the
 * node every few seconds, pulls new entries (frames + preview clips) with
 * hash verification, records them in the DB, and emits asset events. Never
 * lists remote directories — partially-written files are invisible until the
 * agent manifests them.
 */

import { promises as fsp } from 'fs'
import { rm } from 'fs/promises'
import { dirname, join } from 'path'
import { getDb } from '../db/db'
import { describeError } from '../errors'
import { emit } from '../events'
import { jobFileMediaUrl } from '../mediaUrl'
import { isInside, resolveInside } from '../paths'
import { getSettings } from '../settings'
import {
  discardPartial,
  DOWNLOAD_STALL_MS,
  downloadFileVerified,
  isRemoteMissing,
  LOCAL_FREE_RESERVE_BYTES,
  LocalSinkError
} from '../ssh/sftp'
import type { SshConnection } from '../ssh/sshConnection'
import {
  manifestReject,
  parseFrameName,
  parseManifest,
  type ManifestEntry,
  type ManifestReject
} from './manifest'

const POLL_MS = 5_000

/** Transient-failure budget per file before we stop re-queuing it. */
const MAX_ATTEMPTS = 4

/** Backoff before a failed transfer is retried (× attempt number). */
const RETRY_BACKOFF_MS = 3_000

/** A manifest read (a tiny `cat`) that takes longer than this has hung. */
const MANIFEST_READ_TIMEOUT_MS = 30_000

/**
 * The final pass's manifest read is tried this many times before drain()
 * reports it failed, backing off FINAL_READ_BACKOFF_MS, then twice that, and
 * so on between tries (5 + 10 + 20 s). That rides out a burst of SSH channel
 * contention or a reconnect, both routine on a busy node, while a node that
 * really is unreachable still fails its chunk within a few minutes.
 */
const FINAL_READ_ATTEMPTS = 4
const FINAL_READ_BACKOFF_MS = 5_000

/**
 * The final download pass gives up only after this long with no byte landing
 * and no file finishing, across all of the chunk's transfers. Whatever is left
 * is then reported as lost and the chunk goes through requeue (only the
 * missing frames re-render), instead of the chunk — and the node it pins —
 * waiting on the network forever.
 *
 * It was an absolute ten minutes. A slow but healthy pass (large EXRs over a
 * thin link, a backlog built while the render outran it) was cut off
 * mid-flow, and frames still on the node were re-rendered, and paid for, till
 * the chunk ran out of retries (#242). Longer than a stall plus its retry
 * backoff, so one wedge-and-reset never trips it: a pass that lands nothing
 * at all for this long is on a node that is not delivering.
 */
export const DRAIN_IDLE_MS = 3 * DOWNLOAD_STALL_MS

/**
 * While the local disk will not take files, the final pass holds for up to
 * this long: its frames are safe on the node, and the node is kept. Then it
 * lets the node go (it bills all the while), reporting the frames as
 * `localSinkBlocked`, to render again once the disk takes files.
 */
export const SINK_HOLD_MS = 20 * 60_000

/** While the local disk is failing, try it again this often (probeSink). */
const SINK_PROBE_MS = 30_000

/**
 * drain() looks around every 250 ms. A gap between looks longer than this is
 * the machine having slept (a Mac's lid closed), not the node failing to
 * deliver: nothing could move meanwhile, so the idle clock starts again.
 * Counted as idle, a sleep past DRAIN_IDLE_MS gave up on every frame still
 * to fetch, a paid re-render, on the first look after waking, before any
 * transfer could reconnect. A hold on the local disk (SINK_HOLD_MS) does
 * count the sleep: that bounds what the node bills while frames cannot land,
 * and it billed all the while.
 */
const SUSPEND_GAP_MS = 30_000

/**
 * Once drain() has stopped its transfers, it waits this long at most for
 * them to wind down. An abort ends a transfer's network side at once, but
 * not a local step already under way (hashing, a rename, a truncate), which
 * on a project folder on a hung network share may never return, and the
 * node would be held for it. What is still running after this cannot write
 * rows (download() checks `stopped`) or share a .part (oneWriterAt).
 */
const SETTLE_WAIT_MS = 60_000

export interface ChunkDownloadTarget {
  jobId: string
  chunkId: string
  nodeId: string
  ssh: SshConnection
  /** e.g. /root/vastai/renders/<chunkId> */
  remoteChunkDir: string
  /** The frames this chunk renders: start..end, every `step`th. See isOurFrame. */
  frames: { start: number; end: number; step: number }
}

/** What the final download pass (drain) managed. */
export interface DrainResult {
  /**
   * Did the final manifest read succeed? When it did not, whatever the agent
   * listed after the last successful background poll was never seen at all,
   * so `lost` cannot name it: the chunk must not be taken as complete.
   */
  manifestRead: boolean
  /** Frames that were listed but could not be fetched. */
  lost: string[]
  /**
   * Frames the node has but the local disk would not take, for all of
   * SINK_HOLD_MS. Not lost from the node, and no fault of the render: they
   * need rendering again only because the node is let go.
   */
  localSinkBlocked: string[]
}

/** The local disk's trouble, while it lasts: see sinkFailed. */
interface SinkTrouble {
  reason: string
  since: number
  /** Where a write failed: probeSink tries this folder. */
  dir: string
  /** The most room a failed free-space check wanted, beyond the reserve. */
  needBytes: number
}

let sinkTrouble: SinkTrouble | null = null
let sinkProbe: NodeJS.Timeout | null = null
let probing = false

/** Downloaders that may be waiting on the local disk: woken when it recovers. */
const live = new Set<ChunkDownloader>()

/**
 * Is the local disk refusing downloads? Null while it takes them. Otherwise
 * why (for the user: "ENOSPC: no space left on device...") and since when.
 *
 * While it refuses (full, read-only, not ours to write, the drive gone),
 * every downloader pauses and its frames wait on their nodes. Nothing is
 * charged an attempt or counted lost: fetching again only fails the same
 * way, and a re-render would pay for frames that could not be kept either.
 * Once the disk takes files again, downloads resume by themselves. A refusal
 * of one file only, by a disk that takes others in the same folder (a frame
 * file another program holds, say), pauses nothing: see failed().
 *
 * The shape of FleetHolds.localSink: the scheduler should hold new dispatch
 * and scale-up while this is set, since every frame rendered meanwhile would
 * only wait on a node too.
 */
export function localSinkHold(): { reason: string; since: number } | null {
  const t = sinkTrouble
  return t ? { reason: t.reason, since: t.since } : null
}

/**
 * Check the local disk now rather than at the next probe, for a user who has
 * just freed space (fleet:releaseHold 'localSink'). Resolves true when it
 * takes files; downloads have then resumed. A disk still refusing keeps its
 * hold.
 */
export async function recheckLocalSink(): Promise<boolean> {
  await probeSink()
  return sinkTrouble === null
}

/** A download could not be written locally: pause them all, tell the user once. */
function sinkFailed(e: LocalSinkError, dir: string): void {
  const reason = describeError(e)
  const needBytes = e.needBytes ?? 0
  if (sinkTrouble) {
    sinkTrouble.reason = reason
    sinkTrouble.dir = dir
    sinkTrouble.needBytes = Math.max(sinkTrouble.needBytes, needBytes)
    return
  }
  sinkTrouble = { reason, since: Date.now(), dir, needBytes }
  emit('alert', {
    level: 'error',
    message:
      `Cannot save downloaded frames: ${reason}. Downloads are paused and the frames are kept on ` +
      'their nodes, which go on billing meanwhile. Free some space (or check the project folder) ' +
      'and downloads resume by themselves.'
  })
  sinkProbe = setInterval(() => void probeSink(), SINK_PROBE_MS)
  sinkProbe.unref?.()
}

/**
 * Is the disk taking files again? See sinkTakes. Only this clears the
 * trouble: a thumbnail that slips through proves nothing about the next EXR,
 * and clearing on it would flap the alert.
 */
async function probeSink(): Promise<void> {
  const trouble = sinkTrouble
  if (!trouble || probing) return
  probing = true
  try {
    if (!(await sinkTakes(trouble.dir, trouble.needBytes))) return
    if (sinkTrouble !== trouble) return
    sinkTrouble = null
    if (sinkProbe) clearInterval(sinkProbe)
    sinkProbe = null
    emit('alert', {
      level: 'info',
      message: 'The project disk is taking files again: downloads resumed.'
    })
    for (const d of [...live]) d.wake()
  } finally {
    probing = false
  }
}

/** Numbers each check's scratch file, so two checks at once never share one. */
let checkSeq = 0

/**
 * Does `dir` take files now: room for the reserve plus `needBytes`, and a
 * small write that lands? `dir` is the folder a failed file lands in, not the
 * job's: a frames/ folder that refuses writes while the job folder takes
 * them passed a check of the job folder every time, and the downloads it
 * woke failed again at once.
 */
async function sinkTakes(dir: string, needBytes: number): Promise<boolean> {
  const probe = join(dir, `.vastai-render-write-check-${++checkSeq}`)
  try {
    await fsp.mkdir(dir, { recursive: true })
    const st = await fsp.statfs(dir).catch(() => null)
    if (st && Number(st.bavail) * Number(st.bsize) < LOCAL_FREE_RESERVE_BYTES + needBytes) {
      return false
    }
    const fh = await fsp.open(probe, 'w')
    try {
      await fh.write(Buffer.alloc(4096))
    } finally {
      await fh.close().catch(() => {})
    }
    return true
  } catch {
    return false
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => {})
  }
}

/**
 * A job's local folder, where its files land: jobs.output_dir, fixed when the
 * job was submitted, under the project root of that moment (plan 1.13).
 *
 * It was worked out again from the current project root for every file. A
 * root changed in Settings mid-job sent the rest of a running job's frames
 * and previews to a second folder, while the job's own, the one "Open output
 * folder" opens, kept only what had landed before (#9 #61 #175 #202 #214).
 * A job with no row, which nothing should ask about, gets the folder the old
 * rule gave it.
 */
export function jobLocalDir(jobId: string): string {
  const row = getDb().prepare('SELECT output_dir FROM jobs WHERE id = ?').get(jobId) as
    { output_dir: string } | undefined
  return row?.output_dir ?? join(getSettings().projectRoot, 'renders', jobId)
}

export class ChunkDownloader {
  private seen = new Set<string>()
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  /** entries currently downloading (bounded by concurrency setting) */
  private inFlight = 0
  private previewsInFlight = 0
  private attempts = new Map<string, number>()
  private queue: ManifestEntry[] = []
  /**
   * Entries being transferred right now: how to stop each, and when its
   * handling (DB rows, alerts, the retry) is over. See stop() and drain().
   */
  private active = new Map<ManifestEntry, { abort: AbortController; settled: Promise<void> }>()
  /** entries waiting out a retry backoff (in neither queue nor active) */
  private retrying = new Set<ManifestEntry>()
  /** The last time a byte landed or a file finished, across every transfer here. */
  private lastProgressAt = Date.now()
  /** The last time a file finished: what ends a hold on the local disk (drain). */
  private lastLandedAt = 0
  /** The job's folder (jobLocalDir), read once: every file of the chunk lands in it. */
  private readonly jobDir: string

  constructor(private readonly target: ChunkDownloadTarget) {
    this.jobDir = jobLocalDir(target.jobId)
  }

  /** Frames this downloader gave up on permanently. See drain(). */
  private lostFrames = new Set<string>()

  /**
   * Files landed for frames saved one file per view (0042_L.png, 0042_R.png):
   * frame → view suffix → the file. See settleViewFrames.
   */
  private viewFrames = new Map<number, Map<string, { path: string; size: number }>>()

  /** Resolves when stop() is called; polls + downloads in the background. */
  start(): void {
    live.add(this)
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  /**
   * Stop polling, and stop the transfers in flight too: the chunk is no
   * longer this run's. A transfer left running once kept writing into a .part
   * that the requeued chunk's download of the same frame then shared (#243).
   *
   * Whatever the run had not landed leaves no partial behind in the job
   * folder, the user's delivery folder. Partials are named for their content
   * (#240), so the re-render's frame never resumes one and nothing else
   * would ever remove it. Each goes once its transfer, if any, has let go.
   */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    live.delete(this)
    const left = this.leftovers()
    for (const t of this.active.values()) t.abort.abort()
    for (const e of left) this.discardPartialOf(e)
  }

  /** Remove `entry`'s partial, in turn with any transfer of it (discardPartial). */
  private discardPartialOf(entry: ManifestEntry): void {
    const localPath = resolveInside(this.jobDir, entry.file)
    if (localPath) void discardPartial(localPath, entry)
  }

  /** The local disk takes files again: start what was waiting for it. */
  wake(): void {
    this.pump()
  }

  /**
   * One-shot: pull everything currently in the manifest, then report whether
   * that final read worked and which FRAMES could not be fetched at all.
   *
   * This is the last download pass — the caller settles the chunk and stops
   * the downloader immediately afterwards, so there is no later poll to pick
   * anything up. A silently dropped frame here is a hole in the render, so the
   * caller needs to know.
   *
   * The read is retried with backoff (FINAL_READ_ATTEMPTS). It used to be one
   * poll whose failure was swallowed: with the background polls already caught
   * up, the queue was empty, and a failed read looked exactly like "nothing
   * left to fetch" — the chunk completed without the frames the agent had
   * listed since the last good poll, and the node holding the only copy was
   * later scaled down. Even when every try fails, what is already in flight is
   * still waited for, so the requeue that follows re-renders as little as it can.
   *
   * Only frames count. A missing thumbnail or preview clip is cosmetic and is
   * not worth re-rendering a chunk over.
   *
   * After a final read that worked, it also marks the frames saved one file
   * per view whose views have all landed (settleViewFrames).
   *
   * The pass gives up on the node only after DRAIN_IDLE_MS with nothing
   * landing: a slow transfer that keeps moving is waited for, and time the
   * machine spent asleep does not count (SUSPEND_GAP_MS). While the local
   * disk will not take files, it holds instead (the frames are safe on the
   * node), for up to SINK_HOLD_MS from the first refusal until a file lands,
   * then reports them as `localSinkBlocked`. Either way it stops every
   * transfer it started and waits for them (SETTLE_WAIT_MS at most), so none
   * goes on writing files or rows after the caller has moved on.
   *
   * A downloader stopped mid-drain (its run was cancelled or its node went
   * away) starts no further read, but returns only once what it is waiting on
   * ends: a manifest read in flight (30 s at most), a retry backoff (20 s at
   * most), or an aborted transfer winding down (moments). The result is then
   * meaningless: the caller no longer owns the chunk and must not act on it.
   */
  async drain(idleMs = DRAIN_IDLE_MS): Promise<DrainResult> {
    // Stopped before the drain began (its run aborted meanwhile): stop() has
    // already let go of it, and nothing would ever remove it from `live`.
    if (!this.stopped) live.add(this)
    let manifestRead = false
    let gaveUp = false
    const blocked: string[] = []
    for (let attempt = 1; ; attempt++) {
      manifestRead = (await this.poll()).ok
      if (manifestRead || this.stopped || attempt >= FINAL_READ_ATTEMPTS) break
      await new Promise((r) => setTimeout(r, FINAL_READ_BACKOFF_MS * 2 ** (attempt - 1)))
    }
    this.lastProgressAt = Date.now()
    let heldSince: number | null = null
    let lookedAt = Date.now()
    while (
      !this.stopped &&
      (this.inFlight > 0 || this.queue.length > 0 || this.retrying.size > 0)
    ) {
      const now = Date.now()
      // Slept: see SUSPEND_GAP_MS.
      if (now - lookedAt > SUSPEND_GAP_MS) this.lastProgressAt = now
      lookedAt = now
      if (sinkTrouble) {
        // Waiting on the local disk, not on the node: the idle clock stands
        // still while the hold's runs. The hold is not restarted by the disk
        // clearing for a moment, only by a file landing. It was: a disk that
        // took the probe's write and refused the frames again straight after
        // began a fresh hold every 30 s, and the drain held its node, billing,
        // for good.
        if (heldSince === null || this.lastLandedAt > heldSince) heldSince = now
        this.lastProgressAt = now
        if (now - heldSince > SINK_HOLD_MS) {
          const left = this.leftovers()
          gaveUp = true
          this.stop()
          for (const e of left) if (e.kind === 'frame') blocked.push(e.file)
          emit('alert', {
            level: 'error',
            message:
              `chunk ${this.target.chunkId}: the project disk has taken no files for ` +
              `${Math.round(SINK_HOLD_MS / 60_000)} min, so its node is let go. ` +
              `${blocked.length} frame(s) will render again once the disk takes files.`
          })
          break
        }
      } else if (now - this.lastProgressAt > idleMs) {
        // Give up on whatever is left. Frames count as lost (the caller
        // re-renders them); previews do not matter enough to hold a node.
        const left = this.leftovers()
        gaveUp = true
        this.stop()
        for (const e of left) if (e.kind === 'frame') this.lostFrames.add(e.file)
        emit('alert', {
          level: 'warn',
          message: `chunk ${this.target.chunkId}: nothing downloaded for ${Math.round(idleMs / 60_000)} min — ${left.length} file(s) abandoned`
        })
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    // stop() aborted whatever was in flight; each winds down within moments.
    // The caller requeues next, and a transfer still running then would land
    // bytes and rows for a chunk that is no longer this run's (#243).
    let settleTimer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...this.active.values()].map((t) => t.settled)),
      new Promise((r) => (settleTimer = setTimeout(r, SETTLE_WAIT_MS)))
    ])
    clearTimeout(settleTimer)
    // Stopped by the caller, not by giving up: the chunk is no longer ours.
    if (manifestRead && (!this.stopped || gaveUp)) this.settleViewFrames()
    return { manifestRead, lost: [...this.lostFrames], localSinkBlocked: blocked }
  }

  /** Every entry not yet landed: queued, in flight, or waiting to retry. */
  private leftovers(): ManifestEntry[] {
    return [...this.queue, ...this.active.keys(), ...this.retrying]
  }

  /**
   * Mark downloaded the frames saved one file per view whose every view has
   * landed.
   *
   * These are not marked as each file lands, the way a one-file frame is.
   * Nothing says how many views a frame has, so its first view would read as
   * the whole frame, and a requeue after the other was lost, or never even
   * listed (a node that died, a final read that failed), would leave the
   * frame one view short for good. Here, after a final read that worked, a
   * frame's views are every suffix any frame of this chunk landed with. That
   * is at least two, since Blender adds a suffix only when there are two
   * views or more, so a lone suffix means the other view reached us for no
   * frame at all, and nothing is marked. A frame left unmarked renders again.
   */
  private settleViewFrames(): void {
    const views = new Set<string>()
    for (const landed of this.viewFrames.values()) for (const v of landed.keys()) views.add(v)
    if (views.size < 2) return
    const mark = getDb().prepare(
      `UPDATE frames SET state='downloaded', local_path=?, size_bytes=? WHERE job_id=? AND frame=?`
    )
    for (const [frame, landed] of this.viewFrames) {
      if (landed.size < views.size) continue
      // One file stands for the frame, as for any other: the first view's.
      const first = [...landed.keys()].sort()[0]
      const file = landed.get(first)!
      mark.run(file.path, file.size, this.target.jobId, frame)
    }
  }

  /**
   * Read the manifest and queue whatever is new. `ok` says whether the read
   * worked; the background polls ignore it (the next one retries anyway), but
   * drain() cannot.
   */
  private async poll(): Promise<{ ok: boolean }> {
    if (this.stopped) return { ok: false }
    let text: string
    try {
      // Timed out: drain() awaits this poll, and an exec on a wedged
      // connection otherwise never returns — which is one way a chunk used to
      // sit in 'downloading' forever.
      const r = await this.target.ssh.exec(
        `cat '${this.target.remoteChunkDir}/manifest.jsonl' 2>/dev/null`,
        { timeoutMs: MANIFEST_READ_TIMEOUT_MS, label: 'read manifest' }
      )
      // Exit 1 with nothing on stdout is cat's answer for a manifest the agent
      // has not written yet: nothing is listed, and that IS the manifest. A
      // chunk that failed before its first frame lands here, and must not sit
      // through drain()'s retries first. (cat says the same for a read error;
      // on a 'done' chunk the scheduler's check of the frames table catches
      // anything that was therefore never fetched.) Anything else non-zero,
      // including null — the channel closed under the command, which resolves
      // rather than throws — means the read did not happen, and whatever
      // stdout did arrive may be cut short.
      const missing = r.code === 1 && r.stdout === ''
      if (r.code !== 0 && !missing) return { ok: false }
      text = r.stdout
    } catch {
      return { ok: false } // connection down — reconnect logic lives with the node
    }
    const { entries, rejected } = parseManifest(text, this.target.chunkId)
    this.noteRejected(rejected)

    // Of all the live-clip versions in this read, only the newest is worth
    // fetching — earlier ones are superseded and the node prunes them, so
    // queuing them is a guaranteed 404 apiece. Mark them seen so they are
    // never reconsidered.
    let newestLive: string | null = null
    for (const e of entries) {
      if (e.kind === 'clip' && e.meta.kindKey === 'live') newestLive = e.file
    }

    for (const entry of entries) {
      if (this.seen.has(entry.file)) continue
      const superseded =
        entry.kind === 'clip' && entry.meta.kindKey === 'live' && entry.file !== newestLive
      this.seen.add(entry.file)
      if (superseded) continue
      if (!this.isOurFrame(entry)) continue
      this.queue.push(entry)
    }
    this.pump()
    return { ok: true }
  }

  /**
   * Is this entry for one of this chunk's frames? Clips always are. A frame or
   * thumbnail for any other frame is skipped: never fetched, and not lost.
   *
   * Frame files share the job's folder, and a frame's row is keyed by job and
   * frame number, so fetching another chunk's frame overwrote that chunk's
   * file and marked the frame downloaded, and nothing ever noticed. They do
   * not count as lost because such lines are routine: a requeue keeps the
   * chunk id for its first missing range, and a retry on the same node reads
   * a manifest that still lists the wider attempt's frames, each already
   * downloaded or now another chunk's to render.
   */
  private isOurFrame(entry: ManifestEntry): boolean {
    if (entry.kind === 'clip') return true
    const frame = parseFrameName(entry.file)?.frame
    // parseManifest passes no frame or thumb name without a number. Should one
    // ever get through, it is not this check's to judge: download() still
    // holds it to the job folder.
    if (frame == null) return true
    // Judged on the grid Blender renders, which is the agent's: noderunner
    // takes int() of the spec's frameStart, frameEnd and frameStep, and
    // Math.trunc is Python's int(). Every job since submissions were
    // validated has whole numbers there already. A job from before can carry
    // a fractional frame_step (the dialog accepted 2.5): its nodes render 1,
    // 3, 5…, and judged on 2.5 those frames were refused, never fetched,
    // though every one was paid for.
    const start = Math.trunc(this.target.frames.start)
    const end = Math.trunc(this.target.frames.end)
    const step = Math.trunc(this.target.frames.step || 1)
    return frame >= start && frame <= end && (frame - start) % step === 0
  }

  /**
   * Manifest lines that failed validation (manifest.ts); none of them is
   * fetched. A refused FRAME still counts as lost, or its frame would be a
   * hole nothing notices: counting it fails the final pass, and requeue()
   * re-renders whatever did not land. A stray line for a frame that did land
   * costs one trip through requeue(), which then finds nothing missing.
   *
   * One alert per chunk. The whole manifest is re-read every poll, so the same
   * bad line comes back every few seconds, and again on every attempt.
   */
  private noteRejected(rejected: ManifestReject[]): void {
    if (rejected.length === 0) return
    let frames = 0
    for (const r of rejected) {
      if (r.kind !== 'frame') continue
      frames++
      this.lostFrames.add(`refused ${r.file}`)
    }
    const { chunkId } = this.target
    if (rejectAlerted.has(chunkId)) return
    rejectAlerted.add(chunkId)
    const r = rejected[0]
    const n = rejected.length
    emit('alert', {
      level: 'error',
      message:
        `chunk ${chunkId}: refused ${n} manifest entr${n === 1 ? 'y' : 'ies'} from the node,` +
        ` e.g. ${r.kind} ${r.file} (${r.reason}). Nothing was downloaded for ${n === 1 ? 'it' : 'them'}` +
        `${frames > 0 ? ', and any frame still missing will re-render' : ''}.` +
        ' Further refusals from this chunk are not reported.'
    })
  }

  /**
   * Transfer order. A 30 KB thumbnail queued behind twenty 2.2 MB EXRs waits
   * ~12s at 30 Mbps, which defeats the entire point of a live preview — so
   * previews jump the queue. They are also capped (see pump) so frames keep
   * most of the concurrency: previews are nice, frames are the deliverable.
   */
  private classOf(entry: ManifestEntry): number {
    if (entry.kind === 'thumb') return 0
    if (entry.kind === 'clip') return entry.meta.kindKey === 'live' ? 1 : 2
    return 3
  }

  /** Previews may occupy at most this many of the concurrency budget. */
  private previewSlots(max: number): number {
    return Math.max(1, Math.min(1, max - 1))
  }

  private pump(): void {
    if (this.stopped) return
    // The local disk is not taking files: everything waits, on the node,
    // until probeSink finds it does again and wakes this.
    if (sinkTrouble) return
    const max = getSettings().concurrentTransfersPerNode
    while (this.inFlight < max && this.queue.length > 0) {
      // Lowest class first; ties keep manifest (i.e. frame) order.
      let pick = 0
      for (let i = 1; i < this.queue.length; i++) {
        if (this.classOf(this.queue[i]) < this.classOf(this.queue[pick])) pick = i
      }
      const isPreview = this.classOf(this.queue[pick]) < 2
      if (isPreview && this.previewsInFlight >= this.previewSlots(max)) {
        // Nothing else to start without starving frames — wait for a slot.
        const nonPreview = this.queue.findIndex((e) => this.classOf(e) >= 2)
        if (nonPreview < 0) break
        pick = nonPreview
      }
      const entry = this.queue.splice(pick, 1)[0]
      const preview = this.classOf(entry) < 2
      this.inFlight++
      if (preview) this.previewsInFlight++
      const abort = new AbortController()
      const settled = this.download(entry, abort.signal)
        .then(
          () => {
            this.lastProgressAt = this.lastLandedAt = Date.now()
          },
          (e: unknown) => this.failed(entry, e)
        )
        .finally(() => {
          this.inFlight--
          this.active.delete(entry)
          if (preview) this.previewsInFlight--
          this.pump()
        })
      this.active.set(entry, { abort, settled })
    }
  }

  /** A transfer failed: retry it, wait out the local disk, or give it up. */
  private failed(entry: ManifestEntry, e: unknown): void {
    // Stopped: the chunk is no longer this run's, and a drain that gave up
    // has already counted whatever was in flight.
    if (this.stopped) return
    if (e instanceof LocalSinkError) {
      this.sinkRefused(entry, e)
      return
    }
    // A file the node has already unlinked (a superseded live clip, or a
    // chunk dir torn down) is PERMANENT. The old code deleted it from `seen`
    // unconditionally, so it was re-queued every 5s poll forever, emitting
    // one warn each time. Told by ssh2's status code, not the message: a
    // local "no such file" (the project folder's drive gone) read as this
    // too, and re-rendered a frame the node still had.
    if (isRemoteMissing(e)) {
      // A frame that has vanished from the node can only be recovered by
      // re-rendering it, so it still counts as lost.
      if (entry.kind === 'frame') this.lostFrames.add(entry.file)
      emit('alert', {
        level: 'info',
        message: `skipping ${entry.file} — gone from the node`
      })
      return
    }
    // With its code: a dropped connection can fail a transfer with an empty
    // message, and the alert then said nothing after the colon (1.20).
    this.retryOrGiveUp(entry, describeError(e))
  }

  /**
   * The local disk refused a file. Not the node's fault, nor the network's:
   * the file is safe on the node. It was charged attempts, counted lost after
   * four, and re-rendered on a paid GPU (B6).
   *
   * If the disk will not take files in that folder at all (sinkTakes, asked
   * right away), fetching again only fails the same way until it is fixed:
   * the file waits in the queue, charged nothing, and every downloader
   * pauses. If it takes them, the refusal is this file's own (a frame file
   * another program holds, one the user may not overwrite), so it is charged
   * an attempt like any other failure, and MAX_ATTEMPTS bounds it. Taken as
   * the disk's, such a file paused everything, the probe found the disk fine
   * 30 s later, the file failed again, and so on: a final pass waiting on it
   * never ended while its node billed.
   */
  private sinkRefused(entry: ManifestEntry, e: LocalSinkError): void {
    const localPath = resolveInside(this.jobDir, entry.file)
    const dir = localPath ? dirname(localPath) : this.jobDir
    if (sinkTrouble) {
      // Already paused: the probe decides when it is tried again.
      this.queue.unshift(entry)
      sinkFailed(e, dir)
      return
    }
    // In `retrying` meanwhile, so drain() waits for the verdict.
    this.retrying.add(entry)
    void sinkTakes(dir, e.needBytes ?? 0).then((takes) => {
      this.retrying.delete(entry)
      if (this.stopped) return
      if (takes) {
        this.retryOrGiveUp(entry, `the project folder would not take it: ${describeError(e)}`)
        return
      }
      this.queue.unshift(entry)
      sinkFailed(e, dir)
    })
  }

  /** A failure to charge: retry after a backoff, or give up after MAX_ATTEMPTS. */
  private retryOrGiveUp(entry: ManifestEntry, message: string): void {
    const attempts = (this.attempts.get(entry.file) ?? 0) + 1
    this.attempts.set(entry.file, attempts)
    if (attempts >= MAX_ATTEMPTS) {
      if (entry.kind === 'frame') this.lostFrames.add(entry.file)
      emit('alert', {
        level: 'warn',
        message: `giving up on ${entry.file} after ${attempts} attempts: ${message}`
      })
      // Its partial would stay in the job folder, the user's delivery folder.
      this.discardPartialOf(entry)
      return
    }
    // Transient — retry after a short backoff (a stalled transfer resumes
    // from its .part). Re-queue directly rather than only clearing `seen` for
    // the next poll: during drain() there IS no next poll (it polls once,
    // then waits for the queue to empty and the caller stops the
    // downloader), so a poll-only retry silently lost the file. `retrying`
    // keeps drain() waiting through the backoff.
    this.retrying.add(entry)
    setTimeout(() => {
      this.retrying.delete(entry)
      if (this.stopped) {
        if (entry.kind === 'frame') this.lostFrames.add(entry.file)
        return
      }
      this.queue.push(entry)
      this.pump()
    }, RETRY_BACKOFF_MS * attempts)
    emit('alert', {
      level: 'warn',
      message: `download failed (${entry.file}, attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`
    })
  }

  private async download(entry: ManifestEntry, signal: AbortSignal): Promise<void> {
    const { jobId, chunkId, ssh, remoteChunkDir } = this.target
    const remotePath = `${remoteChunkDir}/${entry.file}`
    // Frame numbers are globally unique within a job, and preview clips are
    // chunk-labelled — chunks can safely share the job's local tree.
    //
    // `file` is the node's word, so it only ever lands inside the job folder.
    // parseManifest already holds it to the names the agent writes; this is
    // the backstop that still holds if those patterns are ever loosened.
    const localPath = resolveInside(this.jobDir, entry.file)
    if (!localPath) {
      this.noteRejected([manifestReject(entry.kind, entry.file, 'outside the job folder')])
      return
    }
    await downloadFileVerified(ssh, remotePath, localPath, entry, {
      signal,
      onProgress: () => {
        this.lastProgressAt = Date.now()
      }
    })
    // Stopped while it ran (a cancel, the node gone, a drain that gave up):
    // the rows are no longer this run's to write, and a requeue may already
    // be re-rendering the frame.
    if (this.stopped) return

    const db = getDb()
    if (entry.kind === 'frame') {
      const name = parseFrameName(entry.file)
      const frame = name?.frame ?? null
      if (name && name.view === '') {
        db.prepare(
          `UPDATE frames SET state='downloaded', local_path=?, size_bytes=? WHERE job_id=? AND frame=?`
        ).run(localPath, entry.size, jobId, name.frame)
      } else if (name) {
        // One view of several: the frame is marked by settleViewFrames.
        const landed = this.viewFrames.get(name.frame) ?? new Map()
        landed.set(name.view, { path: localPath, size: entry.size })
        this.viewFrames.set(name.frame, landed)
      }
      db.prepare(
        `INSERT OR IGNORE INTO assets (job_id, chunk_id, kind, abs_path, created_at) VALUES (?, ?, 'frame', ?, ?)`
      ).run(jobId, chunkId, localPath, Date.now())
      emit('asset:added', { jobId, chunkId, kind: 'frame', frame, path: localPath })
    } else if (entry.kind === 'thumb') {
      // Keyed on the FRAME, never the chunk: requeue() re-points only
      // not-yet-downloaded rows, so a downloaded frame keeps its old chunk id
      // while the narrowed chunk's range moves off it.
      //
      // Deliberately NOT an `assets` row: that would be ~2000 rows per job in
      // a table assets:index scans whole, for something the frames table
      // already has a row for.
      const frame = entry.meta.frame ?? parseFrameName(entry.file)?.frame ?? null
      if (frame != null) {
        db.prepare(`UPDATE frames SET thumb_path=? WHERE job_id=? AND frame=?`).run(
          localPath,
          jobId,
          frame
        )
      }
      emit('asset:added', {
        jobId,
        chunkId,
        kind: 'thumb',
        frame,
        path: localPath,
        mediaUrl: jobFileMediaUrl(jobId, this.jobDir, localPath)
      })
    } else {
      const m = entry.meta
      // A live clip that arrives when the definitive renditions are already
      // here is dead on arrival. This has to be checked BEFORE inserting,
      // not cleaned up afterwards: the two are queued in the same poll and
      // run concurrently, so `previewSdr` finishing first would drop live
      // rows that do not exist yet, and this row would then never be removed.
      if (m.kindKey === 'live' && this.hasDefinitiveClip(chunkId)) {
        unlinkLater([localPath], 0, this.jobDir)
        return
      }
      db.prepare(
        `INSERT OR REPLACE INTO assets (job_id, chunk_id, kind, abs_path, fps, frames, width, height, codec, hdr, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        chunkId,
        m.kindKey,
        localPath,
        m.fps,
        m.frames,
        m.width,
        m.height,
        m.codec,
        m.hdr ? 1 : 0,
        Date.now()
      )
      emit('asset:added', {
        jobId,
        chunkId,
        kind: m.kindKey,
        path: localPath,
        mediaUrl: jobFileMediaUrl(jobId, this.jobDir, localPath)
      })
      if (m.kindKey === 'live') this.pruneLiveVersions(chunkId, localPath)
      // A definitive rendition supersedes the live clip entirely.
      else if (CLIP_KINDS_FINAL.includes(m.kindKey)) this.dropLiveClips(chunkId)
    }
  }

  /**
   * Drop superseded local live clips.
   *
   * Order matters: DB rows first, then the event, then the files. A renderer
   * holding the old `media://` URL keeps playing until it re-reads the asset
   * index, so unlinking first would 404 mid-playback.
   */
  private pruneLiveVersions(chunkId: string, keepPath: string): void {
    const stale = getDb()
      .prepare(`SELECT abs_path FROM assets WHERE chunk_id = ? AND kind = 'live' AND abs_path != ?`)
      .all(chunkId, keepPath) as Array<{ abs_path: string }>
    if (stale.length === 0) return
    getDb()
      .prepare(`DELETE FROM assets WHERE chunk_id = ? AND kind = 'live' AND abs_path != ?`)
      .run(chunkId, keepPath)
    unlinkLater(
      stale.map((s) => s.abs_path),
      undefined,
      this.jobDir
    )
  }

  /** True once any final rendition for this chunk has landed. */
  private hasDefinitiveClip(chunkId: string): boolean {
    const marks = CLIP_KINDS_FINAL.map(() => '?').join(',')
    const row = getDb()
      .prepare(`SELECT 1 FROM assets WHERE chunk_id = ? AND kind IN (${marks}) LIMIT 1`)
      .get(chunkId, ...CLIP_KINDS_FINAL)
    return !!row
  }

  private dropLiveClips(chunkId: string): void {
    const rows = getDb()
      .prepare(`SELECT abs_path FROM assets WHERE chunk_id = ? AND kind = 'live'`)
      .all(chunkId) as Array<{ abs_path: string }>
    if (rows.length === 0) return
    getDb().prepare(`DELETE FROM assets WHERE chunk_id = ? AND kind = 'live'`).run(chunkId)
    unlinkLater(
      rows.map((r) => r.abs_path),
      undefined,
      this.jobDir
    )
  }
}

/** Definitive renditions — their arrival retires the live clip. */
const CLIP_KINDS_FINAL: string[] = ['previewSdr', 'previewHdr', 'proxy']

/** Chunks that have already raised their refused-entry alert. See noteRejected. */
const rejectAlerted = new Set<string>()

/**
 * Delete after a grace period, so a renderer still holding the old URL has
 * time to swap to the new one rather than losing its source mid-frame.
 *
 * Only ever inside `root`: the job's own folder (jobLocalDir), as the
 * downloader and the job clip builder pass it, or else the current project's
 * renders folder. The paths come from assets rows, which were built from
 * node-supplied names, and a row written before those names were validated
 * could point anywhere. Held to the current root, a running job's
 * superseded live clips were never removed once the root had changed: its
 * folder was no longer inside it (plan 1.13).
 */
export function unlinkLater(
  paths: string[],
  delayMs = 30_000,
  root = join(getSettings().projectRoot, 'renders')
): void {
  const safe = paths.filter((p) => {
    if (isInside(root, p)) return true
    console.warn(`[download] not deleting ${JSON.stringify(p)}: not inside ${root}`)
    return false
  })
  if (safe.length === 0) return
  setTimeout(() => {
    for (const p of safe) {
      rm(p, { force: true }).catch(() => {})
    }
  }, delayMs).unref?.()
}
