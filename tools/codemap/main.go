// Command codemap maps this repository for people and AI agents: Go and
// TypeScript symbols with their real calls (go/types and the TypeScript
// compiler, not text matching), the Wails link between a React component, the
// services/contract.ts member it calls, the Go bound method (desktop) and the
// web engine (iPad), and the SQL tables each one reads or writes.
//
//	codemap overview                      architecture summary
//	codemap search [-kind K] [-lang L] Q  find symbols (exact > prefix > camel humps > substring)
//	codemap symbol NAME                   explain one symbol: mirrors, callers, callees, tables
//	codemap trace [-target T] [-full] NAME   flow from NAME down to the tables
//	codemap impact NAME                   who breaks if NAME changes, and the tests to run
//
// NAME is a name or a trailing part of it (CreateExpense, ExpenseForm.submit),
// a node ID, or file:line. Every command takes -root (default: the nearest
// directory above the current one that holds go.mod).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/index"
)

const usage = `usage: codemap <command> [flags] [args]

commands:
  overview                                  architecture summary
  search [-kind K] [-lang go|ts|sql] QUERY  find symbols
  symbol NAME                               explain one symbol
  trace [-target desktop|web] [-depth N] [-full] NAME
                                            flow from NAME down to the tables
  impact [-depth N] NAME                    upstream callers, UI reached, tests to run

every command accepts -root DIR (default: nearest parent holding go.mod)`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err := run(ctx, os.Args[1:], os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "codemap:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "help" {
		return errors.New(usage)
	}
	cmd, args := args[0], args[1:]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	root := fs.String("root", "", "repository root")
	kind := fs.String("kind", "", "search: only this kind (func, method, component, contract, table…)")
	lang := fs.String("lang", "", "search: only go, ts or sql")
	limit := fs.Int("limit", 25, "search: maximum results")
	target := fs.String("target", "", "trace: follow only the desktop or the web build")
	depth := fs.Int("depth", 0, "trace/impact: maximum depth")
	full := fs.Bool("full", false, "trace: keep branches that never reach data")
	// Flags may come before or after the name (`trace X -target web`): the
	// flag package stops at the first positional argument, so keep going.
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return fmt.Errorf("%w\n\n%s", err, usage)
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
	query := strings.Join(positional, " ")

	dir, err := repoRoot(*root)
	if err != nil {
		return err
	}
	build := func() (*graph.Graph, error) { return index.Build(ctx, index.Options{Root: dir}) }

	var text string
	switch cmd {
	case "overview":
		g, err := build()
		if err != nil {
			return err
		}
		text = overviewAnswer(g)
	case "search", "symbol", "trace", "impact":
		if query == "" {
			return fmt.Errorf("%s needs a name\n\n%s", cmd, usage)
		}
		opt, err := searchOptions(*kind, *lang, *limit)
		if err != nil {
			return err
		}
		if *target != "" && *target != graph.TargetDesktop && *target != graph.TargetWeb {
			return fmt.Errorf("-target must be %s or %s", graph.TargetDesktop, graph.TargetWeb)
		}
		g, err := build()
		if err != nil {
			return err
		}
		switch cmd {
		case "search":
			text = searchAnswer(g, query, opt)
		case "symbol":
			text = symbolAnswer(g, query)
		case "trace":
			text = traceAnswer(g, query, graph.TraceOptions{Target: *target, Depth: *depth, Full: *full})
		default:
			text = impactAnswer(g, query, *depth)
		}
	default:
		return fmt.Errorf("unknown command %q\n\n%s", cmd, usage)
	}
	_, err = io.WriteString(out, text)
	return err
}

func searchOptions(kind, lang string, limit int) (graph.SearchOptions, error) {
	opt := graph.SearchOptions{Limit: limit}
	if kind != "" {
		k, ok := graph.ParseKind(kind)
		if !ok {
			return opt, fmt.Errorf("unknown kind %q", kind)
		}
		opt.Kind = k
	}
	switch lang {
	case "":
	case "go":
		opt.Lang = graph.LangGo
	case "ts":
		opt.Lang = graph.LangTS
	case "sql":
		opt.Lang = graph.LangSQL
	default:
		return opt, fmt.Errorf("unknown lang %q (go, ts or sql)", lang)
	}
	return opt, nil
}

// repoRoot is dir, or the nearest directory above the working directory that
// holds go.mod.
func repoRoot(dir string) (string, error) {
	if dir != "" {
		return filepath.Abs(dir)
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("working directory: %w", err)
	}
	for d := wd; ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
			return d, nil
		}
		if filepath.Dir(d) == d {
			return "", errors.New("no go.mod above the working directory; pass -root")
		}
	}
}
