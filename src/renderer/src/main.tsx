import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Main-process data is pushed via IPC events; avoid speculative refetch churn.
      refetchOnWindowFocus: false,
      staleTime: 30_000
    }
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
