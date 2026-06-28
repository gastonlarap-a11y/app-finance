// Command generador is a single-file CLI wizard that scaffolds a production-ready,
// zero-configuration Wails v3 desktop application template. It ships as the entry
// point of a GitHub Template repository.
//
// It runs in one of two modes:
//
//   - Zero-touch in-place (default, `go run .`): infers the Go module path from the
//     repository's git remote, walks a 6-phase interactive wizard for the remaining
//     choices (powered by charm.land/huh/v2), writes the project into the repository
//     root (overwriting), then self-destructs — it deletes this generator and runs
//     `go mod tidy`, leaving a clean, independent Wails v3 app. A safety guard
//     refuses to run in the generator's own home repository.
//   - Preset (`go run . -preset a|b|c`): non-interactive; writes to ./<slug>/ for
//     development and testing. Never self-destructs.
//
// Writing is atomic in both modes: files are rendered into a staging dir first and
// only promoted to the destination once every template succeeds. All generated
// files are embedded as text/template strings.
//
// Run:  go run .                            (zero-touch, in the template-copied repo)
//
//	go run . -preset b                 (non-interactive, for testing)
//
// Template note: templates use [[ ]] delimiters (so JSX/CSS {{ }} never collide) and a
// [[bq]] func for backticks (Go raw-string literals cannot contain a backtick).
package main

import (
	"bufio"
	"encoding/base64"
	"flag"
	"fmt"
	"go/format"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"text/template"
	"time"

	"charm.land/huh/v2"
)

// ── Answers: raw values collected from the wizard ──────────────────────────────

type Answers struct {
	Slug        string
	DisplayName string
	ModulePath  string // FQDN Go module path; empty => derive from Slug (classic/preset)

	DBEngine   string // "sqlite" | "postgres"
	DBFilename string
	DataDir    string // "osstandard" | "besideexe"
	PGHost     string
	PGPort     string
	PGUser     string
	PGPassword string
	PGDatabase string

	ConfigStrategy string // "env" | "toml" | "both"
	LogDest        string // "console" | "file" | "both"
	LogLevel       string // "debug" | "info"

	WindowState   bool
	SystemTray    bool
	ErrorBoundary bool

	Excel   bool
	Decimal bool
	Worker  bool
	Updater bool

	PinWails     bool
	WailsVersion string
	GitInit      bool
}

func defaultAnswers() Answers {
	return Answers{
		Slug:           "my-wails-app",
		DBEngine:       "sqlite",
		DataDir:        "osstandard",
		PGHost:         "localhost",
		PGPort:         "5432",
		PGUser:         "postgres",
		PGDatabase:     "",
		ConfigStrategy: "both",
		LogDest:        "both",
		LogLevel:       "info",
		WindowState:    true,
		SystemTray:     false,
		ErrorBoundary:  true,
		Excel:          false,
		Decimal:        false,
		Worker:         true,
		Updater:        false,
		PinWails:       true,
		WailsVersion:   "v3.0.0-alpha.9",
		GitInit:        true,
	}
}

// ── TemplateData: everything every template can reference ──────────────────────

type TemplateData struct {
	// Phase 1
	ProjectSlug string
	DisplayName string
	ModulePath  string

	// Phase 2
	DBEngine   string
	IsSQLite   bool
	IsPostgres bool
	DBFilename string
	DataDir    string
	BesideExe  bool
	PGHost     string
	PGPort     string
	PGUser     string
	PGPassword string
	PGDatabase string

	// Phase 3
	ConfigStrategy string
	UseEnv         bool
	UseTOML        bool
	LogDest        string
	LogToConsole   bool
	LogToFile      bool
	LogLevel       string
	DebugMode      bool

	// Phase 4
	WindowState   bool
	SystemTray    bool
	ErrorBoundary bool

	// Phase 5
	Excel   bool
	Decimal bool
	Worker  bool
	Updater bool

	// Phase 6
	PinWails     bool
	WailsVersion string
	GitInit      bool

	// Meta
	GoVersion         string
	MigTS             string
	MigAmountSeq      string
	MigAppSettingsSeq string
	Year              int
}

func buildData(a Answers) TemplateData {
	d := TemplateData{
		ProjectSlug: a.Slug,
		DisplayName: firstNonEmpty(a.DisplayName, titleCase(a.Slug)),
		// ModulePath is the fully-qualified import path used by go.mod and every
		// internal import (e.g. github.com/owner/app-finance/backend/example). It is
		// inferred from the git remote in zero-touch mode; it falls back to the bare
		// slug for presets and the classic subdirectory flow.
		ModulePath:     firstNonEmpty(a.ModulePath, a.Slug),
		DBEngine:       a.DBEngine,
		IsSQLite:       a.DBEngine == "sqlite",
		IsPostgres:     a.DBEngine == "postgres",
		DBFilename:     firstNonEmpty(a.DBFilename, a.Slug+".db"),
		DataDir:        a.DataDir,
		BesideExe:      a.DataDir == "besideexe",
		PGHost:         firstNonEmpty(a.PGHost, "localhost"),
		PGPort:         firstNonEmpty(a.PGPort, "5432"),
		PGUser:         firstNonEmpty(a.PGUser, "postgres"),
		PGPassword:     a.PGPassword,
		PGDatabase:     firstNonEmpty(a.PGDatabase, underscore(a.Slug)),
		ConfigStrategy: a.ConfigStrategy,
		UseEnv:         a.ConfigStrategy == "env" || a.ConfigStrategy == "both",
		UseTOML:        a.ConfigStrategy == "toml" || a.ConfigStrategy == "both",
		LogDest:        a.LogDest,
		LogToConsole:   a.LogDest == "console" || a.LogDest == "both",
		LogToFile:      a.LogDest == "file" || a.LogDest == "both",
		LogLevel:       a.LogLevel,
		DebugMode:      a.LogLevel == "debug",
		WindowState:    a.WindowState,
		SystemTray:     a.SystemTray,
		ErrorBoundary:  a.ErrorBoundary,
		Excel:          a.Excel,
		Decimal:        a.Decimal,
		Worker:         a.Worker,
		Updater:        a.Updater,
		PinWails:       a.PinWails,
		GitInit:        a.GitInit,
		GoVersion:      "1.25",
		MigTS:          time.Now().Format("20060102"),
		Year:           time.Now().Year(),
	}
	if a.PinWails {
		d.WailsVersion = firstNonEmpty(a.WailsVersion, "v3.0.0-alpha.9")
	} else {
		d.WailsVersion = "latest"
	}
	// Migration sequence allocator: 001 example always; then, in fixed feature order,
	// allocate the next contiguous number only for active features.
	seq := 1
	if d.Decimal {
		seq++
		d.MigAmountSeq = fmt.Sprintf("%03d", seq)
	}
	if d.WindowState {
		seq++
		d.MigAppSettingsSeq = fmt.Sprintf("%03d", seq)
	}
	return d
}

// ── helpers ────────────────────────────────────────────────────────────────────

var slugRE = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func validateSlug(s string) error {
	if !slugRE.MatchString(s) {
		return fmt.Errorf("use lowercase letters, digits and single hyphens only (e.g. my-wails-app)")
	}
	return nil
}

func titleCase(slug string) string {
	parts := strings.Split(slug, "-")
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

func underscore(s string) string { return strings.ReplaceAll(s, "-", "_") }

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// ── environment inference (zero-touch in-place mode) ─────────────────────────────

// inferModulePath derives a fully-qualified Go module path from the "origin"
// remote of the repository in the current directory. It returns ("", false) when
// no usable remote is configured, so the caller can fall back to prompting.
func inferModulePath() (string, bool) {
	out, err := exec.Command("git", "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return "", false
	}
	return normalizeRemoteURL(string(out))
}

// normalizeRemoteURL converts a git remote URL into a bare Go module path
// (host/owner/repo) by stripping the scheme, any credentials, an optional port
// and the trailing ".git". It understands the three forms git emits:
//
//	https://github.com/owner/repo.git
//	ssh://git@github.com/owner/repo.git
//	git@github.com:owner/repo.git        (SCP-like; net/url cannot parse this)
//
// It returns ("", false) when the URL is empty or unparseable.
func normalizeRemoteURL(raw string) (string, bool) {
	raw = strings.TrimSuffix(strings.TrimSpace(raw), ".git")
	if raw == "" {
		return "", false
	}

	var host, repoPath string
	switch {
	case strings.Contains(raw, "://"):
		// Scheme-qualified URL: https, ssh, git, http.
		u, err := url.Parse(raw)
		if err != nil {
			return "", false
		}
		host = u.Hostname() // drops userinfo and port
		repoPath = u.Path
	case strings.Contains(raw, ":"):
		// SCP-like "[user@]host:owner/repo": split on the first colon.
		hostPart, p, _ := strings.Cut(raw, ":")
		if i := strings.LastIndex(hostPart, "@"); i >= 0 {
			hostPart = hostPart[i+1:] // drop "user@"
		}
		host, repoPath = hostPart, p
	default:
		return "", false
	}

	host = strings.TrimSpace(host)
	repoPath = strings.Trim(strings.TrimSpace(repoPath), "/")
	if host == "" || repoPath == "" {
		return "", false
	}
	return host + "/" + repoPath, true
}

// moduleDirective returns the module path declared by the go.mod at goModPath, or
// "" when it cannot be read. It is used to detect (and refuse) running the
// generator in its own source repository, where the on-disk module still matches
// the remote.
func moduleDirective(goModPath string) string {
	f, err := os.Open(goModPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "module "); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}

// deriveSlug reduces a module path's final element to the lowercase/hyphen
// alphabet validateSlug expects. It returns ("app", false) when nothing usable
// can be derived.
func deriveSlug(modulePath string) (string, bool) {
	base := strings.ToLower(path.Base(modulePath))
	base = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r == '-' || r == '_' || r == '.':
			return '-'
		default:
			return -1 // drop everything else
		}
	}, base)
	base = strings.Trim(strings.ReplaceAll(base, "--", "-"), "-")
	if validateSlug(base) != nil {
		return "app", false
	}
	return base, true
}

