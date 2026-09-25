/**
 * One job, in full. On a wide window every job is listed down the left
 * (JobsSidebar) so moving between them is one click, or Alt+↑/↓. The rest
 * is one scrolling column, in the order a question about a job is usually
 * asked: how is it set up (settings, node sharing), how far along is it
 * (summary bar, time, counts), what is rendering right now (live: node, GPU,
 * frame, Blender's status), what has it made (the zoomable filmstrip), and
 * the detail: where the time goes, the chunks and the node logs, side by
 * side when the column has the room.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { useWidth } from '../../components/charts/useWidth'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import { segmentTotals, segmentsFromChunks } from '../../components/progressSegments'
import { btn, mono, readout } from '../../lib/controls'
import { basename, fmtFrames, fmtMoney } from '../../lib/format'
import { useNav } from '../../lib/nav'
import { isPreviewOpen, usePreview } from '../../lib/preview'
import { useJobProgress } from '../../lib/progressStore'
import {
  useAddons,
  useCancelJob,
  useJob,
  useJobs,
  useNodes,
  useQueue,
  useRemoveJob,
  useResumeJob,
  useRetryMissing,
  useSetJobShareNode,
  useUngroupJob
} from '../../lib/queries'
import { describeResume, describeRetry, ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { ZoomFilmstrip } from '../../media/ZoomFilmstrip'
import { ChunkGrid } from './ChunkGrid'
import { JobActions, JobAttentionNote, SceneChangedNote } from './JobActions'
import { JobSettingsPanel } from './JobSettingsPanel'
import { JobsSidebar } from './JobsSidebar'
import { JobSummaryPanel } from './JobSummaryPanel'
import { LiveProgressPanel } from './LiveProgressPanel'
import { LOG_HEIGHT, LogPanel } from './LogPanel'
import { RenderTimes } from './RenderTimes'
import { Section } from './Section'
import {
  isActiveChunk,
  neighbourJob,
  nodeLabel,
  readFlag,
  SETTINGS_KEY,
  SIDEBAR_KEY,
  sidebarOrder,
  writeFlag
} from './jobDetailModel'

/** The window width at which the jobs sidebar shows. */
export const SIDEBAR_QUERY = '(min-width: 1280px)'
/** The column width at which the chunks and the log sit side by side. */
export const SIDE_BY_SIDE_PX = 1100

/** A key event aimed at something that takes arrow keys itself. */
function inField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function useFlag(key: string, fallback: boolean): [boolean, () => void] {
  const [v, setV] = useState(() => readFlag(key, fallback))
  return [
    v,
    () =>
      setV((prev) => {
        writeFlag(key, !prev)
        return !prev
      })
  ]
}

