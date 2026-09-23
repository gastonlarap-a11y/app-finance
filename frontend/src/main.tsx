import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import '@/index.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'

function Fatal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-slate-400">{children}</p>
      </div>
    </div>
  )
}

function UnsupportedStorage() {
  return (
    <Fatal title="Almacenamiento no disponible">
      Este navegador no permite guardar datos de forma persistente en este modo. Sal de la
      navegación privada, o abre la app en Safari y usa «Compartir → Añadir a pantalla de inicio»
      para instalarla.
    </Fatal>
  )
}

// The web engine lives in a worker and every view calls it as
// `.then(setState).finally(stopSpinner)`: a rejected call leaves the state
// untouched and the app looks empty instead of broken. On a tablet there is no
// console to check, so surface whatever escaped.
function reportEngineFailures(root: ReactDOM.Root) {
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason
    root.render(
      <React.StrictMode>
        <Fatal title="La app no pudo cargar tus datos">
          {reason instanceof Error ? reason.message : String(reason)}
        </Fatal>
      </React.StrictMode>,
    )
  })
}

async function start() {
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  // Literal (via define) so the bundler drops the web-only import on desktop.
  if (import.meta.env.VITE_TARGET === 'web') {
    // The web build stores everything in OPFS; without it (e.g. Safari private
    // browsing) refuse to start instead of silently losing data.
    const { detectOpfsSupport } = await import('@/engine/db/support')
    if (!(await detectOpfsSupport())) {
      root.render(
        <React.StrictMode>
          <UnsupportedStorage />
        </React.StrictMode>,
      )
      return
    }
    reportEngineFailures(root)
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

void start()
