import { useEffect } from 'react'
import { RecoveryBanner } from './components/RecoveryBanner'
import { Sidebar } from './components/Sidebar'
import { useNav } from './lib/nav'
import { isPreviewOpen, usePreview } from './lib/preview'
import { useIpcEvents } from './lib/queries'
import { PreviewOverlay } from './media/PreviewOverlay'
import { FleetScreen } from './screens/Fleet/FleetScreen'
import { GalleryScreen } from './screens/Gallery/GalleryScreen'
import { HistoryScreen } from './screens/History/HistoryScreen'
import { JobDetailScreen } from './screens/JobDetail/JobDetailScreen'
import { JobsScreen } from './screens/Jobs/JobsScreen'
import { GradeLabScreen } from './screens/GradeLab/GradeLabScreen'
import { SettingsScreen } from './screens/Settings/SettingsScreen'

function Screen(): React.JSX.Element {
  const { route } = useNav()
  switch (route.screen) {
    case 'fleet':
      return <FleetScreen />
    case 'jobs':
      return <JobsScreen />
    case 'job':
      return <JobDetailScreen jobId={route.jobId} />
    case 'gallery':
      return <GalleryScreen jobId={route.jobId} chunkId={route.chunkId} />
    case 'history':
      return <HistoryScreen metric={route.metric} range={route.range} />
    case 'gradelab':
      return <GradeLabScreen />
    case 'settings':
      return <SettingsScreen section={route.section} />
  }
}

function App(): React.JSX.Element {
  useIpcEvents()
  const back = useNav((s) => s.back)

  // Alt+Left / mouse button 4 → back, unless the preview overlay is up: while
  // it is, "back" means close it. Navigating out from under an open overlay
  // would leave it floating over a screen it has nothing to do with.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowLeft') {
        if (isPreviewOpen()) usePreview.getState().close()
        else back()
      }
    }
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) {
        if (isPreviewOpen()) usePreview.getState().close()
        else back()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [back])

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Sidebar />
      <main
        style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        {/* Above the screen, not inside it: the hold is app-wide, and every
            screen would otherwise have to remember to show it. */}
        <RecoveryBanner />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Screen />
        </div>
      </main>
      {/* Sibling of <main>, so it covers the sidebar too. */}
      <PreviewOverlay />
    </div>
  )
}

export default App
