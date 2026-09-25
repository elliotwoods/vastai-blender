import { useState, type CSSProperties } from 'react'
import { AppToolbar } from '../../components/AppToolbar'
import { SubmitJobDialog } from './SubmitJobDialog'
import { OpenInExplorerButton } from '../../components/OpenInExplorerButton'
import { ProgressBar } from '../../components/ProgressBar'
import { barStateOf } from '../../components/progressSegments'
import { btn, chip, mono, panel, tableRow } from '../../lib/controls'
import { basename, fmtFrames, fmtMoney, fmtTimeAgo } from '../../lib/format'
import { useNav } from '../../lib/nav'
import { useJobs } from '../../lib/queries'
import { SCALE, TOKENS } from '../../lib/theme'
import type { JobSummary } from '../../../../shared/models'

const engineChipStyle: CSSProperties = { textTransform: 'uppercase', fontSize: 'var(--text-2xs)' }

function JobRow({ job }: { job: JobSummary }): React.JSX.Element {
  const { navigate } = useNav()
  return (
    <div
      style={tableRow({ clickable: true })}
      onClick={() => navigate({ screen: 'job', jobId: job.id })}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space2 }}>
          <span style={{ fontWeight: SCALE.weightSemibold, fontSize: SCALE.textSm }}>
            {job.name || basename(job.blendPath)}
          </span>
          <span style={{ ...chip({ tone: 'accent' }), ...engineChipStyle }}>{job.engine}</span>
          {job.shareNode ? (
            <span
              style={{ ...chip({ tone: 'neutral' }), ...engineChipStyle }}
              title="May run alongside other renders on one node"
            >
              shared
            </span>
          ) : null}
          <span style={{ ...mono, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
            {job.frameStart}–{job.frameEnd}
            {job.frameStep > 1 ? ` ×${job.frameStep}` : ''}
          </span>
        </div>
        <div style={{ marginTop: 6 }}>
          <ProgressBar
            done={job.framesDone}
            total={job.framesTotal}
            cancelled={job.framesCancelled}
            state={barStateOf(job)}
            label={`frames of ${job.name || basename(job.blendPath)}`}
            ticks
          />
        </div>
      </div>
      <span style={{ width: 90, fontSize: SCALE.textSm, color: TOKENS.textSecondary }}>
        {job.state}
      </span>
      <span style={{ ...mono, width: 110, fontSize: SCALE.textSm }}>
        {fmtFrames(job.framesDone, job.framesTotal)}
      </span>
      <span style={{ ...mono, width: 70, fontSize: SCALE.textSm }}>{fmtMoney(job.costSoFar)}</span>
      <span style={{ ...mono, width: 80, fontSize: SCALE.textXs, color: TOKENS.textFaint }}>
        {fmtTimeAgo(job.submittedAt)}
      </span>
      <OpenInExplorerButton path={job.outputDir} mode="open" title="Open output folder" />
    </div>
  )
}

export function JobsScreen(): React.JSX.Element {
  const { data: jobs, isLoading } = useJobs()
  const [showSubmit, setShowSubmit] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {showSubmit ? <SubmitJobDialog onClose={() => setShowSubmit(false)} /> : null}
      <AppToolbar
        left={
          <button
            style={btn({ variant: 'primary', size: 'sm' })}
            onClick={() => setShowSubmit(true)}
          >
            + new render
          </button>
        }
      />
      <div style={{ flex: 1, overflow: 'auto', padding: SCALE.space4 }}>
        {(jobs ?? []).length === 0 ? (
          <div style={{ ...panel(), padding: SCALE.space6, textAlign: 'center' }}>
            <span style={{ color: TOKENS.textFaint }}>
              {isLoading ? 'Loading…' : 'No render jobs yet.'}
            </span>
          </div>
        ) : (
          <div style={panel()}>
            {(jobs ?? []).map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
