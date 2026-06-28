# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A single-file Go CLI tool (`generador.go`) that scaffolds production-ready Wails v3 desktop applications through an interactive TUI wizard. The generator itself has no frontend — it *produces* projects that have one. It ships as the entry point of a **GitHub Template repository**: you click *"Use this template"*, then `go run .` in the new repo converts it in place.

## Two run modes

- **Zero-touch in-place** (default `go run .`): infers the Go module path from `git config --get remote.origin.url`, runs the wizard for everything except project identity (which is inferred), writes the project into the **repository root** (overwriting), then **self-destructs** — deletes `generador.go` and runs `go mod tidy`. A safety guard aborts when the inferred module equals the `module` directive already in `./go.mod` (i.e. running in the generator's own home repo).
- **Preset** (`go run . -preset a|b|c`): non-interactive; writes to `./<slug>/` for development/testing. No inference, no self-destruct.

## Commands

```bash
go run .              # zero-touch in-place (run this in a template-copied repo, not here)
go run . -preset a    # non-interactive → ./preset-a/ (SQLite + env + console, no optional modules)
go run . -preset b    # non-interactive → ./preset-b/ (PostgreSQL + all modules on)
go run . -preset c    # non-interactive → ./preset-c/ (SQLite portable + TOML + file log + most modules)
go mod tidy           # sync dependencies
go build .            # verify the generator compiles
```

Presets write output directories (`preset-a/`, etc.) into the working directory. Clean up with `rm -rf preset-a preset-b preset-c`. Running plain `go run .` *in this repo* is a no-op: the safety guard aborts because this is the generator's home repository.

There is no Makefile, test suite, or lint configuration in this repo.

## Architecture

Everything lives in `generador.go` (~2100 lines). Reading order:

| Section | Purpose |
|---|---|
| `Answers` struct | Raw values collected from the TUI wizard (incl. `ModulePath`) |
| `TemplateData` struct | Derived, template-ready booleans/strings built by `buildData()` |
| `inferModulePath()` / `normalizeRemoteURL()` | Derive the FQDN module from the git remote (HTTPS, `ssh://`, SCP-like `git@`) |
| `moduleDirective()` | Reads the `module` line from `./go.mod` — powers the home-repo safety guard |
| `deriveSlug()` | Project slug from the module's last path element |
| `runWizard(a, skipIdentity)` | 6-phase interactive forms; `skipIdentity` hides the Phase 1 prompts when identity is inferred |
| `presetAnswers()` | Hardcoded presets a/b/c — non-interactive path |
| `files()` | Registry of every file to generate: `[]genFile{Path, Tmpl, When, Binary}` |
| `generate(d, dest)` / `promote()` | Render to a staging dir, then promote files into `dest` (`.` in-place or `<slug>/`) |
| `removeSelf()` / `runGoModTidy()` | Self-destruct sequence (in-place mode only) |
| `main()` / `runClassic()` | Mode dispatch: zero-touch in-place vs. preset subdirectory |
| `const tmpl* = ...` | All generated file content as template strings (bottom of file) |

`generate()` is atomic: it renders into `.wails-gen-<rand>/` first and only promotes files to `dest` once **every** template succeeds; a deferred cleanup removes the staging dir on any error. Promotion uses per-file `os.Rename` (same filesystem) and overwrites existing files, which is what the in-place flow needs.

`ModulePath` flows `inferModulePath()` (or a manual prompt when there's no remote) → `Answers.ModulePath` → `buildData()` as `firstNonEmpty(a.ModulePath, a.Slug)`, so presets keep using the bare slug.

## Template conventions

Templates use `[[ ]]` delimiters (not `{{ }}`) to avoid collisions with JSX and CSS syntax.

Special template functions:
- `[[bq]]` → backtick `` ` `` — Go raw-string literals cannot contain a backtick, so this is the workaround used throughout
- `[[fence]]` → ` ``` ` (triple backtick for Markdown code fences)

Conditionals in templates use derived booleans from `TemplateData`, not raw enum strings:

| Use this | Not this |
|---|---|
| `[[if .IsSQLite]]` | `[[if eq .DBEngine "sqlite"]]` |
| `[[if .UseEnv]]` | `[[if eq .ConfigStrategy "env"]]` |
| `[[if .LogToConsole]]` | `[[if eq .LogDest "console"]]` |

Binary files (e.g. the tray icon PNG) are stored as base64 strings in `const` vars and decoded by `generate()` when `genFile.Binary == true`.

## Adding a new generated file

1. Add `const tmplMyFile = \` ... \`` at the bottom of `generador.go`
2. Add a `genFile` entry in `files()` with the appropriate `When` predicate
3. If the path itself needs template substitution (e.g. migration timestamps), use `[[ ]]` actions directly in the `Path` field of the `genFile` struct
4. Run `go build .` to verify, then `go run . -preset b` to exercise all features
