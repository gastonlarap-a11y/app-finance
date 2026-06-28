# Wails Reference (v3 default · v2 legacy)

Companion to [SKILL.md](./SKILL.md). Deep examples, side-by-side v2↔v3 translations, the bindings
walkthrough, the cross-platform build matrix, and a migration checklist. Every v3 snippet matches
the structure this repo's generator (`generador.go`) emits.

> **Sources**: v3 — <https://v3.wails.io> · v2 — <https://wails.io> (fetched 2026-06 via context7).

---

## 1 — Full v3 `main.go` orchestration

The three explicit phases: **create app (+ services) → create window → run.**

```go
package main

import (
	"context"
	"embed"
	"log/slog"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"myapp/backend/example"
	"myapp/backend/shared/background"
	"myapp/backend/shared/config"
	"myapp/backend/shared/db"
	"myapp/backend/shared/logger"
	"myapp/backend/shared/windowstate"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg := config.MustLoad()
	logger.Setup(cfg.LogLevel)

	bdb := db.MustConnect(cfg)
	if err := db.RunMigrations(context.Background(), bdb); err != nil {
		slog.Error("migration failed", "err", err)
		os.Exit(1)
	}

	worker := background.New(50)
	exampleSvc := example.NewExampleService(bdb, worker)

	app := application.New(application.Options{
		Name:     cfg.DisplayName,
		LogLevel: slog.LevelInfo,
		Services: []application.Service{
			application.NewService(exampleSvc),
			// register one NewService(...) per domain
		},
		Assets:     application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		OnShutdown: func() { _ = bdb.Close() },
	})

	st := windowstate.Load(context.Background(), bdb)
	window := app.NewWebviewWindowWithOptions(application.WebviewWindowOptions{
		Title:           cfg.DisplayName,
		Width:           st.W,
		Height:          st.H,
		X:               st.X,
		Y:               st.Y,
		InitialPosition: application.WindowXY,
	})

	window.OnWindowEvent(events.Common.WindowClosing, func(e *application.WindowEvent) {
		w, h := window.Size()
		x, y := window.Position()
		_ = windowstate.Save(context.Background(), bdb, windowstate.State{X: x, Y: y, W: w, H: h})
	})

	if err := app.Run(); err != nil {
		slog.Error("app exited with error", "err", err)
		os.Exit(1)
	}
}
```

---

## 2 — Context-aware async service (no UI freeze)

A bound method must return fast. Offload heavy work and stream progress via events.

```go
type ReportService struct {
	worker *background.Worker
	app    *application.App // injected so the service can emit app-level events
}

func (s *ReportService) ServiceName() string { return "ReportService" }

func (s *ReportService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	s.worker.Start(ctx, 2) // 2 concurrent goroutines, tied to the app context
	return nil
}

func (s *ReportService) ServiceShutdown() error {
	s.worker.Stop() // drains in-flight tasks — no goroutine leak
	return nil
}

// StartExport returns immediately; the actual work runs on the pool and reports
// back through events. The frontend listens with Events.On("export:done", ...).
func (s *ReportService) StartExport(ctx context.Context, rows []map[string]any) error {
	return s.worker.Enqueue(func(taskCtx context.Context) error {
		select {
		case <-taskCtx.Done():
			return taskCtx.Err() // honor cancellation/shutdown
		default:
		}
		data, err := buildXLSX(rows)
		if err != nil {
			s.app.EmitEvent("export:error", err.Error())
			return err
		}
		s.app.EmitEvent("export:done", base64.StdEncoding.EncodeToString(data))
		return nil
	})
}
```

**Anti-patterns**

- ❌ Doing the export synchronously inside `StartExport` — freezes the webview until it finishes.
- ❌ `go func() { ... }()` with no owner — leaks if the app quits mid-task; use the worker so
  `ServiceShutdown` drains it.

---

## 3 — v2 ↔ v3 side-by-side

### Application bootstrap

```go
// ── v2 (legacy, stable) ───────────────────────────────────────────
err := wails.Run(&options.App{
	Title:     "My App",
	Width:     1200,
	Height:    800,
	Assets:    assets,
	OnStartup: app.startup,   // func(ctx context.Context)
	OnDomReady: app.domReady,
	OnBeforeClose: app.beforeClose, // func(ctx) (prevent bool)
	OnShutdown: app.shutdown,
	Bind: []any{app, otherStruct},
})

// ── v3 (default, this repo) ───────────────────────────────────────
app := application.New(application.Options{
	Name:       "My App",
	Assets:     application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
	ShouldQuit: func() bool { return true },
	OnShutdown: func() { /* ... */ },
	Services:   []application.Service{application.NewService(svc)},
})
win := app.NewWebviewWindowWithOptions(application.WebviewWindowOptions{
	Title: "My App", Width: 1200, Height: 800,
})
_ = app.Run()
```

### Runtime calls

