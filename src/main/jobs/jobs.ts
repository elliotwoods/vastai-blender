/** Job persistence + read models (the scheduler owns state transitions). */

import { randomUUID } from 'crypto'
import { constants, mkdirSync, promises as fsp, statSync, type Stats } from 'fs'
import { basename, join } from 'path'
import { resolveJobBlenderVersion } from '../blender/blendInfo'
import { getDb } from '../db/db'
import { describeError } from '../errors'
import { emit } from '../events'
import { getSettings } from '../settings'
import { sha256File } from '../ssh/sftp'
import { autoChunkSize, framesIn, splitFrames } from '../scheduler/chunker'
import { validateSubmission } from '../../shared/jobValidation'
import type {
  ChunkSnapshot,
  ChunkState,
  ErrorClass,
  JobAttention,
  JobAttentionKind,
  JobDetail,
  JobState,
  JobSubmission,
  JobSummary
} from '../../shared/models'

interface JobRow {
  id: string
  name: string
  blend_path: string
  engine: 'eevee' | 'cycles' | 'octane'
  frame_start: number
  frame_end: number
  frame_step: number
  state: JobState
  blender_version: string | null
  addon_ids: string
  chunk_size: number | null
  output_dir: string
  cost_so_far: number
  submitted_at: number
  share_node: number
  /** hex SHA-256 of the snapshot; null = submitted before plan 1.12 */
  blend_sha256: string | null
  /** absolute path of the snapshot (SCENE_SNAPSHOT in output_dir); null as above */
  scene_path: string | null
  /** JSON JobAttention, or null (plans 1.16, 1.17) */
  attention: string | null
}

interface ChunkRow {
  id: string
  job_id: string
  frame_start: number
  frame_end: number
  state: ChunkState
  node_id: string | null
  frames_done: number
  retries: number
  infra_retries: number
  not_before: number | null
  error_kind: string | null
}

const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>([
  'transient',
  'machine',
  'account',
  'job',
  'localFs'
])

const ATTENTION_KINDS: ReadonlySet<string> = new Set<JobAttentionKind>([
  'scene',
  'repeatedFailure',
  'engine',
  'extension'
])

/**
 * jobs.attention as the renderer reads it. The scheduler writes JobAttention
 * as JSON; anything else in the column is shown as written, so a hand-edited
 * or older value still reaches the user rather than vanishing.
 */
export function parseAttention(raw: string | null): JobAttention | null {
  if (raw == null || raw.trim() === '') return null
  try {
    const v = JSON.parse(raw) as Partial<JobAttention>
    if (v && typeof v.message === 'string' && ATTENTION_KINDS.has(String(v.kind))) {
      return {
        kind: v.kind as JobAttentionKind,
        message: v.message,
        since: typeof v.since === 'number' ? v.since : 0,
        ...(v.errorClass && ERROR_CLASSES.has(v.errorClass) ? { errorClass: v.errorClass } : {})
      }
    }
  } catch {
    // not JSON: shown as written, below
  }
  return { kind: 'repeatedFailure', message: raw, since: 0 }
}

/**
 * Why each chunk's last attempt failed, for ChunkSnapshot.lastError. Held in
 * memory: chunks has no column for it yet, only error_kind for its class, so
 * after a restart a chunk shows the class of its last failure and not the
 * words. The alert that reported it carried them too.
 */
const lastErrors = new Map<string, string>()

/** Record (or with null, forget) why a chunk's last attempt failed. */
export function noteChunkError(chunkId: string, reason: string | null): void {
  if (reason == null) lastErrors.delete(chunkId)
  else lastErrors.set(chunkId, reason)
}

function rowToSummary(r: JobRow): JobSummary {
  const db = getDb()
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM frames WHERE job_id = ?').get(r.id) as { n: number }
  ).n
  const done = (
    db
      .prepare("SELECT COUNT(*) AS n FROM frames WHERE job_id = ? AND state = 'downloaded'")
      .get(r.id) as { n: number }
  ).n
  return {
    id: r.id,
    name: r.name,
    blendPath: r.blend_path,
    engine: r.engine,
    frameStart: r.frame_start,
    frameEnd: r.frame_end,
    frameStep: r.frame_step,
    state: r.state,
    framesDone: done,
    framesTotal: total,
    costSoFar: r.cost_so_far,
    submittedAt: r.submitted_at,
    outputDir: r.output_dir,
    blenderVersion: r.blender_version,
    shareNode: r.share_node === 1,
    attention: parseAttention(r.attention),
    blendSha256: r.blend_sha256
  }
}

