/**
 * Manifest-driven incremental download: polls a chunk's manifest.jsonl on the
 * node every few seconds, pulls new entries (frames + preview clips) with
 * hash verification, records them in the DB, and emits asset events. Never
 * lists remote directories — partially-written files are invisible until the
 * agent manifests them.
 */

import { rm } from 'fs/promises'
import { join } from 'path'
import { getDb } from '../db/db'
import { emit } from '../events'
import { toMediaUrl } from '../mediaUrl'
import { isInside, resolveInside } from '../paths'
import { getSettings } from '../settings'
import { downloadFileVerified } from '../ssh/sftp'
import type { SshConnection } from '../ssh/sshConnection'
import { parseFrameName, parseManifest, type ManifestEntry, type ManifestReject } from './manifest'

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
 * Upper bound on the final download pass. Each transfer already has a stall
 * timeout and a retry budget, so this is a backstop: whatever has not landed
 * by then is reported as lost and the chunk goes through requeue (only the
 * missing frames re-render), instead of the chunk — and the node it pins —
 * waiting on the network forever.
 */
export const DRAIN_BUDGET_MS = 10 * 60_000

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
}

/** Local landing dir for a job: <projectRoot>/renders/<jobId>/ */
export function jobLocalDir(jobId: string): string {
  return join(getSettings().projectRoot, 'renders', jobId)
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
  /** entries being transferred right now */
  private active = new Set<ManifestEntry>()
  /** entries waiting out a retry backoff (in neither queue nor active) */
  private retrying = new Set<ManifestEntry>()

  constructor(private readonly target: ChunkDownloadTarget) {}

  /** Frames this downloader gave up on permanently. See drain(). */
  private lostFrames = new Set<string>()

  /**
   * Files landed for frames saved one file per view (0042_L.png, 0042_R.png):
   * frame → view suffix → the file. See settleViewFrames.
   */
  private viewFrames = new Map<number, Map<string, { path: string; size: number }>>()

  /** Resolves when stop() is called; polls + downloads in the background. */
  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
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
   * A downloader stopped mid-drain (its run was cancelled or its node went
   * away) returns at once, and the result is meaningless: the caller no longer
   * owns the chunk and must not act on it.
   */
  async drain(budgetMs = DRAIN_BUDGET_MS): Promise<DrainResult> {
    const deadline = Date.now() + budgetMs
    let manifestRead = false
    let timedOut = false
    for (let attempt = 1; ; attempt++) {
      manifestRead = (await this.poll()).ok
      if (manifestRead || this.stopped || attempt >= FINAL_READ_ATTEMPTS) break
      const backoff = FINAL_READ_BACKOFF_MS * 2 ** (attempt - 1)
      if (Date.now() + backoff > deadline) break
      await new Promise((r) => setTimeout(r, backoff))
    }
    while (
      !this.stopped &&
      (this.inFlight > 0 || this.queue.length > 0 || this.retrying.size > 0)
    ) {
      if (Date.now() > deadline) {
        // Give up on whatever is left. Frames count as lost (the caller
        // re-renders them); previews do not matter enough to hold a node.
        const left = [...this.queue, ...this.active, ...this.retrying]
        timedOut = true
        this.stop()
        for (const e of left) if (e.kind === 'frame') this.lostFrames.add(e.file)
        emit('alert', {
          level: 'warn',
          message: `chunk ${this.target.chunkId}: download pass timed out after ${Math.round(budgetMs / 60_000)} min — ${left.length} file(s) abandoned`
        })
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    // Stopped by the caller, not by the deadline: the chunk is no longer ours.
    if (manifestRead && (!this.stopped || timedOut)) this.settleViewFrames()
    return { manifestRead, lost: [...this.lostFrames] }
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
        { timeoutMs: MANIFEST_READ_TIMEOUT_MS }
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
    const { start, end, step } = this.target.frames
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
      this.active.add(entry)
      void this.download(entry)
        .catch((e) => {
          const message = (e as Error).message
          // A file the node has already unlinked (a superseded live clip, or
          // a chunk dir torn down) is PERMANENT. The old code deleted it from
          // `seen` unconditionally, so it was re-queued every 5s poll forever,
          // emitting one warn each time.
          if (/no such file|NO_SUCH_FILE|ENOENT/i.test(message)) {
            // A frame that has vanished from the node can only be recovered by
            // re-rendering it, so it still counts as lost.
            if (entry.kind === 'frame') this.lostFrames.add(entry.file)
            emit('alert', {
              level: 'info',
              message: `skipping ${entry.file} — gone from the node`
            })
            return
          }
          const attempts = (this.attempts.get(entry.file) ?? 0) + 1
          this.attempts.set(entry.file, attempts)
          if (attempts >= MAX_ATTEMPTS) {
            if (entry.kind === 'frame') this.lostFrames.add(entry.file)
            emit('alert', {
              level: 'warn',
              message: `giving up on ${entry.file} after ${attempts} attempts: ${message}`
            })
            return
          }
          // Transient — retry after a short backoff (a stalled transfer
          // resumes from its .part). Re-queue directly rather than only
          // clearing `seen` for the next poll: during drain() there IS no next
          // poll (it polls once, then waits for the queue to empty and the
          // caller stops the downloader), so a poll-only retry silently lost
          // the file. `retrying` keeps drain() waiting through the backoff.
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
        })
        .finally(() => {
          this.inFlight--
          this.active.delete(entry)
          if (preview) this.previewsInFlight--
          this.pump()
        })
    }
  }

  private async download(entry: ManifestEntry): Promise<void> {
    const { jobId, chunkId, ssh, remoteChunkDir } = this.target
    const remotePath = `${remoteChunkDir}/${entry.file}`
    // Frame numbers are globally unique within a job, and preview clips are
    // chunk-labelled — chunks can safely share the job's local tree.
    //
    // `file` is the node's word, so it only ever lands inside the job folder.
    // parseManifest already holds it to the names the agent writes; this is
    // the backstop that still holds if those patterns are ever loosened.
    const localPath = resolveInside(jobLocalDir(jobId), entry.file)
    if (!localPath) {
      this.noteRejected([
        { kind: entry.kind, file: JSON.stringify(entry.file), reason: 'outside the job folder' }
      ])
      return
    }
    await downloadFileVerified(ssh, remotePath, localPath, entry)

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
        mediaUrl: toMediaUrl(localPath)
      })
    } else {
      const m = entry.meta
      // A live clip that arrives when the definitive renditions are already
      // here is dead on arrival. This has to be checked BEFORE inserting,
      // not cleaned up afterwards: the two are queued in the same poll and
      // run concurrently, so `previewSdr` finishing first would drop live
      // rows that do not exist yet, and this row would then never be removed.
      if (m.kindKey === 'live' && this.hasDefinitiveClip(chunkId)) {
        unlinkLater([localPath], 0)
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
        mediaUrl: toMediaUrl(localPath)
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
    unlinkLater(stale.map((s) => s.abs_path))
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
    unlinkLater(rows.map((r) => r.abs_path))
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
 * Only ever inside the project's renders folder. The paths come from assets
 * rows, which were built from node-supplied names, and a row written before
 * those names were validated could point anywhere.
 */
export function unlinkLater(paths: string[], delayMs = 30_000): void {
  const root = join(getSettings().projectRoot, 'renders')
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