```go
// ── v2: global runtime package, threaded ctx ──────────────────────
import "github.com/wailsapp/wails/v2/pkg/runtime"
runtime.WindowSetTitle(a.ctx, "New Title")
runtime.EventsEmit(a.ctx, "data-updated", payload)
runtime.LogInfo(a.ctx, "hello")

// ── v3: window/app methods + slog ─────────────────────────────────
window.SetTitle("New Title")
window.EmitEvent("data-updated", payload) // or app.EmitEvent(...)
slog.Info("hello")                         // structured logging, not runtime.Log*
```

### Frontend runtime (v3)

```ts
import { Events, Window, Dialogs, Clipboard, Screens } from '@wailsio/runtime'

Events.On('data-updated', (e) => updateUI(e.data))
await Window.Center()
await Clipboard.SetText('Copied from Wails!')
const choice = await Dialogs.Question({
  Title: 'Confirm', Message: 'Delete this item?',
  Buttons: [{ Label: 'Delete' }, { Label: 'Cancel', IsDefault: true }],
})
```

---

## 4 — Bindings walkthrough (v3)

1. **Write** an exported service method:

```go
func (g *GreetService) Greet(name string) string { return "Hello " + name }
```

2. **Generate**:

```bash
wails3 generate bindings -ts
# → frontend/bindings/<full-go-import-path>/greetservice.ts  (and .js)
```

3. **Wrap** in a single module — never import the generated path app-wide:

```ts
// frontend/src/services/greet.ts  (the ONLY file that touches bindings/)
export { GreetService } from '@/../bindings/myapp/backend/greet'
```

4. **Use** from React:

```tsx
import { GreetService } from '@/services/greet'
const msg = await GreetService.Greet('Ada') // typed, returns Promise<string>
```

**Binding-safe signature rules**

- First parameter `context.Context` (dropped from the generated JS signature, used for cancellation).
- Return concrete structs, not generics. Business outcome → `Result{ Data, Error *AppError }`.
- A returned Go `error` rejects the JS promise; a populated `*AppError` inside a Result resolves it.

---

## 5 — Cross-platform build matrix (v3)

Wails apps embed native webview libs, so **build each OS on its own runner** — there is no reliable
single-host cross-compile for production artifacts.

### Taskfile targets

```yaml
# darwin:build sets the deployment target so the binary runs on older macOS.
darwin:build:
  platforms: [darwin]
  cmds:
    - task: common:go:mod:tidy
    - task: common:build:frontend     # tsc --noEmit && vite build  (minified)
    - task: common:generate:icons
    - task: darwin:build:app
  env:
    CGO_CFLAGS: "-mmacosx-version-min=10.15"
    CGO_LDFLAGS: "-mmacosx-version-min=10.15"
    MACOSX_DEPLOYMENT_TARGET: "10.15"
```

### GitHub Actions — native runner per OS

```yaml
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: ubuntu-latest,  goos: linux }
          - { os: macos-latest,   goos: darwin }
          - { os: windows-latest, goos: windows }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.25' }
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: go install github.com/wailsapp/wails/v3/cmd/wails3@latest
      - uses: arduino/setup-task@v2
      - run: wails3 build
      - uses: actions/upload-artifact@v4
        with: { name: app-${{ matrix.goos }}, path: bin/ }
```

**Signing** (release tags): `wails3 task windows:sign SIGN_CERTIFICATE=cert.pfx` (Windows) and
`wails3 task linux:sign:packages PGP_KEY=key.asc` (Linux `.deb`/`.rpm`) can run from a single Linux
runner; macOS notarization runs on `macos-latest`.

---

## 6 — Migration checklist v2 → v3

- [ ] Swap imports: `wails/v2` → `wails/v3/pkg/application` (+ `.../pkg/events`).
- [ ] Replace the single `wails.Run(&options.App{...})` with app → window → `Run()` (§1).
- [ ] Convert each `Bind` struct into a **Service**; move `OnStartup` logic into `ServiceStartup`.
- [ ] Replace `OnDomReady` → `events.Common.WindowRuntimeReady`; `OnBeforeClose` → `ShouldQuit` /
      `events.Common.WindowClosing`; `OnShutdown` → `application.Options.OnShutdown` /
      `ServiceShutdown`.
- [ ] Replace every `runtime.*(ctx, ...)` call with the window/app method or `@wailsio/runtime` (JS).
- [ ] Replace `runtime.Log*` with `slog`.
- [ ] Regenerate bindings (`wails3 generate bindings -ts`) and re-wrap them in per-service modules.
- [ ] Switch the CLI everywhere: `wails` → `wails3`; run `wails3 doctor`.

### Common stale-API mistakes

| Mistake (v2 reflex) | Fix (v3) |
|---|---|
| `OnDomReady` hook | `window.OnWindowEvent(events.Common.WindowRuntimeReady, …)` |
| `runtime.EventsEmit(ctx, …)` | `window.EmitEvent(…)` / `app.EmitEvent(…)` |
| `runtime.WindowSetTitle(ctx, …)` | `window.SetTitle(…)` |
| `Bind: []any{...}` | `Services: []application.Service{application.NewService(...)}` |
| `runtime.LogInfo(ctx, …)` | `slog.Info(…)` |
| `wails dev` / `wails build` | `wails3 dev` / `wails3 build` |