function rowToChunk(r: ChunkRow): ChunkSnapshot {
  return {
    id: r.id,
    jobId: r.job_id,
    frameStart: r.frame_start,
    frameEnd: r.frame_end,
    state: r.state,
    nodeId: r.node_id,
    framesDone: r.frames_done,
    retries: r.retries,
    infraRetries: r.infra_retries,
    notBefore: r.not_before,
    errorClass:
      r.error_kind != null && ERROR_CLASSES.has(r.error_kind) ? (r.error_kind as ErrorClass) : null,
    lastError: lastErrors.get(r.id) ?? null
  }
}

export function listJobs(): JobSummary[] {
  const rows = getDb().prepare('SELECT * FROM jobs ORDER BY submitted_at DESC').all() as JobRow[]
  return rows.map(rowToSummary)
}

export function getJob(id: string): JobDetail | null {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
  if (!row) return null
  const chunks = getDb()
    .prepare('SELECT * FROM chunks WHERE job_id = ? ORDER BY frame_start')
    .all(id) as ChunkRow[]
  return {
    ...rowToSummary(row),
    chunks: chunks.map(rowToChunk),
    addonIds: JSON.parse(row.addon_ids) as string[],
    sceneChanged: sceneChangedNow(row)
  }
}

export function emitJobChanged(jobId: string): void {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined
  if (row) emit('job:changed', rowToSummary(row))
}

/**
 * Announce a chunk's lifecycle change, re-reading the row so the payload is
 * whatever actually landed rather than what the caller believed it wrote.
 *
 * Every chunk state write must go through here. They are in scheduler.ts
 * (dispatch, the render/encode/download transitions, finish, the re-split
 * shared by requeue and restart recovery, completing a chunk with nothing left
 * to render, failing a job, cancel) and index.ts (the VR_JOB_SPEC revive), and
 * the re-split in particular INSERTs brand-new `-rN` rows mid-render — a
 * consumer that only heard about ChunkRun's own writes would keep showing
 * requeued chunks as live and never learn the retry ids exist.
 */
export function emitChunkChanged(chunkId: string): void {
  const row = getDb()
    .prepare('SELECT id, job_id, node_id, state FROM chunks WHERE id = ?')
    .get(chunkId) as
    { id: string; job_id: string; node_id: string | null; state: ChunkState } | undefined
  if (!row) return
  emit('chunk:changed', {
    chunkId: row.id,
    jobId: row.job_id,
    nodeId: row.node_id,
    state: row.state
  })
}

/** Bulk variant for the statements that touch many rows at once. */
export function emitChunksChanged(chunkIds: readonly string[]): void {
  for (const id of chunkIds) emitChunkChanged(id)
}

/** The job's copy of its scene, in its output folder (plan 1.12). */
export const SCENE_SNAPSHOT = 'scene.blend'

/**
 * Copy the scene into the job's folder as SCENE_SNAPSHOT, and hash the copy:
 * every chunk of the job renders it, so a save over the original mid-render
 * cannot change what the rest of the frames are rendered from (#53 #148).
 *
 * A clone where the file system makes them (APFS, ReFS, Btrfs), which is
 * instant and takes no room until one of the two files changes; a plain copy
 * elsewhere. The copy is what is hashed, never the original, which may be
 * saved over at any moment.
 *
 * The copy keeps the original's modification time, whatever the platform's
 * copy did with it: that is what sceneDiffers compares a later save against.
 * Only if the folder takes it. One that will not still gets the job, and the
 * copy's own time, when it was made, is then the mark, which only a later
 * save of the original passes.
 */