var modulePathRE = regexp.MustCompile(`^[a-z0-9.-]+\.[a-z]{2,}/[\w.\-/]+$`)

func validateModulePath(s string) error {
	if !modulePathRE.MatchString(strings.TrimSpace(s)) {
		return fmt.Errorf("expected a host/owner/repo path, e.g. github.com/acme/app-finance")
	}
	return nil
}

// promptModulePath asks for a module path when no git remote is available
// (local-only clones). It reuses the wizard's themed input.
func promptModulePath() (string, error) {
	var mp string
	err := runForm(huh.NewGroup(
		huh.NewInput().Title("Go module path").Placeholder("github.com/owner/app").
			Description("no git remote detected — enter the module path manually").
			Value(&mp).Validate(validateModulePath),
	))
	return strings.TrimSpace(mp), err
}

// removeSelf deletes the generator's own source file so the finished project no
// longer ships the wizard. Under `go run`, the program has already been compiled
// to a temporary binary, so removing the source mid-run is safe. The path comes
// from runtime.Caller, which makes this robust to renames.
func removeSelf() error {
	_, file, _, ok := runtime.Caller(0)
	if !ok || file == "" {
		file = "generador.go" // sensible fallback
	}
	if err := os.Remove(file); err != nil {
		return fmt.Errorf("remove generator source %q: %w", file, err)
	}
	return nil
}

// runGoModTidy resolves the freshly written imports. It is best-effort: an
// offline failure must not abort an otherwise-complete project, so it only warns.
// It must run AFTER removeSelf so tidy does not re-add the wizard's dependencies
// (charm.land/huh).
func runGoModTidy() {
	cmd := exec.Command("go", "mod", "tidy")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "warning: go mod tidy failed — run it manually:", err)
	}
}

// ── wizard (huh v2) ─────────────────────────────────────────────────────────────

const topBanner = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚀  Wails v3 App Generator
  Creates a production-ready desktop app template.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

const genBanner = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  Generating your project...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

func phaseHeader(s string) { fmt.Printf("\n── %s ──────────\n", s) }

func runForm(groups ...*huh.Group) error {
	// WithTheme wants the huh.Theme interface; ThemeFunc (func(isDark bool) *Styles)
	// satisfies it, so we pass the ThemeCharm function itself (not its result).
	return huh.NewForm(groups...).WithTheme(huh.ThemeFunc(huh.ThemeCharm)).Run()
}

func runWizard(a *Answers, skipIdentity bool) error {
	// PHASE 1 · PROJECT IDENTITY
	phaseHeader("PHASE 1 · PROJECT IDENTITY")
	if skipIdentity {
		// Identity was inferred from the git remote — show it instead of prompting.
		fmt.Printf("  Module:  %s\n  Project: %s\n", a.ModulePath, a.Slug)
	} else {
		if err := runForm(huh.NewGroup(
			huh.NewInput().Title("Project slug").Placeholder("my-wails-app").
				Description("lowercase, hyphens only — used for the directory and Go module").
				Value(&a.Slug).Validate(validateSlug),
		)); err != nil {
			return err
		}
		if err := runForm(huh.NewGroup(
			huh.NewInput().Title("Display name").Placeholder(titleCase(a.Slug)).
				Description("window title and docs header").Value(&a.DisplayName),
		)); err != nil {
			return err
		}
	}

	// PHASE 2 · DATABASE
	phaseHeader("PHASE 2 · DATABASE")
	if err := runForm(
		huh.NewGroup(
			huh.NewSelect[string]().Title("Database engine").Value(&a.DBEngine).Options(
				huh.NewOption("SQLite — pure Go, no CGO, embedded (recommended)", "sqlite"),
				huh.NewOption("PostgreSQL — external server required", "postgres"),
			),
		),
		huh.NewGroup(
			huh.NewInput().Title("Database filename").Placeholder(a.Slug+".db").
				Value(&a.DBFilename).Validate(func(s string) error {
				if s != "" && !strings.HasSuffix(s, ".db") {
					return fmt.Errorf("filename must end in .db")
				}
				return nil
			}),
			huh.NewSelect[string]().Title("App data directory").Value(&a.DataDir).Options(
				huh.NewOption("OS standard path (recommended)", "osstandard"),
				huh.NewOption("Beside executable (portable / USB)", "besideexe"),
			),
		).WithHideFunc(func() bool { return a.DBEngine != "sqlite" }),
		huh.NewGroup(
			huh.NewNote().Title("⚠  Files may be lost on app updates").
				Description("Portable installs store data next to the binary."),
		).WithHideFunc(func() bool { return a.DataDir != "besideexe" || a.DBEngine != "sqlite" }),
		huh.NewGroup(
			huh.NewInput().Title("Host").Placeholder("localhost").Value(&a.PGHost),
			huh.NewInput().Title("Port").Placeholder("5432").Value(&a.PGPort).Validate(func(s string) error {
				if s == "" {
					return nil
				}
				for _, r := range s {
					if r < '0' || r > '9' {
						return fmt.Errorf("port must be numeric")
					}
				}
				return nil
			}),
			huh.NewInput().Title("User").Placeholder("postgres").Value(&a.PGUser),
			huh.NewInput().Title("Password").EchoMode(huh.EchoModePassword).Value(&a.PGPassword),
			huh.NewInput().Title("Database name").Placeholder(underscore(a.Slug)).Value(&a.PGDatabase),
		).WithHideFunc(func() bool { return a.DBEngine != "postgres" }),
	); err != nil {
		return err
	}

	// PHASE 3 · CONFIGURATION & LOGGING
	phaseHeader("PHASE 3 · CONFIGURATION & LOGGING")
	if err := runForm(huh.NewGroup(
		huh.NewSelect[string]().Title("Configuration strategy").Value(&a.ConfigStrategy).Options(
			huh.NewOption("Environment variables only (12-factor, zero deps)", "env"),
			huh.NewOption("TOML config file (BurntSushi/toml)", "toml"),
			huh.NewOption("Both — TOML base + env overrides (recommended)", "both"),
		),
		huh.NewSelect[string]().Title("Log output destination").Value(&a.LogDest).Options(
			huh.NewOption("Console only (colorized via slog + tint)", "console"),
			huh.NewOption("Rolling file (lumberjack: 10MB, 3 backups, 30d)", "file"),
			huh.NewOption("Both (recommended)", "both"),
		),
		huh.NewSelect[string]().Title("Default log level in dev mode").Value(&a.LogLevel).Options(
			huh.NewOption("debug — verbose, shows all SQL via bun bundebug", "debug"),
			huh.NewOption("info — standard", "info"),
		),
	)); err != nil {
		return err
	}

	// PHASE 4 · WINDOW & UI
	phaseHeader("PHASE 4 · WINDOW & UI")
	if err := runForm(huh.NewGroup(
		huh.NewConfirm().Title("Persist window state between sessions?").
			Affirmative("Yes").Negative("No").Value(&a.WindowState),
		huh.NewConfirm().Title("System tray icon and menu?").
			Affirmative("Yes").Negative("No").Value(&a.SystemTray),
		huh.NewConfirm().Title("Frontend React error boundaries? (recommended)").
			Affirmative("Yes").Negative("No").Value(&a.ErrorBoundary),
	)); err != nil {
		return err
	}

	// PHASE 5 · OPTIONAL MODULES
	phaseHeader("PHASE 5 · OPTIONAL MODULES")
	if err := runForm(huh.NewGroup(
		huh.NewConfirm().Title("Excel report export? (xuri/excelize)").
			Affirmative("Yes").Negative("No").Value(&a.Excel),
		huh.NewConfirm().Title("Strict decimal / monetary precision? (shopspring/decimal)").
			Affirmative("Yes").Negative("No").Value(&a.Decimal),
		huh.NewConfirm().Title("Background task worker (goroutine pool)? (recommended)").
			Affirmative("Yes").Negative("No").Value(&a.Worker),
		huh.NewConfirm().Title("Auto-updater scaffold? (Wails v3 updater API)").
			Affirmative("Yes").Negative("No").Value(&a.Updater),
	)); err != nil {
		return err
	}

	// PHASE 6 · BUILD & VERSIONING
	phaseHeader("PHASE 6 · BUILD & VERSIONING")
	if err := runForm(
		huh.NewGroup(
			huh.NewNote().Title("⚠  Wails v3 is in alpha with nightly releases").
				Description("Pinning prevents go mod tidy from pulling a breaking nightly tomorrow."),
			huh.NewConfirm().Title("Pin Wails v3 to a specific version? (recommended)").
				Affirmative("Yes").Negative("No").Value(&a.PinWails),
		),
		huh.NewGroup(
			huh.NewInput().Title("Wails version tag").Placeholder("v3.0.0-alpha.9").Value(&a.WailsVersion),
		).WithHideFunc(func() bool { return !a.PinWails }),
		huh.NewGroup(
			huh.NewConfirm().Title("Git initialize?").
				Affirmative("Yes").Negative("No").Value(&a.GitInit),
		),
	); err != nil {
		return err
	}

	return nil
}

