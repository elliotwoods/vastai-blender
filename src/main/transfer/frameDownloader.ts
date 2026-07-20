/**
 * Manifest-driven incremental download: polls a chunk's manifest.jsonl on the
 * node every few seconds, pulls new entries (frames + preview clips) with
 * hash verification, records them in the DB, and emits asset events. Never
 * lists remote directories — partially-written files are invisible until the
 * agent manifests them.
 */

import { join } from 'path'
import { getDb } from '../db/db'
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { downloadFileVerified } from '../ssh/sftp'
import type { SshConnection } from '../ssh/sshConnection'
import { parseManifest, type ManifestEntry } from './manifest'

const POLL_MS = 5_000

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
  private queue: ManifestEntry[] = []

  constructor(private readonly target: ChunkDownloadTarget) {}

  /** Resolves when stop() is called; polls + downloads in the background. */
  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /** One-shot: pull everything currently in the manifest, then return. */
  async drain(): Promise<void> {
    await this.poll()
    while (this.inFlight > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 250))
    }
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
    for (const entry of parseManifest(text)) {
      if (this.seen.has(entry.file)) continue
      this.seen.add(entry.file)
      this.queue.push(entry)
    }
    this.pump()
  }

  private pump(): void {
    const max = getSettings().concurrentTransfersPerNode
    while (this.inFlight < max && this.queue.length > 0) {
      const entry = this.queue.shift()!
      this.inFlight++
      void this.download(entry)
        .catch((e) => {
          // Re-queue once on failure; hash mismatches will retry next poll too.
          this.seen.delete(entry.file)
          emit('alert', {
            level: 'warn',
            message: `download failed (${entry.file}): ${(e as Error).message}`
          })
        })
        .finally(() => {
          this.inFlight--
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
      emit('asset:added', { jobId, kind: 'frame', path: localPath })
    } else {
      const m = entry.meta
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
      emit('asset:added', { jobId, kind: m.kindKey, path: localPath })
    }
  }
}

function frameNumberFromName(file: string): number | null {
  const m = /(\d+)\.\w+$/.exec(file)
  return m ? parseInt(m[1], 10) : null
}
