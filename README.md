# 🚀 Wails v3 App Generator

An interactive CLI wizard that scaffolds a **production-ready Wails v3 desktop application** in seconds. Answer a few questions and get a fully structured project with your chosen database, configuration strategy, logging, and optional modules — all generated atomically.

---

## Prerequisites

Before running the generator, make sure you have the following installed:

| Tool | Version | Notes |
|------|---------|-------|
| [Go](https://go.dev/dl/) | 1.21+ | Required to build and run the generator |
| [Node.js](https://nodejs.org/) | 18+ | Required for the React frontend |
| [Wails v3 CLI](https://v3alpha.wails.io/getting-started/installation/) | v3.x | `go install github.com/wailsapp/wails/v3/cmd/wails3@latest` |
| [Task](https://taskfile.dev/) | 3.x | Optional — used by the generated `Taskfile.yml` |

> **Note:** Wails v3 is currently in alpha. Check the [Wails v3 docs](https://v3alpha.wails.io/) for the latest setup requirements for your OS.

---

## Initializing a New Project

### 1. Clone this repository

```bash
git clone https://github.com/your-username/template-app-go.git
cd template-app-go
```

### 2. Install dependencies

```bash
go mod tidy
```

### 3. Run the generator (interactive wizard)

```bash
go run .
```

The wizard will guide you through **6 phases**:

| Phase | Description |
|-------|-------------|
| **1 — Project Identity** | Project slug (e.g. `my-app`) and display name |
| **2 — Database** | SQLite (embedded, recommended) or PostgreSQL |
| **3 — Configuration & Logging** | Env vars, TOML file, or both; log output destination and level |
| **4 — Window & UI** | Persist window state, system tray icon, React error boundaries |
| **5 — Optional Modules** | Excel export, decimal precision, background worker, auto-updater |
| **6 — Build & Versioning** | Pin Wails version, initialize a Git repository |

After completing the wizard, your project will be created in a new directory named after your project slug.

---

## Non-Interactive Mode (Presets)

Use the `-preset` flag to skip the wizard and generate a project from a built-in preset. Useful for CI/CD or quick testing.

```bash
# Preset A — SQLite + env vars + console logging, all optional modules OFF
go run . -preset a

# Preset B — PostgreSQL + full config + all optional modules ON
go run . -preset b

# Preset C — SQLite (beside exe) + TOML config + file logging + worker + decimal + tray + updater
go run . -preset c
```

---

## After Generation — Next Steps

Once the generator finishes, follow these steps inside your new project directory:

```bash
# 1. Enter the generated project
cd <your-project-slug>

# 2. Install Go dependencies
go mod tidy

# 3. Install frontend dependencies
cd frontend && npm install && cd ..

# 4. Verify your environment
wails3 doctor

# 5. Generate TypeScript bindings from Go backend
wails3 generate bindings

# 6. Start the development server
wails3 dev
```

---

## Generated Project Structure

```
<your-project-slug>/
├── main.go                             # Application entry point
├── wails.json                          # Wails configuration
├── Taskfile.yml                        # Task runner shortcuts
├── ARCHITECTURE.md                     # Architecture guide + how to add new domains
├── go.mod / go.sum
├── .env.example                        # (if env config selected)
├── config.toml / config.example.toml  # (if TOML config selected)
├── .gitignore                          # (if Git init selected)
│
├── backend/
│   ├── shared/
│   │   ├── config/config.go        # Configuration loader
│   │   ├── db/db.go                # Database connection
│   │   ├── db/migrator.go          # Migration runner
│   │   ├── logger/logger.go        # Structured slog logger
│   │   ├── errors.go               # Shared error types
│   │   ├── windowstate/            # (if window state selected)
│   │   ├── background/worker.go    # (if background worker selected)
│   │   └── types/decimal.go        # (if decimal selected)
│   ├── example/                    # Example domain (model, service, migrations)
│   ├── tray/                       # (if system tray selected)
│   ├── diagnostics/                # (if error boundaries selected)
│   ├── reports/excel.go            # (if Excel export selected)
│   └── updater/updater.go          # (if auto-updater selected)
│
└── frontend/
    ├── index.html
    ├── vite.config.ts
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── atoms/example.ts        # Jotai state atoms
        └── components/
            ├── ExampleList.tsx
            └── ErrorBoundary.tsx   # (if error boundaries selected)
```

---

## Configuration Options at a Glance

### Database
- **SQLite** — Pure Go, no CGO, embedded. Data stored in the OS standard path or beside the executable (portable mode).
- **PostgreSQL** — External server required. Configure host, port, user, password, and database name during the wizard.

### Configuration Strategy
- **env** — 12-factor style, zero extra dependencies.
- **toml** — File-based with [BurntSushi/toml](https://github.com/BurntSushi/toml).
- **both** — TOML base values with environment variable overrides (recommended).

### Logging
- **console** — Colorized output via `slog` + [tint](https://github.com/lmittmann/tint).
- **file** — Rolling log files via [lumberjack](https://github.com/natefinch/lumberjack) (10 MB, 3 backups, 30 days).
- **both** — Console and file simultaneously (recommended).

---

## Adding a New Domain

After generating your project, see **`ARCHITECTURE.md`** inside it for the step-by-step guide on adding new features following the same layered structure (model → service → migrations → frontend bindings).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `wails3: command not found` | Run `go install github.com/wailsapp/wails/v3/cmd/wails3@latest` and ensure `$GOPATH/bin` is in your `$PATH` |
| `./my-app already exists` | Choose a different project slug or delete the existing directory |
| `wails3 doctor` reports missing deps | Follow the OS-specific setup in the [Wails v3 docs](https://v3alpha.wails.io/) |
| Frontend build fails | Ensure Node.js ≥ 18 is installed and run `npm install` inside `frontend/` |

---

## License

This generator is provided as-is. See [LICENSE](LICENSE) if present.