// ── built-in presets (non-interactive, for offline testing) ─────────────────────

func presetAnswers(name string) (Answers, error) {
	a := defaultAnswers()
	switch name {
	case "a": // SQLite + env + console, all optional modules off
		a.Slug = "preset-a"
		a.DBEngine = "sqlite"
		a.DataDir = "osstandard"
		a.ConfigStrategy = "env"
		a.LogDest = "console"
		a.LogLevel = "info"
		a.WindowState, a.SystemTray, a.ErrorBoundary = false, false, false
		a.Excel, a.Decimal, a.Worker, a.Updater = false, false, false, false
		a.GitInit = false
	case "b": // PostgreSQL + both config + both logging, every module on
		a.Slug = "preset-b"
		a.DBEngine = "postgres"
		a.PGPassword = "secret"
		a.ConfigStrategy = "both"
		a.LogDest = "both"
		a.LogLevel = "debug"
		a.WindowState, a.SystemTray, a.ErrorBoundary = true, true, true
		a.Excel, a.Decimal, a.Worker, a.Updater = true, true, true, true
		a.GitInit = false
	case "c": // SQLite + toml + file, worker+decimal+tray+updater
		a.Slug = "preset-c"
		a.DBEngine = "sqlite"
		a.DataDir = "besideexe"
		a.ConfigStrategy = "toml"
		a.LogDest = "file"
		a.LogLevel = "info"
		a.WindowState, a.SystemTray, a.ErrorBoundary = true, true, false
		a.Excel, a.Decimal, a.Worker, a.Updater = false, true, true, true
		a.GitInit = false
	default:
		return a, fmt.Errorf("unknown preset %q (use a|b|c)", name)
	}
	return a, nil
}

// ── file registry ───────────────────────────────────────────────────────────────

type genFile struct {
	Path   string // may contain [[ ]] template actions (e.g. migration timestamps)
	Tmpl   string // template body, or raw base64 when Binary
	When   func(TemplateData) bool
	Binary bool
}

func always(TemplateData) bool { return true }

func files() []genFile {
	return []genFile{
		// ── always ──
		{Path: "go.mod", Tmpl: tmplGoMod, When: always},
		{Path: "wails.json", Tmpl: tmplWailsJSON, When: always},
		{Path: "Taskfile.yml", Tmpl: tmplTaskfile, When: always},
		{Path: "ARCHITECTURE.md", Tmpl: tmplArchitecture, When: always},
		{Path: "main.go", Tmpl: tmplMainGo, When: always},
		{Path: "backend/shared/logger/logger.go", Tmpl: tmplLogger, When: always},
		{Path: "backend/shared/errors.go", Tmpl: tmplErrors, When: always},
		{Path: "backend/shared/config/config.go", Tmpl: tmplConfig, When: always},
		{Path: "backend/shared/db/db.go", Tmpl: tmplDB, When: always},
		{Path: "backend/shared/db/migrator.go", Tmpl: tmplMigrator, When: always},
		{Path: "backend/example/model.go", Tmpl: tmplExampleModel, When: always},
		{Path: "backend/example/result.go", Tmpl: tmplExampleResult, When: always},
		{Path: "backend/example/service.go", Tmpl: tmplExampleService, When: always},
		{Path: "backend/example/migrations/embed.go", Tmpl: tmplExampleEmbed, When: always},
		{Path: "backend/example/migrations/[[.MigTS]]001_create_example.up.sql", Tmpl: tmplCreateExampleUp, When: always},
		{Path: "backend/example/migrations/[[.MigTS]]001_create_example.down.sql", Tmpl: tmplCreateExampleDown, When: always},
		{Path: "frontend/index.html", Tmpl: tmplIndexHTML, When: always},
		{Path: "frontend/vite.config.ts", Tmpl: tmplViteConfig, When: always},
		{Path: "frontend/tsconfig.json", Tmpl: tmplTsconfig, When: always},
		{Path: "frontend/package.json", Tmpl: tmplPackageJSON, When: always},
		{Path: "frontend/src/main.tsx", Tmpl: tmplMainTsx, When: always},
		{Path: "frontend/src/App.tsx", Tmpl: tmplAppTsx, When: always},
		{Path: "frontend/src/index.css", Tmpl: tmplIndexCss, When: always},
		{Path: "frontend/src/atoms/example.ts", Tmpl: tmplAtomsExample, When: always},
		{Path: "frontend/src/components/ExampleList.tsx", Tmpl: tmplExampleListTsx, When: always},
		{Path: "frontend/dist/index.html", Tmpl: tmplDistPlaceholder, When: always},

		// ── Phase 3: config files ──
		{Path: ".env.example", Tmpl: tmplEnvExample, When: func(d TemplateData) bool { return d.UseEnv }},
		{Path: "config.toml", Tmpl: tmplConfigToml, When: func(d TemplateData) bool { return d.UseTOML }},
		{Path: "config.example.toml", Tmpl: tmplConfigExampleToml, When: func(d TemplateData) bool { return d.UseTOML }},

		// ── Phase 4 ──
		{Path: "backend/shared/windowstate/windowstate.go", Tmpl: tmplWindowstate, When: func(d TemplateData) bool { return d.WindowState }},
		{Path: "backend/shared/windowstate/migrations/embed.go", Tmpl: tmplWindowstateEmbed, When: func(d TemplateData) bool { return d.WindowState }},
		{Path: "backend/shared/windowstate/migrations/[[.MigTS]][[.MigAppSettingsSeq]]_create_app_settings.up.sql", Tmpl: tmplAppSettingsUp, When: func(d TemplateData) bool { return d.WindowState }},
		{Path: "backend/shared/windowstate/migrations/[[.MigTS]][[.MigAppSettingsSeq]]_create_app_settings.down.sql", Tmpl: tmplAppSettingsDown, When: func(d TemplateData) bool { return d.WindowState }},
		{Path: "backend/tray/tray.go", Tmpl: tmplTrayGo, When: func(d TemplateData) bool { return d.SystemTray }},
		{Path: "backend/tray/icon.png", Tmpl: trayIconPNGBase64, When: func(d TemplateData) bool { return d.SystemTray }, Binary: true},
		{Path: "backend/diagnostics/diagnostics.go", Tmpl: tmplDiagnostics, When: func(d TemplateData) bool { return d.ErrorBoundary }},
		{Path: "frontend/src/components/ErrorBoundary.tsx", Tmpl: tmplErrorBoundary, When: func(d TemplateData) bool { return d.ErrorBoundary }},

		// ── Phase 5 ──
		{Path: "backend/reports/excel.go", Tmpl: tmplExcel, When: func(d TemplateData) bool { return d.Excel }},
		{Path: "backend/shared/types/decimal.go", Tmpl: tmplDecimal, When: func(d TemplateData) bool { return d.Decimal }},
		{Path: "backend/example/migrations/[[.MigTS]][[.MigAmountSeq]]_add_example_amount.up.sql", Tmpl: tmplAddAmountUp, When: func(d TemplateData) bool { return d.Decimal }},
		{Path: "backend/example/migrations/[[.MigTS]][[.MigAmountSeq]]_add_example_amount.down.sql", Tmpl: tmplAddAmountDown, When: func(d TemplateData) bool { return d.Decimal }},
		{Path: "backend/shared/background/worker.go", Tmpl: tmplWorker, When: func(d TemplateData) bool { return d.Worker }},
		{Path: "backend/updater/updater.go", Tmpl: tmplUpdater, When: func(d TemplateData) bool { return d.Updater }},

		// ── Phase 6 ──
		{Path: ".gitignore", Tmpl: tmplGitignore, When: func(d TemplateData) bool { return d.GitInit }},
	}
}

// ── rendering & atomic write ─────────────────────────────────────────────────────

var funcMap = template.FuncMap{
	"bq":         func() string { return "`" },
	"fence":      func() string { return "```" },
	"title":      titleCase,
	"underscore": underscore,
	"lower":      strings.ToLower,
	"upper":      strings.ToUpper,
}