async function snapshotScene(
  src: string,
  outputDir: string
): Promise<{ path: string; sha256: string }> {
  const path = join(outputDir, SCENE_SNAPSHOT)
  const before = await fsp.stat(src)
  await fsp.copyFile(src, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  await fsp.utimes(path, before.atime, before.mtime).catch(() => {})
  return { path, sha256: await sha256File(path) }
}

/**
 * How far past the snapshot's modification time the original's may be and
 * still be the save that was copied. File systems keep times to different
 * resolutions (FAT's two seconds is the coarsest a scene is likely to be on),
 * and utimes sets them to the millisecond.
 */
const MTIME_SLACK_MS = 2_000

/**
 * Has the scene at `original` changed since it was copied to `snapshot`?
 * Judged by size and modification time, never by reading either file (a
 * multi-GB scene, perhaps on a network volume), so a save that changed
 * nothing reads as a change too. True for an original that is gone. Null
 * when it cannot be told: the snapshot is unreadable, or the original's
 * folder will not say.
 *
 * Newer rather than different: a snapshot whose times could not be set
 * carries the moment it was made, which no earlier save of the original is
 * past.
 */
async function sceneDiffers(original: string, snapshot: string): Promise<boolean | null> {
  let copy: Stats
  try {
    copy = await fsp.stat(snapshot)
  } catch {
    return null
  }
  let now: Stats
  try {
    now = await fsp.stat(original)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? true : null
  }
  return now.size !== copy.size || now.mtimeMs - copy.mtimeMs > MTIME_SLACK_MS
}

/**
 * Has job `jobId`'s scene changed since it was submitted (plan 1.12)? Looks
 * at both files now. Null for a job with no snapshot, submitted before
 * snapshots, which renders `blend_path` as it is, and when it cannot be told.
 */
export async function checkSceneChanged(jobId: string): Promise<boolean | null> {
  const row = getDb()
    .prepare('SELECT blend_path, blend_sha256, scene_path FROM jobs WHERE id = ?')
    .get(jobId) as Pick<JobRow, 'blend_path' | 'blend_sha256' | 'scene_path'> | undefined
  if (!row?.blend_sha256 || !row.scene_path) return null
  return sceneDiffers(row.blend_path, row.scene_path)
}

/** How long getJob shows a sceneChanged verdict before it looks at the files again. */
const SCENE_RECHECK_MS = 5_000

/** Per job: the last sceneChanged verdict, when it was reached, and whether a look is under way. */
const sceneChecks = new Map<string, { changed: boolean | null; at: number; running: boolean }>()

/**
 * getJob's sceneChanged: the last verdict, with a fresh look started once it
 * is SCENE_RECHECK_MS old. getJob answers at once and runs on every
 * job:changed while the job is open, and a stat of a scene on a network
 * volume that has gone away can take minutes, holding the main process with
 * it. So it never waits for one: a verdict that changes is announced with
 * job:changed, and the renderer asks again.
 */
function sceneChangedNow(r: JobRow): boolean | null {
  if (!r.blend_sha256 || !r.scene_path) return null
  const known = sceneChecks.get(r.id)
  if (!known || (!known.running && Date.now() - known.at >= SCENE_RECHECK_MS)) {
    void recheckScene(r.id, r.blend_path, r.scene_path)
  }
  return known?.changed ?? null
}

async function recheckScene(jobId: string, original: string, snapshot: string): Promise<void> {
  const entry = sceneChecks.get(jobId) ?? { changed: null, at: 0, running: false }
  sceneChecks.set(jobId, entry)
  entry.running = true
  const changed = await sceneDiffers(original, snapshot)
  entry.running = false
  entry.at = Date.now()
  if (changed === entry.changed) return
  entry.changed = changed
  emitJobChanged(jobId)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Create job + chunks + frame rows; returns the job id.
 *
 * Refuses an impossible submission before touching the disk or the DB. Both
 * ways in — job:create from the dialog and the VR_JOB_SPEC campaign driver —
 * land here, so this is where the rules hold. A chunk size of 0 used to reach
 * splitFrames and spin the main process until it ran out of memory: no IPC,
 * no scheduler tick, no idle scale-down, while the fleet kept billing.
 */
export async function createJob(sub: JobSubmission): Promise<string> {
  const problems = validateSubmission(sub)
  // Only main can see the disk. With a blenderVersionOverride set nothing
  // below reads the scene, so a missing one would first surface at dispatch,
  // failing chunk after chunk on a rented node.
  if (problems.length === 0 && !isFile(sub.blendPath)) {
    problems.push(`scene file not found: ${sub.blendPath}`)
  }
  if (problems.length) throw new Error(problems.join('; '))

  const settings = getSettings()
  const id = randomUUID()
  const name = sub.name || basename(sub.blendPath).replace(/\.blend$/i, '')
  const outputDir = join(settings.projectRoot, 'renders', id)

  const blenderVersion = await resolveJobBlenderVersion(
    sub.blendPath,
    settings.blenderVersionOverride
  )

  const totalFrames = Math.floor((sub.frameEnd - sub.frameStart) / sub.frameStep) + 1
  const chunkSize = sub.chunkSize ?? autoChunkSize(totalFrames, settings.maxActiveNodes)
  const ranges = splitFrames(sub.frameStart, sub.frameEnd, sub.frameStep, chunkSize)

  // After everything above that can refuse the job, so a refusal leaves no
  // empty renders/<id> folder behind.
  mkdirSync(join(outputDir, 'frames'), { recursive: true })
  mkdirSync(join(outputDir, 'previews'), { recursive: true })

  // The scene as submitted, which every chunk renders (plan 1.12). Taken
  // before the job exists, so a scene that cannot be copied (the project
  // folder full, the original unreadable) is a refusal, and leaves no folder.
  let scene: { path: string; sha256: string }
  try {
    scene = await snapshotScene(sub.blendPath, outputDir)
  } catch (e) {
    await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`could not copy the scene into the job's folder: ${describeError(e)}`)
  }

  const db = getDb()
  const insertAll = db.transaction(() => {
    db.prepare(
      `INSERT INTO jobs (id, name, blend_path, engine, frame_start, frame_end, frame_step,
                         state, blender_version, addon_ids, chunk_size, output_dir, cost_so_far, submitted_at,
                         share_node, blend_sha256, scene_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      sub.blendPath,
      sub.engine,
      sub.frameStart,
      sub.frameEnd,
      sub.frameStep,
      blenderVersion,
      JSON.stringify(sub.addonIds),
      sub.chunkSize,
      outputDir,
      Date.now(),
      sub.shareNode ? 1 : 0,
      scene.sha256,
      scene.path
    )
    const insChunk = db.prepare(
      `INSERT INTO chunks (id, job_id, frame_start, frame_end, state, frames_done, retries)
       VALUES (?, ?, ?, ?, 'pending', 0, 0)`
    )
    const insFrame = db.prepare(
      `INSERT INTO frames (job_id, frame, chunk_id, state) VALUES (?, ?, ?, 'pending')`
    )
    for (const range of ranges) {
      const chunkId = `${id.slice(0, 8)}-${range.start}-${range.end}`
      insChunk.run(chunkId, id, range.start, range.end)
      for (const f of framesIn(range, sub.frameStep)) insFrame.run(id, f, chunkId)
    }
  })
  try {
    insertAll()
  } catch (e) {
    // No job to render it: the copy of a large scene is not left behind.
    await fsp.rm(outputDir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  emitJobChanged(id)
  return id
}

/**
 * Toggle whether a job's chunks may share a node.
 *
 * Applies to future assignments only — chunks already dispatched keep the
 * placement they were given, because moving a render mid-flight would throw
 * away its progress. Turning sharing OFF therefore takes effect as the
 * currently co-running chunks finish.
 */
export function setJobShareNode(jobId: string, shareNode: boolean): void {
  getDb()
    .prepare('UPDATE jobs SET share_node = ? WHERE id = ?')
    .run(shareNode ? 1 : 0, jobId)
  emitJobChanged(jobId)
}

/** Frames of a job that have not landed on the local disk. */
function undownloadedFrameCount(jobId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM frames WHERE job_id = ? AND state != 'downloaded'")
      .get(jobId) as { n: number }
  ).n
}

/**
 * Recompute a job's state from its chunks, and announce the job.
 *
 * Always announces, a cancelled or failed job included. Both states are
 * final, so there is nothing to recompute, but the call still means something
 * about it changed. Returning before the emit meant a cancel itself was never
 * announced: the Jobs list kept showing the job as running.
 *
 * 'failed' is the scheduler's verdict that no node can render the job as it
 * stands (a scene the preflight refused, an engine no node has; plan 1.16),
 * with the reason in jobs.attention. Its chunks still in flight when that
 * came settle afterwards, and recomputing from them would turn the job back
 * into 'running' or 'partial' and hide the reason behind a state that says
 * nothing is wrong.
 */
export function refreshJobState(jobId: string): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined
  if (!row) return
  if (row.state === 'cancelled' || row.state === 'failed') {
    emitJobChanged(jobId)
    return
  }
  const chunks = db
    .prepare('SELECT state, COUNT(*) AS n FROM chunks WHERE job_id = ? GROUP BY state')
    .all(jobId) as Array<{ state: ChunkState; n: number }>
  const count = (s: ChunkState): number => chunks.find((c) => c.state === s)?.n ?? 0
  const total = chunks.reduce((a, c) => a + c.n, 0)
  let state: JobState
  if (count('complete') === total) state = 'complete'
  else if (count('failed') > 0 && count('complete') + count('failed') === total) state = 'partial'
  else if (count('pending') === total) state = 'queued'
  else state = 'running'
  // Complete means every frame is on disk, not just that every chunk says so.
  // The scheduler already holds each chunk to that before completing it; this
  // is the backstop for any other way a chunk reaches 'complete'. Every chunk
  // finished with frames still missing is a job with holes: 'partial', not a
  // 'complete' the user only finds out about when assembling the sequence.
  if (state === 'complete' && undownloadedFrameCount(jobId) > 0) state = 'partial'
  if (state !== row.state) {
    db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(state, jobId)
  }
  emitJobChanged(jobId)
}
