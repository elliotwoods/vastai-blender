/**
 * Grade state: module-level store + useSyncExternalStore, persisted to
 * localStorage. Pure renderer presentation state — deliberately not in
 * electron-store (no main-process reader, keep IPC out of the hot path).
 */

import { useSyncExternalStore } from 'react'
import { DEFAULT_GRADE, GRADE_PRESETS, type Grade } from './grade'

const LS_KEY = 'vr:grade:v1'

let grade: Grade = readInitial()
const listeners = new Set<() => void>()

function readInitial(): Grade {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return { ...DEFAULT_GRADE, ...(JSON.parse(raw) as Partial<Grade>) }
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

export function applyGradePreset(name: keyof typeof GRADE_PRESETS): void {
  const preset = GRADE_PRESETS[name]
  if (preset) setGrade(preset)
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