func render(name, tmpl string, d TemplateData) (string, error) {
	t, err := template.New(name).Delims("[[", "]]").Funcs(funcMap).Parse(tmpl)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	if err := t.Execute(&b, d); err != nil {
		return "", err
	}
	return b.String(), nil
}

// generate renders every active template into a hidden staging directory inside
// the current working directory, then promotes the result into dest. Rendering to
// a staging area first keeps the operation atomic: if any template fails, dest is
// never touched. Promotion overwrites existing files, which is what the in-place
// (dest == ".") zero-touch flow requires.
func generate(d TemplateData, dest string) error {
	staging, err := os.MkdirTemp(".", ".wails-gen-*")
	if err != nil {
		return fmt.Errorf("create staging dir: %w", err)
	}
	defer os.RemoveAll(staging) // on success its contents have already moved out

	for _, f := range files() {
		if f.When != nil && !f.When(d) {
			continue
		}
		rel, err := render("path:"+f.Path, f.Path, d)
		if err != nil {
			return fmt.Errorf("render path %q: %w", f.Path, err)
		}
		full := filepath.Join(staging, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}

		var data []byte
		switch {
		case f.Binary:
			b, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(f.Tmpl))
			if derr != nil {
				return fmt.Errorf("decode binary %q: %w", f.Path, derr)
			}
			data = b
		default:
			s, rerr := render(f.Path, f.Tmpl, d)
			if rerr != nil {
				return fmt.Errorf("render %q: %w", f.Path, rerr)
			}
			if strings.HasSuffix(rel, ".go") {
				formatted, ferr := format.Source([]byte(s))
				if ferr != nil {
					return fmt.Errorf("gofmt %q: %w", rel, ferr)
				}
				data = formatted
			} else {
				data = []byte(s)
			}
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			return err
		}
	}

	// Everything rendered cleanly — promote the staged tree into dest, overwriting.
	return promote(staging, dest)
}

// promote moves every file rendered under staging into dest, creating parent
// directories and overwriting existing files. staging and dest live on the same
// filesystem (both under the cwd), so os.Rename is atomic per file. Only leaf
// files are moved, so it is safe to rename out from under the WalkDir traversal.
func promote(staging, dest string) error {
	return filepath.WalkDir(staging, func(src string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(staging, src)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.Rename(src, target); err != nil {
			return fmt.Errorf("write %s: %w", target, err)
		}
		return nil
	})
}

func printChecklist(d TemplateData) {
	fmt.Printf(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  Project %q created!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Next steps:

  1.  cd %s
  2.  go mod tidy
  3.  cd frontend && npm install && cd ..
  4.  wails3 doctor              # verify your environment
  5.  wails3 generate bindings   # generate TypeScript bindings
  6.  wails3 dev                 # start coding 🚀

  To add a new domain:
    See ARCHITECTURE.md → "Adding a New Domain"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`, d.DisplayName, d.ProjectSlug)
}

func main() {
	preset := flag.String("preset", "", "generate from a built-in preset (a|b|c) into ./<slug> without the wizard")
	flag.Parse()

	// Classic/preset path: non-interactive, writes to ./<slug>, no self-destruct.
	// This is the generator's own development/testing flow inside the template repo.
	if *preset != "" {
		a, err := presetAnswers(*preset)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		runClassic(a)
		return
	}

	// Zero-touch in-place path: convert the current repository into the app.
	fmt.Println(topBanner)

	module, ok := inferModulePath()
	if !ok {
		m, err := promptModulePath()
		if err != nil {
			fmt.Fprintln(os.Stderr, "aborted:", err)
			os.Exit(1)
		}
		module = m
	}

	// Safety guard: refuse to convert the generator's own source repository. There,
	// the on-disk go.mod still declares the same module the remote points to, so a
	// run would overwrite the template and delete the generator.
	if moduleDirective("go.mod") == module {
		fmt.Fprintf(os.Stderr,
			"refusing to run in the generator's home repository (%s).\n"+
				"Create a new repo with \"Use this template\", then run `go run .` there.\n", module)
		os.Exit(1)
	}

	a := defaultAnswers()
	a.ModulePath = module
	if slug, ok := deriveSlug(module); ok {
		a.Slug = slug
	}

	if err := runWizard(&a, true); err != nil { // identity inferred -> skip prompts
		fmt.Fprintln(os.Stderr, "wizard aborted:", err)
		os.Exit(1)
	}
	if err := validateSlug(a.Slug); err != nil {
		fmt.Fprintln(os.Stderr, "invalid project slug:", err)
		os.Exit(1)
	}

	d := buildData(a)

	fmt.Println(genBanner)
	if err := generate(d, "."); err != nil {
		fmt.Fprintln(os.Stderr, "generation failed:", err)
		os.Exit(1)
	}

	// Self-destruct: drop the generator, then tidy the new module graph. Order
	// matters — removeSelf must run before tidy so the wizard's deps are dropped.
	if err := removeSelf(); err != nil {
		fmt.Fprintln(os.Stderr, "warning:", err)
	}
	runGoModTidy()

	printChecklist(d)
}

// runClassic is the pre-existing subdirectory flow used by presets: it validates
// the slug, refuses to clobber an existing directory, writes to ./<slug> and
// optionally runs `git init`. It never self-destructs.
func runClassic(a Answers) {
	if err := validateSlug(a.Slug); err != nil {
		fmt.Fprintln(os.Stderr, "invalid project slug:", err)
		os.Exit(1)
	}
	d := buildData(a)
	if _, err := os.Stat(d.ProjectSlug); err == nil {
		fmt.Fprintf(os.Stderr, "error: ./%s already exists — choose a different slug\n", d.ProjectSlug)
		os.Exit(1)
	}
	fmt.Println(genBanner)
	if err := generate(d, d.ProjectSlug); err != nil {
		fmt.Fprintln(os.Stderr, "generation failed:", err)
		os.Exit(1)
	}
	if d.GitInit {
		cmd := exec.Command("git", "init")
		cmd.Dir = d.ProjectSlug
		if err := cmd.Run(); err != nil {
			fmt.Fprintln(os.Stderr, "warning: git init failed:", err)
		}
	}
	printChecklist(d)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEMPLATE CONSTANTS  (appended below; [[ ]] delims, [[bq]] for backticks)
// ═══════════════════════════════════════════════════════════════════════════════

// Verified 16x16 RGBA PNG (solid indigo #6366f1), embedded for the system tray.
const trayIconPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mNITvv4nxLMMGrAqAGjBgwXAwDvarkfCpWrsAAAAABJRU5ErkJggg=="

const tmplGoMod = `module [[.ModulePath]]

go [[.GoVersion]]
[[if .PinWails]]
// Wails v3 is pinned (alpha — nightly releases may break). Edit and run go mod tidy to change.
require github.com/wailsapp/wails/v3 [[.WailsVersion]]
[[end]]
// All other dependencies are added by ` + "`go mod tidy`" + ` (it scans imports).
`

const tmplWailsJSON = `{
  "$schema": "https://wails.io/schemas/config.v3.json",
  "name": "[[.DisplayName]]",
  "outputfilename": "[[.ProjectSlug]]",
  "info": {
    "productName": "[[.DisplayName]]"
  },
  "frontend": {
    "dir": "frontend",
    "install": "npm install",
    "build": "npm run build",
    "dev": {
      "command": "npm run dev",
      "serverUrl": "auto"
    }
  }
}
`

const tmplTaskfile = `version: "3"

# Minimal Wails v3 task orchestration. Run ` + "`wails3 doctor`" + ` after generation;
# ` + "`wails3 init`" + ` can regenerate a fuller platform-specific Taskfile if needed.

tasks:
  install:frontend:
    dir: frontend
    cmds:
      - npm install

  build:frontend:
    dir: frontend
    cmds:
      - npm run build

  generate:bindings:
    cmds:
      - wails3 generate bindings

  dev:
    cmds:
      - wails3 dev

  build:
    deps: [build:frontend]
    cmds:
      - go build -o bin/[[.ProjectSlug]] .
`

const tmplGitignore = `# Binaries & build output
/bin/
/build/

# Local data & secrets
*.db
*.db-shm
*.db-wal
config.toml
.env

# Frontend
/frontend/dist/
/frontend/node_modules/
# bindings/ is auto-generated by ` + "`wails3 generate bindings`" + `
/frontend/bindings/

# Generator scratch
.wails-gen-*
`

// ----- group: backend-core -----

const tmplLogger = `package logger

import (
	"context"
	"log/slog"
	"os"
	"strings"
[[if .LogToConsole]]	"time"

	"github.com/lmittmann/tint"
[[end]][[if .LogToFile]]	"path/filepath"

	"gopkg.in/natefinch/lumberjack.v2"
[[end]])

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
[[if .LogToConsole]]	handlers = append(handlers, tint.NewHandler(os.Stderr, &tint.Options{
		Level:      lvl,
		TimeFormat: time.Kitchen,
	}))
[[end]][[if .LogToFile]]	_ = os.MkdirAll("logs", 0o755)
	fileWriter := &lumberjack.Logger{
		Filename:   filepath.Join("logs", "app.log"),
		MaxSize:    10, // MB
		MaxBackups: 3,
		MaxAge:     30, // days
		Compress:   true,
	}
	handlers = append(handlers, slog.NewJSONHandler(fileWriter, &slog.HandlerOptions{Level: lvl}))
[[end]]
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
`

const tmplErrors = `package shared

// AppError is a business-logic error returned inside a service Result.
// System errors (DB/file I/O) should be returned as native Go errors instead,
// which Wails v3 rejects the TypeScript Promise with.
type AppError struct {
	Code    string [[bq]]json:"code"[[bq]]
	Message string [[bq]]json:"message"[[bq]]
}

// Standard error codes — extend per project.
const (
	ErrNotFound   = "NOT_FOUND"
	ErrValidation = "VALIDATION_ERROR"
	ErrConflict   = "CONFLICT"
	ErrForbidden  = "FORBIDDEN"
	ErrInternal   = "INTERNAL_ERROR"
)

func NewError(code, message string) *AppError {
	return &AppError{Code: code, Message: message}
}

func (e *AppError) Error() string { return e.Code + ": " + e.Message }
`

const tmplConfig = `package config

import (
	"os"
[[if .IsSQLite]]	"path/filepath"
	"runtime"
[[end]][[if .UseTOML]]	"log/slog"

	"github.com/BurntSushi/toml"
[[end]])

// Config holds all runtime configuration. TOML tags are always present (they are
// inert when TOML is not used).
type Config struct {
	DisplayName string [[bq]]toml:"display_name"[[bq]]
	LogLevel    string [[bq]]toml:"log_level"[[bq]]
[[if .IsSQLite]]	DBFilename   string [[bq]]toml:"db_filename"[[bq]]
	DataStrategy string [[bq]]toml:"data_strategy"[[bq]] // "osstandard" | "besideexe"
[[else]]	DBHost     string [[bq]]toml:"db_host"[[bq]]
	DBPort     string [[bq]]toml:"db_port"[[bq]]
	DBUser     string [[bq]]toml:"db_user"[[bq]]
	DBPassword string [[bq]]toml:"db_password"[[bq]]
	DBName     string [[bq]]toml:"db_name"[[bq]]
[[end]][[if .Updater]]	UpdateEndpoint string [[bq]]toml:"update_endpoint"[[bq]]
[[end]]}

func defaults() Config {
	return Config{
		DisplayName: "[[.DisplayName]]",
		LogLevel:    "[[.LogLevel]]",
[[if .IsSQLite]]		DBFilename:   "[[.DBFilename]]",
		DataStrategy: "[[.DataDir]]",
[[else]]		DBHost:     "[[.PGHost]]",
		DBPort:     "[[.PGPort]]",
		DBUser:     "[[.PGUser]]",
		DBPassword: "[[.PGPassword]]",
		DBName:     "[[.PGDatabase]]",
[[end]][[if .Updater]]		UpdateEndpoint: "https://example.com/[[.ProjectSlug]]/latest.json",
[[end]]	}
}

// MustLoad loads configuration and never returns nil.
[[if .UseTOML]]// config.toml is the source of truth[[if .UseEnv]]; environment variables override individual keys[[end]].
[[else]]// Values come from environment variables with sane defaults (12-factor).
[[end]]func MustLoad() *Config {
	cfg := defaults()
[[if .UseTOML]]	if _, err := os.Stat("config.toml"); err == nil {
		if _, derr := toml.DecodeFile("config.toml", &cfg); derr != nil {
			slog.Error("failed to parse config.toml", "err", derr)
			os.Exit(1)
		}
	}
[[end]][[if .UseEnv]]	overrideFromEnv(&cfg)
[[end]]	return &cfg
}

[[if .UseEnv]]func overrideFromEnv(cfg *Config) {
	if v := os.Getenv("DISPLAY_NAME"); v != "" {
		cfg.DisplayName = v
	}
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
[[if .IsSQLite]]	if v := os.Getenv("DB_FILENAME"); v != "" {
		cfg.DBFilename = v
	}
	if v := os.Getenv("DATA_STRATEGY"); v != "" {
		cfg.DataStrategy = v
	}
[[else]]	if v := os.Getenv("DB_HOST"); v != "" {
		cfg.DBHost = v
	}
	if v := os.Getenv("DB_PORT"); v != "" {
		cfg.DBPort = v
	}
	if v := os.Getenv("DB_USER"); v != "" {
		cfg.DBUser = v
	}
	if v := os.Getenv("DB_PASSWORD"); v != "" {
		cfg.DBPassword = v
	}
	if v := os.Getenv("DB_NAME"); v != "" {
		cfg.DBName = v
	}
[[end]][[if .Updater]]	if v := os.Getenv("UPDATE_ENDPOINT"); v != "" {
		cfg.UpdateEndpoint = v
	}
[[end]]}
[[end]]
[[if .IsSQLite]]// DBPath returns the absolute path to the SQLite database file.
func (c *Config) DBPath() string {
	return filepath.Join(c.dataDir(), c.DBFilename)
}

func (c *Config) dataDir() string {
	if c.DataStrategy == "besideexe" {
		if exe, err := os.Executable(); err == nil {
			return filepath.Dir(exe)
		}
		return "."
	}
	return resolveDataDir(c.DisplayName)
}

// resolveDataDir matches what wails3 application.DataPath() returns, but is usable
// before the app starts (e.g. for migrations).
func resolveDataDir(displayName string) string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), displayName)
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", displayName)
	default: // linux and others
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".local", "share", displayName)
	}
}
[[else]]// DSN builds the PostgreSQL connection string from config.
func (c *Config) DSN() string {
	return "postgres://" + c.DBUser + ":" + c.DBPassword + "@" + c.DBHost + ":" + c.DBPort + "/" + c.DBName + "?sslmode=disable"
}
[[end]]`

const tmplDB = `package db

