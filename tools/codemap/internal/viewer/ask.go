package viewer

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The "Ask the AI" panel runs the user's own Claude Code CLI headless: it
// uses their subscription (never an API key, so it costs nothing extra),
// read-only, with codemap's MCP tools as its main source.

// requiredFlags must all appear in `claude --help`, or Ask stays off: an older
// CLI that ignored one of them could run without its read-only guard.
var requiredFlags = []string{
	"--print", "--output-format", "--include-partial-messages", "--verbose", "--restricted", "--tools",
	"--strict-mcp-config", "--mcp-config", "--allowedTools", "--permission-mode", "--permission-prompts",
	"--settings", "--append-system-prompt", "--resume",
}

// denyRules repeat the repository's own (which --restricted stops reading)
// plus every kind of personal financial data that could sit in the checkout.
//
// Every rule is anchored with `//` at the absolute root: a `/path` rule
// anchors at its settings source, and an inline --settings has none — an
// E2E run read /config.toml through exactly that gap.
func denyRules(root string) []string {
	roots := []string{root}
	// Cover the symlink-resolved path too (macOS: /var is /private/var).
	if real, err := filepath.EvalSymlinks(root); err == nil && real != root {
		roots = append(roots, real)
	}
	var rules []string
	for _, r := range roots {
		abs := "//" + strings.TrimPrefix(filepath.ToSlash(r), "/")
		for _, p := range []string{
			"config.toml", "logs/**",
			"**/.env", "**/*.env", "**/secrets.env", "**/google-token.json", "**/*.pem",
			"**/*.db", "**/*.db-*", "**/*.sqlite*", "**/*.pdf", "**/*.csv", "**/*.xlsx",
		} {
			rules = append(rules, "Read("+abs+"/"+p+")")
		}
	}
	return rules
}

// paidAuthEnv are variables that would make `claude -p` bill an API key
// instead of the user's subscription.
var paidAuthEnv = []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}

const (
	maxQuestion = 4000
	askTimeout  = 5 * time.Minute
)

// grounding is appended to Claude's system prompt for every question.
const grounding = `Explicas el código del repositorio en el directorio de trabajo (app-finance: backend Go con Wails v3,
frontend React/TS y un motor TS para la versión web/iPad, enlazados por frontend/src/services/contract.ts).
Usa primero las herramientas mcp__codemap__* (overview, search, symbol, trace, impact): conocen las llamadas
reales, el enlace Go⇄TS y las tablas SQL. Lee archivos solo para confirmar detalles. Cita archivo:línea.
Responde en español, claro y breve. Solo lectura: no propongas ejecutar comandos ni editar archivos.`

var sessionIDRe = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)

// Asker runs questions through the claude CLI.
type Asker struct {
	Claude string   // claude binary
	Root   string   // repository root: the working directory
	MCP    []string // command (and args) that serves codemap over stdio
	Model  string   // optional --model
	Env    []string // child environment (paid-auth variables are removed)
	slot   chan struct{}
}

// NewAsker finds the claude CLI and checks it supports every flag Ask
// relies on. On error, Ask is unavailable and the error says why.
func NewAsker(ctx context.Context, root string, mcpCommand []string, model string) (*Asker, error) {
	claude, err := exec.LookPath("claude")
	if err != nil {
		return nil, errors.New("no encontré la CLI `claude` (Claude Code) en el PATH")
	}
	help, err := exec.CommandContext(ctx, claude, "--help").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("`claude --help` falló: %w", err)
	}
	if missing := missingFlags(string(help)); len(missing) > 0 {
		return nil, fmt.Errorf("tu `claude` no soporta %s: actualiza Claude Code", strings.Join(missing, ", "))
	}
	return newAsker(claude, root, mcpCommand, model, os.Environ()), nil
}

// newAsker builds an Asker for a claude binary already checked.
func newAsker(claude, root string, mcpCommand []string, model string, env []string) *Asker {
	return &Asker{Claude: claude, Root: root, MCP: mcpCommand, Model: model, Env: env, slot: make(chan struct{}, 1)}
}

func missingFlags(help string) []string {
	var missing []string
	for _, f := range requiredFlags {
		if !strings.Contains(help, f) {
			missing = append(missing, f)
		}
	}
	return missing
}

// AskRequest is one question from the panel.
type AskRequest struct {
	Question string `json:"question"`
	Symbol   string `json:"symbol,omitempty"`  // node the page shows, as context
	Session  string `json:"session,omitempty"` // Claude session to continue
}

// AskEvent is what the panel receives, one JSON object per line.
type AskEvent struct {
	Kind    string `json:"kind"` // session | text | tool | done | error
	Text    string `json:"text,omitempty"`
	Session string `json:"session,omitempty"`
}

// errBusy means another question is still running.
var errBusy = errors.New("ya hay una pregunta en curso")

