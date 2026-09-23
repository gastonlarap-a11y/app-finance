import React from 'react'
import { reportRenderError } from '@/services/diagnostics'

interface Props {
  children: React.ReactNode
}
interface State {
  hasError: boolean
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  override componentDidCatch(error: Error) {
    console.error('ErrorBoundary caught a render error:', error)
    reportRenderError(error.message, error.stack ?? '').catch((err: unknown) => {
      console.error('could not report the render error:', err)
    })
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface text-slate-100">
          <h1 className="text-2xl font-bold text-danger">Algo salió mal</h1>
          <p className="text-slate-400">La app encontró un error inesperado. Tus datos no se perdieron.</p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="rounded bg-primary px-4 py-2 font-medium"
          >
            Reintentar
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