import (
	"database/sql"
[[if .IsSQLite]]	"log/slog"
	"os"
	"path/filepath"
[[end]]
	"github.com/uptrace/bun"
[[if .IsSQLite]]	"github.com/uptrace/bun/dialect/sqlitedialect"
	"github.com/uptrace/bun/driver/sqliteshim"
[[else]]	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/driver/pgdriver"
[[end]]	"github.com/uptrace/bun/extra/bundebug"

	"[[.ModulePath]]/backend/shared/config"
)

// MustConnect opens the database and configures bun. It exits the process on a
// hard connection failure (only ever called from main.go, never from a service).
func MustConnect(cfg *config.Config) *bun.DB {
[[if .IsSQLite]]	if err := os.MkdirAll(filepath.Dir(cfg.DBPath()), 0o755); err != nil {
		slog.Error("creating data dir failed", "err", err)
		os.Exit(1)
	}
	dsn := cfg.DBPath() + "?_journal=WAL&_timeout=5000&_foreign_keys=on"
	sqldb, err := sql.Open(sqliteshim.ShimName, dsn)
	if err != nil {
		slog.Error("db open failed", "err", err)
		os.Exit(1)
	}
	// SQLite: single writer, multiple readers.
	sqldb.SetMaxOpenConns(1)
	sqldb.SetMaxIdleConns(1)
	sqldb.SetConnMaxLifetime(0)

	bdb := bun.NewDB(sqldb, sqlitedialect.New())
[[else]]	connector := pgdriver.NewConnector(pgdriver.WithDSN(cfg.DSN()))
	sqldb := sql.OpenDB(connector)

	bdb := bun.NewDB(sqldb, pgdialect.New())
[[end]]	if cfg.LogLevel == "debug" {
		bdb.AddQueryHook(bundebug.NewQueryHook(bundebug.WithVerbose(true)))
	}
	return bdb
}
`

const tmplMigrator = `package db

import (
	"context"
	"embed"
	"fmt"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/migrate"

	examplemigrations "[[.ModulePath]]/backend/example/migrations"
[[if .WindowState]]	windowstatemigrations "[[.ModulePath]]/backend/shared/windowstate/migrations"
[[end]])

// RunMigrations discovers and applies every domain's SQL migrations.
// ADD a new domain's embed.FS to the slice below when you create a feature domain.
// The numeric prefix in each SQL filename determines execution order globally.
func RunMigrations(ctx context.Context, bdb *bun.DB) error {
	m := migrate.NewMigrations()

	for _, fsys := range []embed.FS{
		examplemigrations.Migrations,
[[if .WindowState]]		windowstatemigrations.Migrations,
[[end]]	} {
		if err := m.Discover(fsys); err != nil {
			return fmt.Errorf("discovering migrations: %w", err)
		}
	}

	migrator := migrate.NewMigrator(bdb, m)
	if err := migrator.Init(ctx); err != nil {
		return fmt.Errorf("init migrator: %w", err)
	}
	if _, err := migrator.Migrate(ctx); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	return nil
}
`

// ----- group: example-domain -----

const tmplExampleModel = `package example

