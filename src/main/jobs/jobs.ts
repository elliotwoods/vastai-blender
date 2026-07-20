/** Job persistence + read models (the scheduler owns state transitions). */

import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { basename, join } from 'path'
import { resolveJobBlenderVersion } from '../blender/blendInfo'
import { getDb } from '../db/db'
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { autoChunkSize, framesIn, splitFrames } from '../scheduler/chunker'
import type {
  ChunkSnapshot,
  ChunkState,
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
    blenderVersion: r.blender_version
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
    retries: r.retries
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
    addonIds: JSON.parse(row.addon_ids) as string[]
  }
}

export function emitJobChanged(jobId: string): void {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined
  if (row) emit('job:changed', rowToSummary(row))
}

/** Create job + chunks + frame rows; returns the job id. */
export async function createJob(sub: JobSubmission): Promise<string> {
  const settings = getSettings()
  const id = randomUUID()
  const name = sub.name || basename(sub.blendPath).replace(/\.blend$/i, '')
  const outputDir = join(settings.projectRoot, 'renders', id)
  mkdirSync(join(outputDir, 'frames'), { recursive: true })
  mkdirSync(join(outputDir, 'previews'), { recursive: true })

  const blenderVersion = await resolveJobBlenderVersion(
    sub.blendPath,
    settings.blenderVersionOverride
  )

  const totalFrames = Math.floor((sub.frameEnd - sub.frameStart) / sub.frameStep) + 1
  const chunkSize = sub.chunkSize ?? autoChunkSize(totalFrames, settings.maxActiveNodes)
  const ranges = splitFrames(sub.frameStart, sub.frameEnd, sub.frameStep, chunkSize)

  const db = getDb()
  const insertAll = db.transaction(() => {
    db.prepare(
      `INSERT INTO jobs (id, name, blend_path, engine, frame_start, frame_end, frame_step,
                         state, blender_version, addon_ids, chunk_size, output_dir, cost_so_far, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?)`
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
      Date.now()
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
  insertAll()
  emitJobChanged(id)
  return id
}

/** Recompute a job's state from its chunks; emits on change. */
export function refreshJobState(jobId: string): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined
  if (!row || row.state === 'cancelled') return
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
  if (state !== row.state) {
    db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(state, jobId)
  }
  emitJobChanged(jobId)
}
