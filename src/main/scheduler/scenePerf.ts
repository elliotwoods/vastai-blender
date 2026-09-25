/**
 * Where a scene's render time goes, per GPU model.
 *
 * The agent's render driver (remote/blender/render_driver.py) times each
 * frame's phases, and the agent sums them into its state's `timings`: the
 * load (Blender's launch to the scene loaded and every script run), then per
 * frame the render depsgraph, Cycles' sync and BVH build, the sampling, and
 * the save. Only the sampling keeps the GPU busy, so this is what says how
 * much of a paid GPU-hour a scene leaves idle, and in which phase. The
 * agent's VRAM watch (state `vram`) says how much of the card one render of
 * the scene takes, which is what decides whether a second one fits beside it.
 *
 * Kept per scene snapshot (jobs.blend_sha256) and GPU model in scene_perf.
 */

import { getDb } from '../db/db'
import type { SceneRenderTimes } from '../../shared/models'

/** noderunner.py's state "timings"; see its header. */
export interface AgentTimings {
  loadS: number | null
  frames: number
  evalS: number
  syncS: number
  sampleS: number
  saveS: number
}

/** noderunner.py's state "vram"; see its header. */
export interface AgentVram {
  peakMb: number | null
  gpu: number | null
  cardBaseMb: number | null
  cardPeakMb: number | null
}

type Phase = 'evalS' | 'syncS' | 'sampleS' | 'saveS'

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * The GPU memory one render used, MB, or null when it cannot be told.
 *
 * nvidia-smi's figure for the render's own pid when it listed it. Inside a
 * container it often lists none, and then a render pinned to a card that it
 * had to itself (`aloneOnCard`) used what the card gained while it ran; with
 * another render on the card, that growth is both of theirs.
 */
export function renderVramMb(
  vram: AgentVram | null | undefined,
  aloneOnCard: boolean
): number | null {
  if (!vram) return null
  const own = num(vram.peakMb)
  if (own != null && own > 0) return Math.round(own)
  const base = num(vram.cardBaseMb)
  const peak = num(vram.cardPeakMb)
  if (aloneOnCard && vram.gpu != null && base != null && peak != null && peak > base) {
    return Math.round(peak - base)
  }
  return null
}

/**
 * Add one chunk's timings and VRAM to the scene's row for this GPU model.
 * A chunk the driver did not time adds only its VRAM, and one with neither
 * adds nothing.
 */
export function recordScenePerf(
  sceneSha: string,
  gpuName: string,
  timings: AgentTimings | null | undefined,
  vramMb: number | null
): void {
  const loadS = num(timings?.loadS)
  const frames =
    timings && Number.isInteger(timings.frames) && timings.frames > 0 ? timings.frames : 0
  if (loadS == null && frames === 0 && vramMb == null) return
  const phase = (k: Phase): number => (frames > 0 ? (num(timings?.[k]) ?? 0) : 0)
  getDb()
    .prepare(
      `INSERT INTO scene_perf
         (scene_sha, gpu_name, loads, load_s, frames, eval_s, sync_s, sample_s, save_s,
          peak_vram_mb, updated_at)
       VALUES (@sha, @gpu, @loads, @loadS, @frames, @evalS, @syncS, @sampleS, @saveS, @vram, @now)
       ON CONFLICT (scene_sha, gpu_name) DO UPDATE SET
         loads = loads + @loads,
         load_s = load_s + @loadS,
         frames = frames + @frames,
         eval_s = eval_s + @evalS,
         sync_s = sync_s + @syncS,
         sample_s = sample_s + @sampleS,
         save_s = save_s + @saveS,
         peak_vram_mb = CASE
           WHEN @vram IS NULL THEN peak_vram_mb
           WHEN peak_vram_mb IS NULL OR @vram > peak_vram_mb THEN @vram
           ELSE peak_vram_mb END,
         updated_at = @now`
    )
    .run({
      sha: sceneSha,
      gpu: gpuName,
      loads: loadS == null ? 0 : 1,
      loadS: loadS ?? 0,
      frames,
      evalS: phase('evalS'),
      syncS: phase('syncS'),
      sampleS: phase('sampleS'),
      saveS: phase('saveS'),
      vram: vramMb,
      now: Date.now()
    })
}

interface ScenePerfRow {
  gpu_name: string
  loads: number
  load_s: number
  frames: number
  eval_s: number
  sync_s: number
  sample_s: number
  save_s: number
  peak_vram_mb: number | null
  updated_at: number
}

function toTimes(r: ScenePerfRow): SceneRenderTimes {
  const mean = (sum: number): number | null => (r.frames > 0 ? sum / r.frames : null)
  return {
    gpuName: r.gpu_name,
    loadS: r.loads > 0 ? r.load_s / r.loads : null,
    loads: r.loads,
    frames: r.frames,
    evalS: mean(r.eval_s),
    syncS: mean(r.sync_s),
    sampleS: mean(r.sample_s),
    saveS: mean(r.save_s),
    peakVramMb: r.peak_vram_mb,
    updatedAt: r.updated_at
  }
}

/** Every GPU model's times for one scene, the most recently updated first. */
export function sceneRenderTimes(sceneSha: string): SceneRenderTimes[] {
  const rows = getDb()
    .prepare('SELECT * FROM scene_perf WHERE scene_sha = ? ORDER BY updated_at DESC')
    .all(sceneSha) as ScenePerfRow[]
  return rows.map(toTimes)
}

/** One scene's times on one GPU model, or null when it never rendered there. */
export function sceneRenderTimesOn(sceneSha: string, gpuName: string): SceneRenderTimes | null {
  const row = getDb()
    .prepare('SELECT * FROM scene_perf WHERE scene_sha = ? AND gpu_name = ?')
    .get(sceneSha, gpuName) as ScenePerfRow | undefined
  return row ? toTimes(row) : null
}
