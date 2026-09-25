import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChunkSnapshot } from '../../../shared/models'

// The strip's chip, rendered on the server with the IPC bridge stubbed
// (window.api, which a test has no window for), as fleetScreen.test.tsx does.
// A server render never runs the ResizeObserver, so the row lays out at
// `initialWidth`.
vi.mock('../lib/ipc', () => ({
  ipc: { invoke: vi.fn(() => new Promise(() => {})), on: vi.fn(() => () => {}) }
}))

const { ZoomFilmstrip } = await import('./ZoomFilmstrip')

function render(el: React.JSX.Element): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(<QueryClientProvider client={client}>{el}</QueryClientProvider>)
}

function chip(html: string): { sampled: string; text: string } {
  const m = html.match(/data-testid="zoom-chip" data-sampled="(\w+)"[^>]*>([^<]*)</)
  expect(m).not.toBeNull()
  return { sampled: m![1], text: m![2].replace(/&#x27;/g, "'") }
}

const chunk = (p: Partial<ChunkSnapshot>): ChunkSnapshot => ({
  id: 'c',
  jobId: 'j',
  frameStart: 1,
  frameEnd: 10,
  state: 'pending',
  nodeId: null,
  framesDone: 0,
  retries: 0,
  ...p
})

describe('ZoomFilmstrip chip', () => {
  it('says "all frames" when every frame in view fits', () => {
    const html = render(
      <ZoomFilmstrip jobId="j" frameStart={1} frameEnd={12} frameStep={1} initialWidth={960} />
    )
    expect(chip(html)).toEqual({ sampled: 'false', text: 'all frames · 1–12' })
    expect(html).not.toContain('zoom to all frames')
    // One cell per frame, no stacked edge.
    expect(html.match(/data-cell=/g)).toHaveLength(12)
  })

  it('says "every Nth frame" in the warn tone, and offers to zoom in', () => {
    const html = render(
      <ZoomFilmstrip
        jobId="j"
        frameStart={1}
        frameEnd={5000}
        frameStep={1}
        initialWidth={960}
        initialView={{ from: 0, to: 4999 }}
      />
    )
    // 960 px holds 16 cells of 56 + 2: every ceil(5000 / 16) = 313th frame.
    expect(chip(html)).toEqual({ sampled: 'true', text: 'every 313th frame · 1–5000' })
    expect(html).toContain('var(--warn-soft-text)')
    expect(html).toContain('zoom to all frames')
    expect(html.match(/data-cell=/g)!.length).toBeLessThanOrEqual(16)
  })

  it('counts the stride in frame numbers when the job steps', () => {
    const html = render(
      <ZoomFilmstrip
        jobId="j"
        frameStart={1}
        frameEnd={479}
        frameStep={2}
        initialWidth={960}
        initialView={{ from: 0, to: 239 }}
      />
    )
    // 240 frames in 16 cells: every 15th index, every 30th frame number.
    expect(chip(html).text).toBe('every 30th frame · 1–479')
  })

  it('opens a long job around the newest frames done', () => {
    const html = render(
      <ZoomFilmstrip
        jobId="j"
        frameStart={1}
        frameEnd={5000}
        frameStep={1}
        initialWidth={960}
        chunks={[
          chunk({ id: 'a', frameStart: 1, frameEnd: 1000, state: 'complete' }),
          chunk({ id: 'b', frameStart: 1001, frameEnd: 2000, state: 'rendering', framesDone: 500 })
        ]}
      />
    )
    // 200 frames centred on frame 1500, the newest done; 200 in 16 cells.
    expect(chip(html).text).toBe('every 13th frame · 1401–1600')
  })

  it('says so when the job has no frames', () => {
    const html = render(<ZoomFilmstrip jobId="j" frameStart={10} frameEnd={1} frameStep={1} />)
    expect(html).toContain('No frames in this job.')
  })
})
