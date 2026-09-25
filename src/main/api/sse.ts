/**
 * GET /v1/events: the main-process event bus (events.ts) as server-sent
 * events. Each event is
 *
 *   event: job:changed
 *   data: {...the payload, as the renderer gets it...}
 *
 * and a `: ping` comment line every 15 s keeps proxies and idle sockets from
 * closing the stream. `?channels=job:changed,alert` picks channels; without
 * it every channel but the high-rate ones is sent. chunk:progress (several
 * a second per rendering chunk) and render:logLine (every line Blender
 * prints) are sent only when asked for by name.
 */

import type { IncomingMessage, ServerResponse } from 'http'
import type { EventChannel } from '../../shared/ipc'
import type { BusEvent } from '../events'

/** Every bus channel, and whether it is sent when no channels are asked for. */
export const EVENT_CHANNELS: Record<EventChannel, { byDefault: boolean }> = {
  'node:changed': { byDefault: true },
  'job:changed': { byDefault: true },
  'chunk:changed': { byDefault: true },
  'asset:added': { byDefault: true },
  'fleet:cost': { byDefault: true },
  alert: { byDefault: true },
  'chunk:progress': { byDefault: false },
  'render:logLine': { byDefault: false }
}

export const PING_MS = 15_000

/**
 * The channels `param` (a comma-separated list, or null for the default)
 * names. Throws an Error naming an unknown channel.
 */
export function parseChannels(param: string | null): Set<EventChannel> {
  const all = Object.keys(EVENT_CHANNELS) as EventChannel[]
  if (param === null || param.trim() === '') {
    return new Set(all.filter((c) => EVENT_CHANNELS[c].byDefault))
  }
  const out = new Set<EventChannel>()
  for (const raw of param.split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (!(all as string[]).includes(name)) {
      throw new Error(`unknown channel ${JSON.stringify(name)}; known: ${all.join(', ')}`)
    }
    out.add(name as EventChannel)
  }
  return out
}

/** One event as SSE lines. JSON has no raw newlines, so one data line holds it. */
export function formatEvent(event: BusEvent): string {
  return `event: ${event.channel}\ndata: ${JSON.stringify(event.payload)}\n\n`
}

export interface EventStreamOptions {
  channels: ReadonlySet<EventChannel>
  /** events.ts's onEvent: subscribe, returning the unsubscribe. */
  subscribe(listener: (event: BusEvent) => void): () => void
  pingMs?: number
}

/**
 * Answer `req` with an event stream until the client goes away (or the
 * server closes it). Returns the function that ends it.
 */
export function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: EventStreamOptions
): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff'
  })
  // Said at once, so a client knows the stream is open before any event.
  res.write(`: connected; channels ${[...opts.channels].join(',')}\n\n`)
  let closed = false
  const unsubscribe = opts.subscribe((event) => {
    if (closed || !opts.channels.has(event.channel)) return
    try {
      res.write(formatEvent(event))
    } catch {
      end()
    }
  })
  const ping = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, opts.pingMs ?? PING_MS)
  ping.unref?.()
  function end(): void {
    if (closed) return
    closed = true
    clearInterval(ping)
    unsubscribe()
    res.end()
  }
  req.on('close', end)
  req.on('error', end)
  res.on('error', end)
  return end
}
