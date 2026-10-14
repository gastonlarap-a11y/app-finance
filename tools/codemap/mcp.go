package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/index"
)

// mcpInstructions reach the agent at initialization: when each tool beats
// reading files by hand.
const mcpInstructions = `codemap answers questions about this repository (Wails v3: Go backend + React/TS
frontend + a TS web engine for the iPad build) from a compiler-grade index: real calls, the
Go⇄TS link through frontend/src/services/contract.ts, and the SQL tables each symbol reads or writes.

- codemap_overview: start here for the architecture (bound services, packages, tables).
- codemap_trace: follow a flow from a component, handler or bound method down to the tables, on the
  desktop build (Go) and the web build (TS engine) side by side.
- codemap_symbol: before changing a function, see its mirrors (contract, Go, engine change
  together), callers, callees and tables.
- codemap_impact: who breaks if a symbol changes, the UI reached, and the exact test commands.
- codemap_search: find a symbol when you only know part of its name.

Names accept a trailing part (CreateExpense, ExpenseForm.submit), an ID, or file:line. Answers cite
file:line; "sin resolver" marks a table or call only known at run time. Answers are in Spanish.`

// indexPatience is how long a tool waits for the index before answering
// "still indexing" (the very first build compiles dependency export data).
const indexPatience = 20 * time.Second

var errIndexing = errors.New("el índice se está construyendo (la primera vez compila dependencias, hasta ~1 min); reintenta en unos segundos")

// graphFunc returns the current graph.
type graphFunc func() (*graph.Graph, error)

// awaitGraph returns the graph, or errIndexing when building it takes longer
// than patience; the build keeps going for the next call.
func awaitGraph(ctx context.Context, build graphFunc, patience time.Duration) (*graph.Graph, error) {
	type result struct {
		g   *graph.Graph
		err error
	}
	done := make(chan result, 1)
	go func() {
		g, err := build()
		done <- result{g, err}
	}()
	timer := time.NewTimer(patience)
	defer timer.Stop()
	select {
	case r := <-done:
		return r.g, r.err
	case <-timer.C:
		return nil, errIndexing
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type overviewInput struct{}

type searchInput struct {
	Query string `json:"query" jsonschema:"part of a symbol or table name: CreateExpense, ExpenseForm, expenses"`
	Kind  string `json:"kind,omitempty" jsonschema:"only this kind: func, method, type, component, hook, contract, engine, table, test"`
	Lang  string `json:"lang,omitempty" jsonschema:"only go, ts or sql"`
	Limit int    `json:"limit,omitempty" jsonschema:"maximum results (default 25)"`
}

type symbolInput struct {
	Name string `json:"name" jsonschema:"symbol name or its trailing part (CreateExpense, finance.FinanceService.softDelete), an ID, or file:line"`
}

type traceInput struct {
	From   string `json:"from" jsonschema:"where the flow starts: a component, handler, contract member or Go method (same forms as codemap_symbol)"`
	Target string `json:"target,omitempty" jsonschema:"desktop (Go) or web (TS engine); empty follows both"`
	Depth  int    `json:"depth,omitempty" jsonschema:"maximum depth (default 8)"`
	Full   bool   `json:"full,omitempty" jsonschema:"also keep branches that never reach a table or the Go/TS boundary"`
}

type impactInput struct {
	Name  string `json:"name" jsonschema:"the symbol about to change (same forms as codemap_symbol)"`
	Depth int    `json:"depth,omitempty" jsonschema:"how many caller levels to walk (default 6)"`
}

// newMCPServer exposes the answers as read-only MCP tools over g.
func newMCPServer(build graphFunc) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "codemap", Version: version()}, &mcp.ServerOptions{Instructions: mcpInstructions})

	addTool(s, build, "codemap_overview",
		"Architecture summary: Wails services bound to TS (and bound methods no UI uses), Go packages, frontend areas, and who writes/reads each table.",
		func(g *graph.Graph, _ overviewInput) (string, error) { return overviewAnswer(g), nil })

	addTool(s, build, "codemap_search",
		"Find Go/TS symbols and tables by part of their name (exact > prefix > camel humps > substring).",
		func(g *graph.Graph, in searchInput) (string, error) {
			opt, err := searchOptions(in.Kind, in.Lang, in.Limit)
			if err != nil {
				return "", err
			}
			return searchAnswer(g, in.Query, opt), nil
		})

	addTool(s, build, "codemap_symbol",
		"Explain one symbol: signature, doc, Go⇄TS mirrors that change together, callers (including UI through the contract), callees, tables (per build), tests.",
		func(g *graph.Graph, in symbolInput) (string, error) { return symbolAnswer(g, in.Name), nil })

	addTool(s, build, "codemap_trace",
		"Follow a flow from a symbol down to the SQL tables: UI → contract → Go bound method (desktop) and TS engine (web) → helpers → tables, with call sites.",
		func(g *graph.Graph, in traceInput) (string, error) {
			if in.Target != "" && in.Target != graph.TargetDesktop && in.Target != graph.TargetWeb {
				return "", fmt.Errorf("target must be %q, %q or empty", graph.TargetDesktop, graph.TargetWeb)
			}
			return traceAnswer(g, in.From, graph.TraceOptions{Target: in.Target, Depth: in.Depth, Full: in.Full}), nil
		})

	addTool(s, build, "codemap_impact",
		"What may break if a symbol changes: callers level by level up to the UI, the contract mirrors to keep in step, and ready-to-run go test / vitest commands.",
		func(g *graph.Graph, in impactInput) (string, error) { return impactAnswer(g, in.Name, in.Depth), nil })
	return s
}

// addTool registers a read-only tool whose answer is text, clipped to a size
// an agent can act on.
func addTool[In any](s *mcp.Server, build graphFunc, name, description string, answer func(*graph.Graph, In) (string, error)) {
	closedWorld := false
	tool := &mcp.Tool{
		Name:        name,
		Description: description,
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &closedWorld},
	}
	mcp.AddTool(s, tool, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		g, err := awaitGraph(ctx, build, indexPatience)
		if err != nil {
			return nil, nil, err // the SDK turns it into an IsError result the agent can read
		}
		text, err := answer(g, in)
		if err != nil {
			return nil, nil, err
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: graph.Clip(text, graph.MaxChars)}}}, nil, nil
	})
}

// serveMCP runs the MCP server over stdio until the client disconnects. The
// index starts building right away and stays fresh as files change.
func serveMCP(ctx context.Context, root string) error {
	ix := index.New(index.Options{Root: root})
	build := func() (*graph.Graph, error) { return ix.Graph(ctx) }
	go func() {
		// Warm-up only: a failure here resurfaces, with its message, on the first tool call.
		if _, err := build(); err != nil {
			fmt.Fprintln(os.Stderr, "codemap: indexing:", err)
		}
	}()
	return newMCPServer(build).Run(ctx, &mcp.StdioTransport{})
}

// version is the module version codemap was built from ("(devel)" under go run).
func version() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
		return info.Main.Version
	}
	return "(devel)"
}