export function JobDetailScreen({ jobId }: { jobId: string }): React.JSX.Element {
  const { data: job, isLoading } = useJob(jobId)
  const { data: jobs } = useJobs()
  const { data: queue } = useQueue()
  const { data: nodes } = useNodes()
  const { data: addons } = useAddons()
  const progress = useJobProgress(jobId)
  const { navigate } = useNav()
  const openPreview = usePreview((s) => s.open)

  const wide = useMediaQuery(SIDEBAR_QUERY)
  const [sidebarOpen, toggleSidebar] = useFlag(SIDEBAR_KEY, true)
  const [settingsOpen, toggleSettings] = useFlag(SETTINGS_KEY, true)
  const order = useMemo(() => sidebarOrder(jobs ?? []), [jobs])

  // Alt+↑/↓: the previous or next job, in the sidebar's order, whether or
  // not the sidebar is showing. Not while the preview overlay has the keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      if (isPreviewOpen() || inField(e.target)) return
      const next = neighbourJob(order, jobId, e.key === 'ArrowUp' ? -1 : 1)
      if (!next) return
      e.preventDefault()
      navigate({ screen: 'job', jobId: next })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order, jobId, navigate])

  const columnRef = useRef<HTMLDivElement>(null)
  const columnWidth = useWidth(columnRef)
  const sideBySide = columnWidth >= SIDE_BY_SIDE_PX

  const setShare = useSetJobShareNode()
  const ungroup = useUngroupJob()
  const cancel = useCancelJob()
  const remove = useRemoveJob()

  // "Re-render missing" (plan 1.15): what it queued, or why main refused,
  // beside the button. Kept per job, so another job's screen starts clean.
  const retryMissing = useRetryMissing()
  const [note, setNote] = useState<{ jobId: string; text: string } | null>(null)
  const onRetryMissing = (): Promise<void> =>
    retryMissing.mutateAsync(jobId).then(
      (r) => setNote({ jobId, text: describeRetry(r) }),
      (e: unknown) => setNote({ jobId, text: ipcErrorText(e) })
    )
  // "resume" for a job the retry breaker held (plan 1.17), the same way.
  const resume = useResumeJob()
  const onResume = (): Promise<void> =>
    resume.mutateAsync(jobId).then(
      (r) => setNote({ jobId, text: describeResume(r) }),
      (e: unknown) => setNote({ jobId, text: ipcErrorText(e) })
    )
  const onRemove = (): Promise<void> =>
    remove.mutateAsync(jobId).then(
      () => navigate({ screen: 'jobs' }),
      (e: unknown) => setNote({ jobId, text: ipcErrorText(e) })
    )

  // The frame picked in the filmstrip, per job like the note.
  const [picked, setPicked] = useState<{ jobId: string; frame: number } | null>(null)
  const currentFrame = picked?.jobId === jobId ? picked.frame : undefined
  const openFrame = (frame: number): void => {
    const owner = job?.chunks.find((c) => frame >= c.frameStart && frame <= c.frameEnd)
    if (owner) openPreview({ jobId, chunkId: owner.id, frame })
  }

  const segments = useMemo(
    () => segmentsFromChunks(job?.chunks, progress, job ?? undefined),
    [job, progress]
  )
  const totals = useMemo(() => segmentTotals(segments), [segments])

  const nodeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of job?.chunks ?? []) if (c.nodeId) ids.add(c.nodeId)
    return [...ids]
  }, [job])
  const labelOf = (id: string): string =>
    nodeLabel(
      nodes?.find((n) => n.id === id),
      id
    )
  const hasActive = (job?.chunks ?? []).some((c) => isActiveChunk(c.state))

  const chunks = job ? (
    <Section title="chunks">
      <ChunkGrid
        chunks={job.chunks}
        step={job.frameStep}
        nodeLabel={labelOf}
        maxHeight={sideBySide ? LOG_HEIGHT : undefined}
      />
    </Section>
  ) : null
  const logs = (
    <Section title="node logs">
      <LogPanel nodeIds={nodeIds} />
    </Section>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppToolbar
        right={
          job ? (
            <>
              <span style={readout()}>
                <span style={{ color: TOKENS.textFaint }}>frames</span>
                <span style={mono}>{fmtFrames(job.framesDone, job.framesTotal)}</span>
                <span style={{ color: TOKENS.textFaint }}>·</span>
                <span style={mono}>{fmtMoney(job.costSoFar)}</span>
              </span>
              <OpenInExplorerButton path={job.outputDir} mode="open" title="Open output folder" />
              <JobActions
                job={job}
                onResume={onResume}
                onRetryMissing={onRetryMissing}
                onCancel={() => cancel.mutateAsync(jobId)}
                onRemove={onRemove}
                note={note?.jobId === jobId ? note.text : null}
              />
            </>
          ) : undefined
        }
        subRow={
          <>
            <button
              style={btn({ variant: 'ghost', size: 'sm' })}
              onClick={() => navigate({ screen: 'jobs' })}
            >
              Jobs
            </button>
            <span style={{ color: TOKENS.textFaint }}>/</span>
            <span style={{ fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
              {job ? job.name || basename(job.blendPath) : jobId}
            </span>
            {job ? (
              <span style={{ fontSize: SCALE.textXs, color: TOKENS.textFaint }}>{job.state}</span>
            ) : null}
            {job ? <JobAttentionNote job={job} /> : null}
            {job ? <SceneChangedNote job={job} /> : null}
          </>
        }
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {wide ? (
          <JobsSidebar
            jobs={order}
            currentId={jobId}
            open={sidebarOpen}
            onToggle={toggleSidebar}
            onOpen={(id) => navigate({ screen: 'job', jobId: id })}
          />
        ) : null}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          <div
            ref={columnRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: SCALE.space5,
              padding: SCALE.space4,
              minWidth: 0
            }}
          >
            {job ? (
              <>
                <Section title="settings" open={settingsOpen} onToggle={toggleSettings}>
                  <JobSettingsPanel
                    job={job}
                    onShareChange={(shareNode) => setShare.mutate({ jobId, shareNode })}
                    sharePending={setShare.isPending}
                    queue={queue}
                    jobs={jobs}
                    addons={addons}
                    onUngroup={() => ungroup.mutate(jobId)}
                    ungroupPending={ungroup.isPending}
                  />
                </Section>

                <Section title="progress">
                  <JobSummaryPanel job={job} segments={segments} totals={totals} />
                </Section>

                {hasActive ? (
                  <Section title="rendering now">
                    <LiveProgressPanel
                      chunks={job.chunks}
                      step={job.frameStep}
                      progress={progress}
                      nodes={nodes}
                    />
                  </Section>
                ) : null}

                <Section
                  title="frames"
                  right={
                    <span style={{ fontSize: 'var(--text-2xs)', color: TOKENS.textFaint }}>
                      click to pick · double-click or Enter to preview · ←/→ step
                    </span>
                  }
                >
                  <ZoomFilmstrip
                    jobId={jobId}
                    frameStart={job.frameStart}
                    frameEnd={job.frameEnd}
                    frameStep={job.frameStep}
                    chunks={job.chunks}
                    liveProgress={progress}
                    currentFrame={currentFrame}
                    onSelect={(frame) => setPicked({ jobId, frame })}
                    onOpen={openFrame}
                  />
                </Section>

                {job.renderTimes?.some((t) => t.frames > 0) ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: SCALE.space2 }}>
                    <RenderTimes times={job.renderTimes} />
                  </div>
                ) : null}

                {sideBySide ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                      gap: SCALE.space4
                    }}
                  >
                    {chunks}
                    {logs}
                  </div>
                ) : (
                  <>
                    {chunks}
                    {logs}
                  </>
                )}
              </>
            ) : (
              <span style={{ fontSize: SCALE.textSm, color: TOKENS.textFaint }}>
                {isLoading ? 'Loading job…' : 'This job is not in the list any more.'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
