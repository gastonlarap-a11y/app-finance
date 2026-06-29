package logger

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/lmittmann/tint"
	"path/filepath"

	"gopkg.in/natefinch/lumberjack.v2"
)

func levelFromString(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Setup installs the global slog logger. Call once at startup.
// The level is switchable at runtime via the LOG_LEVEL config key.
func Setup(level string) {
	lvl := levelFromString(level)
	var handlers []slog.Handler
	handlers = append(handlers, tint.NewHandler(os.Stderr, &tint.Options{
		Level:      lvl,
		TimeFormat: time.Kitchen,
	}))
	_ = os.MkdirAll("logs", 0o755)
	fileWriter := &lumberjack.Logger{
		Filename:   filepath.Join("logs", "app.log"),
		MaxSize:    10, // MB
		MaxBackups: 3,
		MaxAge:     30, // days
		Compress:   true,
	}
	handlers = append(handlers, slog.NewJSONHandler(fileWriter, &slog.HandlerOptions{Level: lvl}))

	var h slog.Handler
	switch len(handlers) {
	case 0:
		h = slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl})
	case 1:
		h = handlers[0]
	default:
		h = fanout(handlers...)
	}
	slog.SetDefault(slog.New(h))
}

// fanout dispatches each record to every underlying handler (console + file).
type fanoutHandler struct{ handlers []slog.Handler }

func fanout(h ...slog.Handler) slog.Handler { return fanoutHandler{handlers: h} }

func (f fanoutHandler) Enabled(ctx context.Context, l slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, l) {
			return true
		}
	}
	return false
}

func (f fanoutHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, h := range f.handlers {
		if h.Enabled(ctx, r.Level) {
			_ = h.Handle(ctx, r.Clone())
		}
	}
	return nil
}

func (f fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	hs := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		hs[i] = h.WithAttrs(attrs)
	}
	return fanoutHandler{handlers: hs}
}

func (f fanoutHandler) WithGroup(name string) slog.Handler {
	hs := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		hs[i] = h.WithGroup(name)
	}
	return fanoutHandler{handlers: hs}
}