// args is the claude command line for one question; the question itself
// goes in on stdin, never in argv.
func (a *Asker) args(req AskRequest) ([]string, error) {
	mcpConfig, err := json.Marshal(map[string]any{"mcpServers": map[string]any{
		"codemap": map[string]any{"type": "stdio", "command": a.MCP[0], "args": a.MCP[1:]},
	}})
	if err != nil {
		return nil, fmt.Errorf("encoding MCP config: %w", err)
	}
	settings, err := json.Marshal(map[string]any{"permissions": map[string]any{"deny": denyRules(a.Root)}})
	if err != nil {
		return nil, fmt.Errorf("encoding settings: %w", err)
	}
	args := []string{
		"--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		// Read-only: no code-running tools, settings files ignored (so no repo
		// hooks run), file tools confined to the working directory.
		"--restricted",
		"--tools", "Read,Grep,Glob",
		"--strict-mcp-config", "--mcp-config", string(mcpConfig),
		"--allowedTools", "Read,Grep,Glob,mcp__codemap",
		"--permission-mode", "dontAsk", "--permission-prompts", "none",
		"--settings", string(settings),
		"--append-system-prompt", grounding,
	}
	if a.Model != "" {
		args = append(args, "--model", a.Model)
	}
	if req.Session != "" {
		if !sessionIDRe.MatchString(req.Session) {
			return nil, errors.New("sesión inválida")
		}
		args = append(args, "--resume", req.Session)
	}
	return args, nil
}

// childEnv is the environment without paid-auth variables.
func (a *Asker) childEnv() []string {
	env := make([]string, 0, len(a.Env))
	for _, kv := range a.Env {
		name, _, _ := strings.Cut(kv, "=")
		paid := false
		for _, p := range paidAuthEnv {
			paid = paid || name == p
		}
		if !paid {
			env = append(env, kv)
		}
	}
	return env
}

// Ask runs one question and calls emit for each event until claude exits.
// Only one question runs at a time (errBusy otherwise); ctx ends the run.
func (a *Asker) Ask(ctx context.Context, req AskRequest, symbolContext string, emit func(AskEvent) error) error {
	select {
	case a.slot <- struct{}{}:
		defer func() { <-a.slot }()
	default:
		return errBusy
	}
	req.Question = strings.TrimSpace(req.Question)
	if req.Question == "" || len([]rune(req.Question)) > maxQuestion {
		return fmt.Errorf("la pregunta debe tener entre 1 y %d caracteres", maxQuestion)
	}
	args, err := a.args(req)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, askTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, a.Claude, args...)
	cmd.Dir = a.Root
	cmd.Env = a.childEnv()
	// Let claude stop its MCP child cleanly; kill only if it lingers.
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = 5 * time.Second
	prompt := req.Question
	if symbolContext != "" {
		prompt = "Contexto: estoy mirando " + symbolContext + ".\n\n" + prompt
	}
	cmd.Stdin = strings.NewReader(prompt)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("claude stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting claude: %w", err)
	}
	streamErr := relay(stdout, emit)
	waitErr := cmd.Wait()
	switch {
	case ctx.Err() != nil:
		return fmt.Errorf("pregunta cancelada: %w", ctx.Err())
	case streamErr != nil:
		return streamErr
	case waitErr != nil:
		return fmt.Errorf("claude terminó con error: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// relay turns claude's stream-json lines into panel events.
func relay(r io.Reader, emit func(AskEvent) error) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	var p claudeParser
	for sc.Scan() {
		for _, ev := range p.parse(sc.Bytes()) {
			if err := emit(ev); err != nil {
				return err
			}
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("reading claude output: %w", err)
	}
	return nil
}

// claudeParser reads `claude -p --output-format stream-json
// --include-partial-messages` lines. Text arrives as deltas; the complete
// assistant message repeats it, so it is used only when no delta came.
type claudeParser struct{ streamed bool }

type claudeLine struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	IsError   bool   `json:"is_error"`
	Result    string `json:"result"`
	Event     *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
		ContentBlock *struct {
			Type string `json:"type"`
			Name string `json:"name"`
		} `json:"content_block"`
	} `json:"event"`
	Message *struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Name string `json:"name"`
		} `json:"content"`
	} `json:"message"`
}

func (p *claudeParser) parse(line []byte) []AskEvent {
	var l claudeLine
	if err := json.Unmarshal(line, &l); err != nil {
		return nil // not an event line
	}
	switch l.Type {
	case "system":
		if l.Subtype == "init" && l.SessionID != "" {
			return []AskEvent{{Kind: "session", Session: l.SessionID}}
		}
	case "stream_event":
		if l.Event == nil {
			return nil
		}
		if d := l.Event.Delta; d != nil && d.Type == "text_delta" && d.Text != "" {
			p.streamed = true
			return []AskEvent{{Kind: "text", Text: d.Text}}
		}
		if b := l.Event.ContentBlock; b != nil && b.Type == "tool_use" {
			return []AskEvent{{Kind: "tool", Text: b.Name}}
		}
	case "assistant":
		if l.Message == nil || p.streamed {
			return nil
		}
		var out []AskEvent
		for _, c := range l.Message.Content {
			switch c.Type {
			case "text":
				out = append(out, AskEvent{Kind: "text", Text: c.Text})
			case "tool_use":
				out = append(out, AskEvent{Kind: "tool", Text: c.Name})
			}
		}
		return out
	case "result":
		if l.IsError {
			return []AskEvent{{Kind: "error", Text: l.Result, Session: l.SessionID}}
		}
		return []AskEvent{{Kind: "done", Session: l.SessionID}}
	}
	return nil
}
