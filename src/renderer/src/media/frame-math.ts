/**
 * Pure frame ↔ time math for All-Intra clip scrubbing. Seeks target the
 * CENTER of a frame's display interval — seeking to the exact boundary can
 * land on the previous frame due to floating-point rounding in the decoder.
 */

export function frameToTime(frame: number, fps: number): number {
  return (frame + 0.5) / fps
}

export function timeToFrame(t: number, fps: number, totalFrames: number): number {
  return Math.min(totalFrames - 1, Math.max(0, Math.floor(t * fps + 1e-6)))
}

export function clampFrame(frame: number, totalFrames: number): number {
  return Math.min(totalFrames - 1, Math.max(0, Math.round(frame)))
}

/** MM:SS:FF timecode (FF = frame within second). */
export function formatTimecode(frame: number, fps: number): string {
  const fpsInt = Math.max(1, Math.round(fps))
  const totalSeconds = Math.floor(frame / fpsInt)
  const ff = frame % fpsInt
  const mm = Math.floor(totalSeconds / 60)
  const ss = totalSeconds % 60
  const p = (n: number): string => n.toString().padStart(2, '0')
  return `${p(mm)}:${p(ss)}:${p(ff)}`
}

/** Normalised phase [0, 1) of a frame within a clip. */
export function frameToPhase(frame: number, totalFrames: number): number {
  if (totalFrames <= 0) return 0
  return Math.min(0.9999, Math.max(0, frame / totalFrames))
}

export function phaseToFrame(phase: number, totalFrames: number): number {
  return clampFrame(Math.floor(phase * totalFrames + 1e-6), totalFrames)
}
