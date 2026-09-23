// Wrapper around the generated DiagnosticsService bindings: forwards render
// errors caught by the ErrorBoundary to the Go log (logs/app.log).
import { DiagnosticsService } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/diagnostics'

export function reportRenderError(message: string, stack: string): Promise<void> {
  return DiagnosticsService.ReportError(message, stack)
}
