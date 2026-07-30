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
import { emit } from '../ipc'
import { toMediaUrl } from '../mediaUrl'
import { getSettings } from '../settings'
import { downloadFileVerified } from '../ssh/sftp'
import type { SshConnection } from '../ssh/sshConnection'
import { parseManifest, type ManifestEntry } from './manifest'

const POLL_MS = 5_000

/** Transient-failure budget per file before we stop re-queuing it. */
const MAX_ATTEMPTS = 4

export interface ChunkDownloadTarget {
  jobId: string
  chunkId: string
  nodeId: string
  ssh: SshConnection
  /** e.g. /root/vastai/renders/<chunkId> */
  remoteChunkDir: string
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

  constructor(private readonly target: ChunkDownloadTarget) {}

  /** Frames this downloader gave up on permanently. See drain(). */
  private lostFrames = new Set<string>()

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
   * One-shot: pull everything currently in the manifest, then return the
   * FRAMES that could not be fetched at all.
   *
   * This is the last download pass — the caller marks the chunk complete and
   * stops the downloader immediately afterwards, so there is no later poll to
   * pick anything up. A silently dropped frame here means a hole in the render
   * that nothing else detects (job completion is decided from chunk states, and
   * `job:retryMissing` is a stub), so the caller needs to know.
   *
   * Only frames count. A missing thumbnail or preview clip is cosmetic and is
   * not worth re-rendering a chunk over.
   */
  async drain(): Promise<string[]> {
    await this.poll()
    while (this.inFlight > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 250))
    }
    return [...this.lostFrames]
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    let text: string
    try {
      const r = await this.target.ssh.exec(
        `cat '${this.target.remoteChunkDir}/manifest.jsonl' 2>/dev/null`
      )
      text = r.stdout
    } catch {
      return // connection down — reconnect logic lives with the node
    }
    const entries = parseManifest(text)

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
      this.queue.push(entry)
    }
    this.pump()
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
          // Transient — retry. Re-queue directly rather than only clearing
          // `seen` for the next poll: during drain() there IS no next poll (it
          // polls once, then waits for the queue to empty and the caller stops
          // the downloader), so a poll-only retry silently lost the file.
          this.seen.delete(entry.file)
          this.queue.push(entry)
          emit('alert', { level: 'warn', message: `download failed (${entry.file}): ${message}` })
        })
        .finally(() => {
          this.inFlight--
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
    const localPath = join(jobLocalDir(jobId), entry.file)
    await downloadFileVerified(ssh, remotePath, localPath, entry)

    const db = getDb()
    if (entry.kind === 'frame') {
      const frame = frameNumberFromName(entry.file)
      if (frame != null) {
        db.prepare(
          `UPDATE frames SET state='downloaded', local_path=?, size_bytes=? WHERE job_id=? AND frame=?`
        ).run(localPath, entry.size, jobId, frame)
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
      const frame = entry.meta.frame ?? frameNumberFromName(entry.file)
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

/**
 * Delete after a grace period, so a renderer still holding the old URL has
 * time to swap to the new one rather than losing its source mid-frame.
 */
function unlinkLater(paths: string[], delayMs = 30_000): void {
  setTimeout(() => {
    for (const p of paths) {
      rm(p, { force: true }).catch(() => {})
    }
  }, delayMs).unref?.()
}

function frameNumberFromName(file: string): number | null {
  const m = /(\d+)\.\w+$/.exec(file)
  return m ? parseInt(m[1], 10) : null
}
