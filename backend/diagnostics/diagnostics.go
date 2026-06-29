package diagnostics

import (
	"context"
	"log/slog"
)

// DiagnosticsService receives frontend error reports from the React ErrorBoundary.
type DiagnosticsService struct{}

func NewDiagnosticsService() *DiagnosticsService { return &DiagnosticsService{} }

func (s *DiagnosticsService) ServiceName() string { return "DiagnosticsService" }

// ReportError is bound to TypeScript and called when a render error is caught.
func (s *DiagnosticsService) ReportError(ctx context.Context, message string, stack string) error {
	slog.Error("frontend render error", "message", message, "stack", stack)
	return nil
}
