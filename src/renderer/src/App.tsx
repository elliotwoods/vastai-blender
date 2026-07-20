import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { useNav } from './lib/nav'
import { useIpcEvents } from './lib/queries'
import { FleetScreen } from './screens/Fleet/FleetScreen'
import { GalleryScreen } from './screens/Gallery/GalleryScreen'
import { JobDetailScreen } from './screens/JobDetail/JobDetailScreen'
import { JobsScreen } from './screens/Jobs/JobsScreen'
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
    case 'settings':
      return <SettingsScreen section={route.section} />
  }
}

function App(): React.JSX.Element {
  useIpcEvents()
  const back = useNav((s) => s.back)

  // Alt+Left / mouse button 4 → back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowLeft') back()
    }
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) back()
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
      <main style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <Screen />
      </main>
    </div>
  )
}

export default App
