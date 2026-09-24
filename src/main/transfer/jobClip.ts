/**
 * Job clips: a job's chunk preview clips stitched end to end into one clip per
 * rendition, so a job plays and scrubs as a whole however finely it was
 * chunked. A 525-frame job split into 2-frame chunks is otherwise 262 clips,
 * each of which ends before you can see it move.
 *
 * Every chunk clip of a job comes out of the same on-node encode (All-Intra,
 * same fps and size — remote/encode/encode_preview.py), so stitching is a
 * lossless `ffmpeg -f concat -c copy`: no re-encode, well under a second for
 * hundreds of frames. Chunks that aren't complete yet are simply gaps; the
 * clip's `segments` say which job frames it holds, in clip order.
 *
 * Rebuilt (debounced) as chunks complete. Each rebuild writes a NEW versioned
 * file and retires the previous one only after the new row is in place, so a
 * <video> playing the old version is never pulled out from under itself.
 */

import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { getDb } from '../db/db'
import { emit } from '../events'
import { ffmpegPath, runFfmpeg } from '../media/ffmpeg'
import { toMediaUrl } from '../mediaUrl'
import { isInside } from '../paths'
import { jobLocalDir, unlinkLater } from './frameDownloader'
import { concatList, nextVersionName, planSegments, type SegmentPlan } from './jobClipPlan'

/** Renditions that get a job clip. `live` is per-chunk progress, never stitched. */
export const JOB_CLIP_KINDS = ['previewSdr', 'previewHdr', 'proxy'] as const
type JobClipKind = (typeof JOB_CLIP_KINDS)[number]

/** Quiet period after a chunk completes before rebuilding. */
const DEBOUNCE_MS = 20_000
/** Once the job is finished there's nothing to batch up — build promptly. */
const FINAL_DELAY_MS = 1_000

interface JobClipRow {
  abs_path: string
  segments: string | null
}

class JobClipBuilder {
  private timers = new Map<string, NodeJS.Timeout>()
  /** One build at a time across all jobs — they're cheap, but disk-bound. */
  private chain: Promise<void> = Promise.resolve()
  private unavailableLogged = false

  /**
   * A chunk of this job completed. Debounced so a wide fleet finishing a chunk
   * every few seconds costs one rebuild per quiet period, not one per chunk;
   * a finished job is built promptly.
   */
  schedule(jobId: string): void {
    const job = getDb().prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as
      { state: string } | undefined
    if (!job) return
    const final = job.state === 'complete' || job.state === 'partial'
    const existing = this.timers.get(jobId)
    // Don't reset a pending debounce on every completion, or a steady stream
    // of chunks would starve the rebuild until the job ends.
    if (existing && !final) return
    if (existing) clearTimeout(existing)
    const t = setTimeout(
      () => {
        this.timers.delete(jobId)
        this.chain = this.chain.then(() =>
          this.build(jobId).catch((e) =>
            console.warn(`[jobClip] ${jobId.slice(0, 8)}: ${(e as Error).message}`)
          )
        )
      },
      final ? FINAL_DELAY_MS : DEBOUNCE_MS
    )
    t.unref?.()
    this.timers.set(jobId, t)
  }

  /**
   * At startup: queue every job that has stitchable clips. build() is a no-op
   * for jobs whose job clip already covers everything, so this is cheap.
   */
  catchUp(): void {
    const rows = getDb()
      .prepare(
        `SELECT DISTINCT a.job_id FROM assets a JOIN jobs j ON j.id = a.job_id
          WHERE a.chunk_id IS NOT NULL AND a.kind IN ('previewSdr','previewHdr','proxy')
            AND j.state != 'cancelled'`
      )
      .all() as Array<{ job_id: string }>
    for (const r of rows) this.schedule(r.job_id)
  }

