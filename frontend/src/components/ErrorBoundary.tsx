import React from 'react'
import { reportRenderError } from '@/services/diagnostics'
import { FatalScreen } from './FatalScreen'

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
        <FatalScreen title="Algo salió mal" actionLabel="Reintentar" onAction={() => this.setState({ hasError: false })}>
          La app encontró un error inesperado. Tus datos no se perdieron.
        </FatalScreen>
      )
    }
    return this.props.children
  }
}
