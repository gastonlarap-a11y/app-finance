package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/index"
)

// connectMCP serves the fixture's graph over an in-memory transport and
// returns a connected client session.
func connectMCP(t *testing.T) *mcp.ClientSession {
	t.Helper()
	ctx := t.Context()
	g, err := index.Build(ctx, index.Options{Root: fixtureRoot})
	if err != nil {
		t.Fatal(err)
	}
	serverT, clientT := mcp.NewInMemoryTransports()
	ss, err := newMCPServer(func() (*graph.Graph, error) { return g, nil }).Connect(ctx, serverT, nil)
	if err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "v0"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := cs.Close(); err != nil {
			t.Error(err)
		}
		_ = ss.Wait() // the session ends when the client closes; its error is only "closed"
	})
	return cs
}

func callText(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(t.Context(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

func TestMCPToolsAreReadOnly(t *testing.T) {
	cs := connectMCP(t)
	if !strings.Contains(cs.InitializeResult().Instructions, "codemap_trace") {
		t.Error("server instructions do not explain the tools")
	}
	res, err := cs.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("%s is not marked read-only", tool.Name)
		}
	}
	slices.Sort(names)
	want := []string{"codemap_impact", "codemap_overview", "codemap_search", "codemap_symbol", "codemap_trace"}
	if !slices.Equal(names, want) {
		t.Errorf("tools = %v, want %v", names, want)
	}
}

func TestMCPToolAnswers(t *testing.T) {
	cs := connectMCP(t)
	tests := []struct {
		tool string
		args map[string]any
		want []string
	}{
		{"codemap_overview", map[string]any{}, []string{"ShopService  backend/shop  5 métodos"}},
		{"codemap_search", map[string]any{"query": "touch", "lang": "go"}, []string{"shop.ShopService.touch [go method]"}},
		{"codemap_symbol", map[string]any{"name": "ShopService.RemoveCart"}, []string{"escribe carts  (directo)"}},
		{"codemap_trace", map[string]any{"from": "ShopService.AddItem", "target": "desktop"}, []string{"write items", "read carts"}},
		{"codemap_impact", map[string]any{"name": "ShopService.touch"}, []string{"go test -race -run '^(TestAddItem)$' ./backend/shop"}},
		{"codemap_symbol", map[string]any{"name": "nothing-like-this"}, []string{"No encontré"}},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			text, isErr := callText(t, cs, tt.tool, tt.args)
			if isErr {
				t.Fatalf("tool error: %s", text)
			}
			for _, want := range tt.want {
				if !strings.Contains(text, want) {
					t.Errorf("answer lacks %q:\n%s", want, text)
				}
			}
		})
	}
}

func TestMCPInvalidInputIsAToolError(t *testing.T) {
	cs := connectMCP(t)
	tests := []struct {
		tool string
		args map[string]any
		want string
	}{
		{"codemap_trace", map[string]any{"from": "X", "target": "mobile"}, "target must be"},
		{"codemap_search", map[string]any{"query": "X", "kind": "widget"}, "unknown kind"},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			text, isErr := callText(t, cs, tt.tool, tt.args)
			if !isErr || !strings.Contains(text, tt.want) {
				t.Errorf("isError=%v text=%q, want a tool error mentioning %q", isErr, text, tt.want)
			}
		})
	}
}

func TestAwaitGraph(t *testing.T) {
	ready := &graph.Graph{}
	tests := []struct {
		name    string
		build   graphFunc
		want    *graph.Graph
		wantErr error
	}{
		{"ready in time", func() (*graph.Graph, error) { return ready, nil }, ready, nil},
		{"slow build answers indexing", func() (*graph.Graph, error) {
			time.Sleep(200 * time.Millisecond)
			return ready, nil
		}, nil, errIndexing},
		{"build error passes through", func() (*graph.Graph, error) { return nil, context.DeadlineExceeded }, nil, context.DeadlineExceeded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := awaitGraph(t.Context(), tt.build, 50*time.Millisecond)
			if got != tt.want || !errors.Is(err, tt.wantErr) {
				t.Errorf("awaitGraph = %p, %v; want %p, %v", got, err, tt.want, tt.wantErr)
			}
		})
	}
}