  private async build(jobId: string): Promise<void> {
    const bin = await ffmpegPath()
    if (!bin) {
      if (!this.unavailableLogged) {
        console.warn('[jobClip] no ffmpeg available — job clips disabled')
        this.unavailableLogged = true
      }
      return
    }
    const db = getDb()
    const job = db.prepare('SELECT frame_step FROM jobs WHERE id = ?').get(jobId) as
      { frame_step: number } | undefined
    if (!job) return
    const chunks = (
      db
        .prepare(
          `SELECT id, frame_start, frame_end FROM chunks WHERE job_id = ? AND state = 'complete'`
        )
        .all(jobId) as Array<{ id: string; frame_start: number; frame_end: number }>
    ).map((c) => ({ id: c.id, frameStart: c.frame_start, frameEnd: c.frame_end }))
    if (chunks.length < 2) return

    // Chunk clip paths were built from node-supplied names, and ffmpeg reads
    // them with `-safe 0`: only clips inside this job's folder go in.
    const jobDir = jobLocalDir(jobId)
    for (const kind of JOB_CLIP_KINDS) {
      const clips = (
        db
          .prepare(
            `SELECT chunk_id, abs_path, fps, frames, width, height, codec, hdr FROM assets
              WHERE job_id = ? AND kind = ? AND chunk_id IS NOT NULL`
          )
          .all(jobId, kind) as Array<{
          chunk_id: string
          abs_path: string
          fps: number | null
          frames: number | null
          width: number | null
          height: number | null
          codec: string | null
          hdr: number
        }>
      )
        .filter((r) => isInside(jobDir, r.abs_path))
        .map((r) => ({ ...r, chunkId: r.chunk_id, absPath: r.abs_path }))
      const plan = planSegments(chunks, clips, job.frame_step)
      // One chunk's worth is just that chunk's clip — nothing to stitch.
      if (!plan || plan.files.length < 2) continue
      await this.write(jobId, kind, plan, bin)
    }
  }

  private async write(
    jobId: string,
    kind: JobClipKind,
    plan: SegmentPlan,
    bin: string
  ): Promise<void> {
    const db = getDb()
    const prev = db
      .prepare(
        `SELECT abs_path, segments FROM assets WHERE job_id = ? AND kind = ? AND chunk_id IS NULL`
      )
      .all(jobId, kind) as JobClipRow[]
    const segJson = JSON.stringify(plan.segments)
    if (prev.length === 1 && prev[0].segments === segJson) return

    // The job's own previews folder, never one derived from a clip's path.
    const outDir = join(jobLocalDir(jobId), 'previews')
    await mkdir(outDir, { recursive: true })
    const outPath = join(outDir, nextVersionName(kind, prev[0]?.abs_path ?? null))
    const partPath = `${outPath}.part`
    const listPath = join(tmpdir(), `vr-${jobId.slice(0, 8)}-${kind}-${Date.now()}.txt`)
    await writeFile(listPath, concatList(plan.files), 'utf-8')
    try {
      await runFfmpeg(bin, [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        // Chromium/Safari want HEVC tagged hvc1 in MP4; the chunk clips are,
        // but the mp4 muxer defaults a remux to hev1.
        ...(plan.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        partPath
      ])
      await rename(partPath, outPath)
    } catch (e) {
      await rm(partPath, { force: true }).catch(() => {})
      throw e
    } finally {
      await rm(listPath, { force: true }).catch(() => {})
    }

    // Row first, then the event, then (after a grace period) the old file —
    // the same order the live-clip pruning uses in frameDownloader.
    db.transaction(() => {
      db.prepare(`DELETE FROM assets WHERE job_id = ? AND kind = ? AND chunk_id IS NULL`).run(
        jobId,
        kind
      )
      db.prepare(
        `INSERT OR REPLACE INTO assets (job_id, chunk_id, kind, abs_path, fps, frames, width, height, codec, hdr, created_at, segments)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        kind,
        outPath,
        plan.fps,
        plan.frames,
        plan.width,
        plan.height,
        plan.codec,
        plan.hdr ? 1 : 0,
        Date.now(),
        segJson
      )
    })()
    emit('asset:added', { jobId, chunkId: '', kind, path: outPath, mediaUrl: toMediaUrl(outPath) })
    unlinkLater(prev.map((p) => p.abs_path).filter((p) => p !== outPath))
    console.log(
      `[jobClip] ${jobId.slice(0, 8)} ${kind}: ${plan.files.length} clips → ${basename(outPath)} (${plan.frames} frames)`
    )
  }
}

export const jobClips = new JobClipBuilder()