import (
	"time"

	"github.com/uptrace/bun"
[[if .Decimal]]
	"[[.ModulePath]]/backend/shared/types"
[[end]])

// Item is the scaffold domain model. Copy this domain to add a new feature.
type Item struct {
	bun.BaseModel [[bq]]bun:"table:example,alias:e"[[bq]]

	ID        int64     [[bq]]bun:"id,pk,autoincrement" json:"id"[[bq]]
	Name      string    [[bq]]bun:"name,notnull" json:"name"[[bq]]
[[if .Decimal]]	Amount    types.Decimal [[bq]]bun:"amount,notnull" json:"amount"[[bq]] // string in JSON to avoid float precision loss
[[end]]	CreatedAt time.Time [[bq]]bun:"created_at,notnull,default:current_timestamp" json:"createdAt"[[bq]]
}
`

const tmplExampleResult = `package example

import "[[.ModulePath]]/backend/shared"

// Concrete Result types (no generics — safer for the Wails AST binding generator).
// Business errors resolve the JS promise with Error set; system errors are returned
// as a native Go error instead, which rejects the promise.
type ExampleResult struct {
	Data  *Item            [[bq]]json:"data,omitempty"[[bq]]
	Error *shared.AppError [[bq]]json:"error,omitempty"[[bq]]
}

type ExampleListResult struct {
	Data  []Item           [[bq]]json:"data"[[bq]]
	Error *shared.AppError [[bq]]json:"error,omitempty"[[bq]]
}
`

const tmplExampleService = `package example

import (
	"context"

	"github.com/uptrace/bun"
[[if .Worker]]	"github.com/wailsapp/wails/v3/pkg/application"

	"[[.ModulePath]]/backend/shared/background"
[[end]]
	"[[.ModulePath]]/backend/shared"
[[if .Decimal]]	"[[.ModulePath]]/backend/shared/types"
[[end]])

// ExampleService is an autonomous Wails v3 service. Public methods are auto-bound
// to TypeScript by ` + "`wails3 generate bindings`" + `.
type ExampleService struct {
	db *bun.DB
[[if .Worker]]	worker *background.Worker
[[end]]}

func NewExampleService(db *bun.DB[[if .Worker]], w *background.Worker[[end]]) *ExampleService {
	return &ExampleService{db: db[[if .Worker]], worker: w[[end]]}
}

func (s *ExampleService) ServiceName() string { return "ExampleService" }

[[if .Worker]]// ServiceStartup is called once by Wails when the app starts.
func (s *ExampleService) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	if s.worker != nil {
		s.worker.Start(ctx, 2) // 2 concurrent goroutines
	}
	return nil
}

// ServiceShutdown is called once by Wails when the app closes.
func (s *ExampleService) ServiceShutdown() error {
	if s.worker != nil {
		s.worker.Stop() // drains in-flight tasks
	}
	return nil
}

[[end]]// GetItems returns all items, newest first. A returned error rejects the JS promise.
func (s *ExampleService) GetItems(ctx context.Context) ([]Item, error) {
	var items []Item
	err := s.db.NewSelect().Model(&items).OrderExpr("created_at DESC").Scan(ctx)
	return items, err
}

// CreateItem inserts an item. Validation failures resolve via the Result, not an error.
func (s *ExampleService) CreateItem(ctx context.Context, name string[[if .Decimal]], amount string[[end]]) ExampleResult {
	if name == "" {
		return ExampleResult{Error: shared.NewError(shared.ErrValidation, "name is required")}
	}
	item := &Item{Name: name}
[[if .Decimal]]	amt, err := types.New(amount)
	if err != nil {
		return ExampleResult{Error: shared.NewError(shared.ErrValidation, "amount is not a valid decimal")}
	}
	item.Amount = amt
[[end]]	if _, err := s.db.NewInsert().Model(item).Returning("*").Exec(ctx); err != nil {
		return ExampleResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	return ExampleResult{Data: item}
}
`

const tmplExampleEmbed = `package migrations

import "embed"

//go:embed *.sql
var Migrations embed.FS
`

const tmplCreateExampleUp = `[[if .IsSQLite]]CREATE TABLE IF NOT EXISTS example (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
[[else]]CREATE TABLE IF NOT EXISTS example (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
[[end]]`

const tmplCreateExampleDown = `DROP TABLE IF EXISTS example;
`

// ----- group: optional-modules -----

const tmplWorker = `package background

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
`

const tmplWindowstate = `package windowstate

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/uptrace/bun"
)

// State is the persisted window geometry.
type State struct {
	X, Y, W, H int
	Maximized  bool
}

func defaultState() State { return State{X: 100, Y: 100, W: 1200, H: 800} }

// appSetting is a tiny key/value row in the shared app_settings table.
type appSetting struct {
	bun.BaseModel [[bq]]bun:"table:app_settings,alias:s"[[bq]]

	Key   string [[bq]]bun:"key,pk"[[bq]]
	Value string [[bq]]bun:"value,notnull"[[bq]]
}

const stateKey = "window_state"

// Load returns the saved window state, falling back to sensible defaults on any error.
func Load(ctx context.Context, db *bun.DB) State {
	st := defaultState()
	var row appSetting
	if err := db.NewSelect().Model(&row).Where("key = ?", stateKey).Scan(ctx); err != nil {
		return st
	}
	var loaded State
	if err := json.Unmarshal([]byte(row.Value), &loaded); err != nil {
		slog.Warn("windowstate: corrupt value, using defaults", "err", err)
		return st
	}
	if loaded.W <= 0 || loaded.H <= 0 {
		return st
	}
	return loaded
}

// Save upserts the window state. Call it on the WindowClosing event.
func Save(ctx context.Context, db *bun.DB, s State) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	row := appSetting{Key: stateKey, Value: string(data)}
	_, err = db.NewInsert().Model(&row).
		On("CONFLICT (key) DO UPDATE").
		Set("value = EXCLUDED.value").
		Exec(ctx)
	return err
}
`

const tmplWindowstateEmbed = tmplExampleEmbed

const tmplAppSettingsUp = `CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`

const tmplAppSettingsDown = `DROP TABLE IF EXISTS app_settings;
`

const tmplTrayGo = `package tray

import (
	_ "embed"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed icon.png
var iconData []byte

// Setup wires the system tray icon and menu. Inject the app and the main window.
func Setup(app *application.App, window *application.WebviewWindow) {
	tray := app.NewSystemTray()
	tray.SetIcon(iconData)
	tray.SetLabel("[[.DisplayName]]")

	toggle := func() {
		if window.IsVisible() {
			window.Hide()
		} else {
			window.Show()
			window.Focus()
		}
	}

	tray.OnClick(toggle)

	menu := app.NewMenu()
	menu.Add("Show / Hide").OnClick(func(_ *application.Context) { toggle() })
	menu.AddSeparator()
	menu.Add("Quit").OnClick(func(_ *application.Context) { app.Quit() })
	tray.SetMenu(menu)
}
`

const tmplDiagnostics = `package diagnostics

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
`

const tmplExcel = `package reports

import (
	"context"
	"sort"

	"github.com/xuri/excelize/v2"
)

// ReportsService exports tabular data to .xlsx and returns the raw bytes. The
// frontend turns the bytes into a Blob + URL.createObjectURL to trigger a download.
type ReportsService struct{}

func NewReportsService() *ReportsService { return &ReportsService{} }

func (s *ReportsService) ServiceName() string { return "ReportsService" }

func (s *ReportsService) ExportToExcel(ctx context.Context, rows []map[string]any, sheet string) ([]byte, error) {
	if sheet == "" {
		sheet = "Sheet1"
	}
	f := excelize.NewFile()
	defer f.Close()
	if sheet != "Sheet1" {
		_ = f.SetSheetName("Sheet1", sheet)
	}

	if len(rows) > 0 {
		headers := make([]string, 0, len(rows[0]))
		for k := range rows[0] {
			headers = append(headers, k)
		}
		sort.Strings(headers)
		for c, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(c+1, 1)
			_ = f.SetCellValue(sheet, cell, h)
		}
		for r, row := range rows {
			for c, h := range headers {
				cell, _ := excelize.CoordinatesToCellName(c+1, r+2)
				_ = f.SetCellValue(sheet, cell, row[h])
			}
		}
	}

	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
`

const tmplDecimal = `package types

import (
	"database/sql/driver"
	"fmt"
	"strings"

	"github.com/shopspring/decimal"
)

// Decimal wraps shopspring/decimal for safe monetary values.
//   - Stored/scanned transparently as TEXT (SQLite) / NUMERIC (PostgreSQL) by bun.
//   - Marshalled to JSON as a string (never a float) to avoid JS precision loss.
type Decimal struct {
	decimal.Decimal
}

func New(value string) (Decimal, error) {
	d, err := decimal.NewFromString(value)
	return Decimal{d}, err
}

func FromInt(v int64) Decimal { return Decimal{decimal.NewFromInt(v)} }

// Value implements driver.Valuer — stored as a string.
func (d Decimal) Value() (driver.Value, error) {
	return d.Decimal.String(), nil
}

// Scan implements sql.Scanner.
func (d *Decimal) Scan(value any) error {
	switch v := value.(type) {
	case nil:
		d.Decimal = decimal.Zero
	case string:
		dec, err := decimal.NewFromString(v)
		if err != nil {
			return err
		}
		d.Decimal = dec
	case []byte:
		dec, err := decimal.NewFromString(string(v))
		if err != nil {
			return err
		}
		d.Decimal = dec
	case float64:
		d.Decimal = decimal.NewFromFloat(v)
	case int64:
		d.Decimal = decimal.NewFromInt(v)
	default:
		return fmt.Errorf("decimal: cannot scan %T", value)
	}
	return nil
}

// MarshalJSON renders as a quoted string.
func (d Decimal) MarshalJSON() ([]byte, error) {
	return []byte("\"" + d.Decimal.String() + "\""), nil
}

func (d *Decimal) UnmarshalJSON(data []byte) error {
	dec, err := decimal.NewFromString(strings.Trim(string(data), "\""))
	if err != nil {
		return err
	}
	d.Decimal = dec
	return nil
}
`

const tmplAddAmountUp = `[[if .IsSQLite]]ALTER TABLE example ADD COLUMN amount TEXT NOT NULL DEFAULT '0';
[[else]]ALTER TABLE example ADD COLUMN amount NUMERIC NOT NULL DEFAULT 0;
[[end]]`

const tmplAddAmountDown = `ALTER TABLE example DROP COLUMN amount;
`

const tmplUpdater = `package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// CurrentVersion is this build's version. Wire it to your build/version stamp.
const CurrentVersion = "0.1.0"

// UpdateResult is returned to the frontend.
type UpdateResult struct {
	Available      bool   [[bq]]json:"available"[[bq]]
	CurrentVersion string [[bq]]json:"currentVersion"[[bq]]
	LatestVersion  string [[bq]]json:"latestVersion"[[bq]]
	DownloadURL    string [[bq]]json:"downloadUrl,omitempty"[[bq]]
	Error          string [[bq]]json:"error,omitempty"[[bq]]
}

type manifest struct {
	Version string [[bq]]json:"version"[[bq]]
	URL     string [[bq]]json:"url"[[bq]]
}

// UpdaterService is a scaffold: it fetches a JSON manifest from the configured
// endpoint and compares semver. Swap in github.com/wailsapp/wails/v3/pkg/updater
// providers for binary delivery when you are ready.
type UpdaterService struct {
	endpoint string
}

func NewUpdaterService(endpoint string) *UpdaterService {
	return &UpdaterService{endpoint: endpoint}
}

func (s *UpdaterService) ServiceName() string { return "UpdaterService" }

func (s *UpdaterService) CheckForUpdates(ctx context.Context) UpdateResult {
	res := UpdateResult{CurrentVersion: CurrentVersion}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint, nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer resp.Body.Close()

	var m manifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		res.Error = err.Error()
		return res
	}
	res.LatestVersion = m.Version
	res.DownloadURL = m.URL
	res.Available = compareSemver(m.Version, CurrentVersion) > 0
	return res
}

// compareSemver returns 1 if a>b, -1 if a<b, 0 if equal (pre-release tags ignored).
func compareSemver(a, b string) int {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		switch {
		case pa[i] > pb[i]:
			return 1
		case pa[i] < pb[i]:
			return -1
		}
	}
	return 0
}

