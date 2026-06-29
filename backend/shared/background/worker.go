package background

import (
	"context"
	"errors"
	"log/slog"
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
	for i := 0; i < concurrency; i++ {
		w.wg.Add(1)
		go w.run(ctx)
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
	defer w.wg.Done()
	for {
		select {
		case task := <-w.queue:
			if err := task(ctx); err != nil {
				slog.Error("background task failed", "err", err)
			}
		case <-ctx.Done():
			return
		}
	}
}
