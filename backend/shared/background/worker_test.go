package background

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunTaskTurnsPanicIntoError(t *testing.T) {
	err := runTask(t.Context(), func(context.Context) error { panic("bad email") })
	if err == nil || !strings.Contains(err.Error(), "bad email") {
		t.Fatalf("runTask(panicking) = %v, want an error mentioning the panic", err)
	}
	want := errors.New("plain")
	if got := runTask(t.Context(), func(context.Context) error { return want }); !errors.Is(got, want) {
		t.Fatalf("runTask(error) = %v, want %v", got, want)
	}
}

func TestWorkerSurvivesAPanickingTask(t *testing.T) {
	w := New(4)
	w.Start(t.Context(), 1)
	defer w.Stop()

	var ran atomic.Bool
	done := make(chan struct{})
	if err := w.Enqueue(func(context.Context) error { panic("boom") }); err != nil {
		t.Fatal(err)
	}
	if err := w.Enqueue(func(context.Context) error {
		ran.Store(true)
		close(done)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the task after a panicking one never ran")
	}
	if !ran.Load() {
		t.Fatal("second task did not run")
	}
}