func parseSemver(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		if i > 2 {
			break
		}
		n, _ := strconv.Atoi(part)
		out[i] = n
	}
	return out
}
`

// ----- group: main-and-frontend -----

const tmplMainGo = `package main

import (
	"context"
	"embed"
	"log/slog"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
[[if .WindowState]]	"github.com/wailsapp/wails/v3/pkg/events"
[[end]]
	"[[.ModulePath]]/backend/example"
	"[[.ModulePath]]/backend/shared/config"
	"[[.ModulePath]]/backend/shared/db"
	"[[.ModulePath]]/backend/shared/logger"
[[if .Worker]]	"[[.ModulePath]]/backend/shared/background"
[[end]][[if .WindowState]]	"[[.ModulePath]]/backend/shared/windowstate"
[[end]][[if .ErrorBoundary]]	"[[.ModulePath]]/backend/diagnostics"
[[end]][[if .Excel]]	"[[.ModulePath]]/backend/reports"
[[end]][[if .Updater]]	"[[.ModulePath]]/backend/updater"
[[end]][[if .SystemTray]]	"[[.ModulePath]]/backend/tray"
[[end]])

// Placeholder dist is generated so this embed compiles before the first
// ` + "`cd frontend && npm run build`" + `. Wails serves the vite dev server in ` + "`wails3 dev`" + `.
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

[[if .Worker]]	worker := background.New(50) // task buffer
[[end]]	exampleSvc := example.NewExampleService(bdb[[if .Worker]], worker[[end]])

	services := []application.Service{
		application.NewService(exampleSvc),
[[if .ErrorBoundary]]		application.NewService(diagnostics.NewDiagnosticsService()),
[[end]][[if .Excel]]		application.NewService(reports.NewReportsService()),
[[end]][[if .Updater]]		application.NewService(updater.NewUpdaterService(cfg.UpdateEndpoint)),
[[end]]		// add new services here as you create new domains
	}

	app := application.New(application.Options{
		Name:     cfg.DisplayName,
		LogLevel: slog.LevelInfo,
		Services: services,
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

[[if or .WindowState .SystemTray]][[if .WindowState]]	st := windowstate.Load(context.Background(), bdb)
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
[[else]]	window := app.NewWebviewWindowWithOptions(application.WebviewWindowOptions{
		Title:  cfg.DisplayName,
		Width:  1200,
		Height: 800,
	})
[[end]][[if .SystemTray]]	tray.Setup(app, window)
[[end]][[else]]	app.NewWebviewWindowWithOptions(application.WebviewWindowOptions{
		Title:  cfg.DisplayName,
		Width:  1200,
		Height: 800,
	})
[[end]]
	if err := app.Run(); err != nil {
		slog.Error("app exited with error", "err", err)
		os.Exit(1)
	}
}
`

const tmplDistPlaceholder = `<!doctype html>
<!-- Placeholder so //go:embed all:frontend/dist compiles before the first build. -->
<!-- Overwritten by: cd frontend && npm run build -->
<html lang="en">
  <head><meta charset="UTF-8" /><title>[[.DisplayName]]</title></head>
  <body>Run <code>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</code>.</body>
</html>
`

const tmplIndexHTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>[[.DisplayName]]</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const tmplViteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  }
})
`

const tmplTsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "skipLibCheck": true
  },
  "include": ["src"]
}
`

const tmplPackageJSON = `{
  "name": "[[.ProjectSlug]]",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "jotai": "^2.10.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^6.0.0",
    "tailwindcss": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^8.0.0"
  }
}
`

const tmplIndexCss = `@import "tailwindcss";

@theme {
  --color-primary: #6366f1;
  --color-primary-dark: #4f46e5;
  --color-surface: #0f172a;
  --color-surface-alt: #1e293b;
  --font-sans: 'Inter', system-ui, sans-serif;
  --radius-base: 0.5rem;
}

body {
  background-color: var(--color-surface);
  font-family: var(--font-sans);
}
`

const tmplMainTsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App'
import '@/index.css'
[[if .ErrorBoundary]]import { ErrorBoundary } from '@/components/ErrorBoundary'
[[end]]
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
[[if .ErrorBoundary]]    <ErrorBoundary>
      <App />
    </ErrorBoundary>
[[else]]    <App />
[[end]]  </React.StrictMode>
)
`

const tmplAppTsx = `import { ExampleList } from '@/components/ExampleList'

function App() {
  return (
    <div className="min-h-screen bg-surface text-slate-100 p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-primary">[[.DisplayName]]</h1>
        <p className="text-slate-400">Wails v3 · React 19 · Tailwind v4 starter</p>
      </header>
      <main>
        <ExampleList />
      </main>
    </div>
  )
}

export default App
`

const tmplAtomsExample = `import { atom } from 'jotai'

export interface Item {
  id: number
  name: string
[[if .Decimal]]  // amount is a string to avoid JS float precision loss
  amount: string
[[end]]  createdAt: string
}

export const itemsAtom = atom<Item[]>([])
`

