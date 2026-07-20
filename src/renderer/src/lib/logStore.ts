/**
 * Ring buffer for live render:logLine events — renderer-local (Query is the
 * wrong tool for append streams). Keyed by nodeId; capped per node.
 */

import { create } from 'zustand'
import type { LogLineEvent } from '../../../shared/models'

const MAX_LINES = 5000

interface LogState {
  byNode: Record<string, LogLineEvent[]>
  append: (e: LogLineEvent) => void
  clear: (nodeId?: string) => void
}

export const useLogStore = create<LogState>((set) => ({
  byNode: {},
  append: (e) =>
    set((s) => {
      const existing = s.byNode[e.nodeId] ?? []
      const next = existing.length >= MAX_LINES ? existing.slice(-MAX_LINES + 1) : existing.slice()
      next.push(e)
      return { byNode: { ...s.byNode, [e.nodeId]: next } }
    }),
  clear: (nodeId) =>
    set((s) => {
      if (!nodeId) return { byNode: {} }
      const rest = { ...s.byNode }
      delete rest[nodeId]
      return { byNode: rest }
    })
}))
