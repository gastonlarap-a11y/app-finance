import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import '@/index.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'

function UnsupportedStorage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Almacenamiento no disponible</h1>
        <p className="text-sm text-slate-400">
          Este navegador no permite guardar datos de forma persistente en este modo. Sal de la
          navegación privada, o abre la app en Safari y usa «Compartir → Añadir a pantalla de
          inicio» para instalarla.
        </p>
      </div>
    </div>
  )
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
