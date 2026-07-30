/**
 * Grade state: module-level store + useSyncExternalStore, persisted to
 * localStorage. Pure renderer presentation state — deliberately not in
 * electron-store (no main-process reader, keep IPC out of the hot path).
 */

import { useSyncExternalStore } from 'react'
import { DEFAULT_GRADE, GRADE_PRESETS, resolvePreset, type Grade } from './grade'

// v1 deliberately survives Grade gaining the shader-only tier: every new field
// has an identity default, so spreading a stored v1 object over DEFAULT_GRADE
// reproduces exactly the picture it described. Bump only if a field's MEANING
// changes — bumping now would silently discard real user grades.
const LS_KEY = 'vr:grade:v1'

let grade: Grade = readInitial()
const listeners = new Set<() => void>()

function readInitial(): Grade {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_GRADE
    const merged = { ...DEFAULT_GRADE, ...(JSON.parse(raw) as Partial<Grade>) }
    // A NaN reaching uniform1f blanks the canvas with no error and no warning.
    for (const k of Object.keys(DEFAULT_GRADE) as Array<keyof Grade>) {
      if (!Number.isFinite(merged[k])) merged[k] = DEFAULT_GRADE[k]
    }
    return merged
  } catch {
    // fall through
  }
  return DEFAULT_GRADE
}

export function getGrade(): Grade {
  return grade
}

export function setGrade(patch: Partial<Grade>): void {
  grade = { ...grade, ...patch }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(grade))
  } catch {
    // best-effort persistence
  }
  for (const fn of listeners) fn()
}

/**
 * Presets are partial, so they must be RESOLVED to a full Grade before being
 * set — setGrade() merges, and a partial preset would otherwise inherit
 * whatever shader-only values happened to be left over from the last look.
 */
export function applyGradePreset(name: keyof typeof GRADE_PRESETS): void {
  if (GRADE_PRESETS[name]) setGrade(resolvePreset(name))
}

export function useGrade(): Grade {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => grade
  )
}