const tmplExampleListTsx = `import { useState } from 'react'
import { useAtom } from 'jotai'
import { itemsAtom, type Item } from '@/atoms/example'

// After running ` + "`wails3 generate bindings`" + `, wrap the generated service in ONE module
// and import it here — never import from bindings/ directly across the app:
//   import { ExampleService } from '@/../bindings/[[.ModulePath]]/backend/example'
//   const items = await ExampleService.GetItems()

export function ExampleList() {
  const [items] = useAtom(itemsAtom)
  const [name, setName] = useState('')

  return (
    <div className="rounded-base bg-surface-alt p-6">
      <h2 className="text-xl font-semibold mb-4">Items</h2>
      <ul className="space-y-2">
        {items.length === 0 && (
          <li className="text-slate-500">No items yet — wire up ExampleService after generating bindings.</li>
        )}
        {items.map((it: Item) => (
          <li key={it.id} className="flex justify-between border-b border-slate-700 pb-1">
            <span>{it.name}</span>
[[if .Decimal]]            <span className="text-primary">{it.amount}</span>
[[end]]          </li>
        ))}
      </ul>
      <div className="mt-4 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New item"
          className="flex-1 rounded bg-surface px-3 py-2 outline-none"
        />
        <button className="rounded bg-primary px-4 py-2 font-medium">Add</button>
      </div>
    </div>
  )
}
`

const tmplErrorBoundary = `import React from 'react'

// After ` + "`wails3 generate bindings`" + `, report errors to Go:
//   import { DiagnosticsService } from '@/../bindings/[[.ModulePath]]/backend/diagnostics'

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
`

const tmplEnvExample = `# Environment configuration for [[.DisplayName]]
# Copy to .env (gitignored) and adjust. [[if .UseTOML]]These override config.toml keys.[[end]]

DISPLAY_NAME=[[.DisplayName]]
LOG_LEVEL=[[.LogLevel]]
[[if .IsSQLite]]DB_FILENAME=[[.DBFilename]]
DATA_STRATEGY=[[.DataDir]]
[[else]]DB_HOST=[[.PGHost]]
DB_PORT=[[.PGPort]]
DB_USER=[[.PGUser]]
DB_PASSWORD=[[.PGPassword]]
DB_NAME=[[.PGDatabase]]
[[end]][[if .Updater]]UPDATE_ENDPOINT=https://example.com/[[.ProjectSlug]]/latest.json
[[end]]`

const tmplConfigToml = `# Configuration for [[.DisplayName]]
display_name = "[[.DisplayName]]"
log_level = "[[.LogLevel]]"
[[if .IsSQLite]]db_filename = "[[.DBFilename]]"
data_strategy = "[[.DataDir]]" # "osstandard" | "besideexe"
[[else]]db_host = "[[.PGHost]]"
db_port = "[[.PGPort]]"
db_user = "[[.PGUser]]"
db_password = "[[.PGPassword]]"
db_name = "[[.PGDatabase]]"
[[end]][[if .Updater]]update_endpoint = "https://example.com/[[.ProjectSlug]]/latest.json"
[[end]]`

const tmplConfigExampleToml = tmplConfigToml

// ----- group: docs -----

const tmplArchitecture = `# [[.DisplayName]] — Architecture

## 1. Project Overview

[[.DisplayName]] is a Wails v3 desktop application generated from a zero-config template.

Stack:
- Go [[.GoVersion]]+ · Wails v3 (Service Pattern)
- bun ORM + bun/migrate ([[if .IsSQLite]]SQLite via modernc.org/sqlite — pure Go, no CGO[[else]]PostgreSQL via pgdriver[[end]])
- React 19 + Jotai + Tailwind CSS v4 (CSS-first, no JS config) + Vite
- slog structured logging[[if .LogToConsole]] (console via tint)[[end]][[if .LogToFile]] (rolling file via lumberjack)[[end]]

## 2. ⚠ Wails v3 Status

This project targets **Wails v3** (alpha as of June 2026). The API is stable and
applications run in production, but nightly releases may introduce breaking changes.

**This template pins Wails to:** [[bq]][[.WailsVersion]][[bq]]
To upgrade: edit go.mod and run [[bq]]go mod tidy[[bq]], then test with [[bq]]wails3 doctor[[bq]].

Requirements: Go [[.GoVersion]]+, Node.js 20+. Run [[bq]]wails3 doctor[[bq]] to verify.

- v2 docs: https://wails.io
- v3 docs: https://v3.wails.io

## 3. Service Pattern

Every domain is an autonomous Service. There is no [[bq]]app.go[[bq]] god object —
[[bq]]main.go[[bq]] is the only orchestration point. A service:
- has a constructor that receives its dependencies (e.g. [[bq]]*bun.DB[[bq]]),
- exposes [[bq]]ServiceName() string[[bq]],
- optionally implements [[bq]]ServiceStartup(ctx, application.ServiceOptions) error[[bq]]
  and [[bq]]ServiceShutdown() error[[bq]] for lifecycle,
- exposes public methods that are auto-bound to TypeScript.

See [[bq]]backend/example/service.go[[bq]] for the reference implementation.

## 4. Migration Strategy

Migrations are SQL files embedded with [[bq]]go:embed[[bq]] and run by bun/migrate on
startup ([[bq]]backend/shared/db/migrator.go[[bq]]). The numeric filename prefix sets
global order. This template ships:

- [[bq]][[.MigTS]]001_create_example.{up,down}.sql[[bq]] (always)
[[if .Decimal]]- [[bq]][[.MigTS]][[.MigAmountSeq]]_add_example_amount.{up,down}.sql[[bq]] (decimal)
[[end]][[if .WindowState]]- [[bq]][[.MigTS]][[.MigAppSettingsSeq]]_create_app_settings.{up,down}.sql[[bq]] (window state)
[[end]]
SQLite note: [[bq]]ALTER TABLE ... ADD COLUMN[[bq]] is supported, but changing or
dropping a column's type is not — write a new table + copy migration instead.

## 5. Configuration

[[if .UseTOML]]config.toml is the source of truth.[[if .UseEnv]] Environment variables override individual keys at runtime (useful for CI/testing).[[end]]
Edit [[bq]]config.toml[[bq]] (gitignored) — copy from [[bq]]config.example.toml[[bq]].
[[else]]Configuration comes from environment variables with sane defaults (12-factor).
Copy [[bq]].env.example[[bq]] to [[bq]].env[[bq]] and adjust.
[[end]]Loader: [[bq]]backend/shared/config/config.go[[bq]].

## 6. Error Handling

- **System errors** (DB/file I/O): return a native Go [[bq]]error[[bq]] → Wails rejects
  the TypeScript promise.
- **Business errors** (validation, not-found, conflict): return a concrete Result
  struct with [[bq]]*shared.AppError[[bq]] set → the promise resolves; the frontend
  checks [[bq]]result.error[[bq]]. Codes live in [[bq]]backend/shared/errors.go[[bq]].

## 7. Logging

slog is configured in [[bq]]backend/shared/logger/logger.go[[bq]] and installed via
[[bq]]slog.SetDefault[[bq]]. Change the level at runtime with the [[bq]]LOG_LEVEL[[bq]]
config key ([[bq]]debug[[bq]] | [[bq]]info[[bq]] | [[bq]]warn[[bq]] | [[bq]]error[[bq]]).
In debug mode, bun's [[bq]]bundebug[[bq]] hook logs every SQL statement.

## 8. Window State
[[if .WindowState]]
Stored as JSON in the [[bq]]app_settings[[bq]] KV table (same DB), read before the
window opens and written on [[bq]]WindowClosing[[bq]]. See
[[bq]]backend/shared/windowstate/[[bq]]. To reset: delete the [[bq]]window_state[[bq]]
row, e.g. [[bq]]DELETE FROM app_settings WHERE key = 'window_state';[[bq]].
[[else]]
Window-state persistence was not enabled for this project.
[[end]]
## 9. Background Worker
[[if .Worker]]
[[bq]]backend/shared/background/worker.go[[bq]] is a generic goroutine pool. Inject it
into a service and start/stop it from [[bq]]ServiceStartup[[bq]]/[[bq]]ServiceShutdown[[bq]]
(see ExampleService). Enqueue work with [[bq]]worker.Enqueue(func(ctx) error { ... })[[bq]].
[[else]]
The background worker was not enabled for this project.
[[end]]
## 10. Adding a New Domain

[[fence]]
1. mkdir backend/{domain}
2. Create model.go, result.go, service.go
3. Create migrations/ folder with embed.go and .up.sql/.down.sql
4. Register embed.FS in backend/shared/db/migrator.go
5. Register service in main.go Services slice
6. Run: wails3 generate bindings
7. Import the new binding in frontend/src/ (wrap it in one module)
[[fence]]

## 11. Frontend Bindings

Never import from [[bq]]frontend/bindings/[[bq]] directly across the app — it is
auto-generated by [[bq]]wails3 generate bindings[[bq]] (and gitignored). Wrap each
service in a single module and import that everywhere.
[[if .Decimal]]
## 12. Decimal Precision

JavaScript numbers are IEEE-754 floats and silently lose precision on money
(e.g. 0.1 + 0.2). This template uses [[bq]]backend/shared/types.Decimal[[bq]]
(wrapping shopspring/decimal): stored as [[if .IsSQLite]]TEXT[[else]]NUMERIC[[end]],
marshalled to JSON as a **string**. The frontend keeps [[bq]]amount[[bq]] as a string
and formats with [[bq]]Intl.NumberFormat[[bq]] — never [[bq]]parseFloat[[bq]] for math.
[[end]]
`

// ----- end templates -----
