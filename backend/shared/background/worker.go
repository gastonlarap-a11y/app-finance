package background

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
)

// TaskFunc is a unit of background work.
type TaskFunc func(ctx context.Context) error

// Worker is a generic goroutine pool. Inject it into any service that needs async
// processing; its lifecycle is driven by ServiceStartup()/ServiceShutdown().
type Worker struct {
	queue  chan TaskFunc
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func New(bufferSize int) *Worker {
	return &Worker{queue: make(chan TaskFunc, bufferSize)}
}

func (w *Worker) Start(ctx context.Context, concurrency int) {
	ctx, w.cancel = context.WithCancel(ctx)
	for range concurrency {
		w.wg.Go(func() { w.run(ctx) })
	}
}

func (w *Worker) Enqueue(task TaskFunc) error {
	select {
	case w.queue <- task:
		return nil
	default:
		return errors.New("background: queue full")
	}
}

func (w *Worker) Stop() {
	if w.cancel != nil {
		w.cancel()
	}
	w.wg.Wait()
}

func (w *Worker) run(ctx context.Context) {
	for {
		select {
		case task := <-w.queue:
			if err := runTask(ctx, task); err != nil {
				slog.Error("background task failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}

// runTask runs one task, turning a panic into an error. Tasks process untrusted
// input (bank emails through MIME/HTML parsers); a panic in one must not kill
// the app — it would come back on every launch with the first auto-sync.
func runTask(ctx context.Context, task TaskFunc) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("background task panicked: %v\n%s", r, debug.Stack())
		}
	}()
	return task(ctx)
}
