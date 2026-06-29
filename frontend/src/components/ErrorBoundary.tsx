import React from 'react'

// After `wails3 generate bindings`, report errors to Go:
//   import { DiagnosticsService } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/diagnostics'

interface Props {
  children: React.ReactNode
}
interface State {
  hasError: boolean
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    // DiagnosticsService.ReportError(error.message, error.stack ?? '')
    console.error('ErrorBoundary caught a render error:', error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-surface text-slate-100">
          <h1 className="text-2xl font-bold text-red-400">Something went wrong</h1>
          <p className="text-slate-400">The app hit an unexpected error.</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="rounded bg-primary px-4 py-2 font-medium"
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
