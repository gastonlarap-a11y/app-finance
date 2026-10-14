package main

import (
	"fmt"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// The answers below are shared by the CLI and the MCP server: one name in,
// one text out, so both always say the same thing. Each one warns when the
// index is partial, because a missing caller then means "not indexed", not
// "not called".

func overviewAnswer(g *graph.Graph) string { return graph.OverviewText(g.Overview()) }

func searchAnswer(g *graph.Graph, query string, opt graph.SearchOptions) string {
	return withNotes(g, graph.SearchText(query, g.Search(query, opt)))
}

// resolveOne returns the single node name means, or the text to answer
// instead (unknown or ambiguous name).
func resolveOne(g *graph.Graph, name string) (*graph.Node, string) {
	nodes := g.Resolve(name)
	if len(nodes) != 1 {
		return nil, withNotes(g, graph.CandidatesText(name, nodes))
	}
	return nodes[0], ""
}

func symbolAnswer(g *graph.Graph, name string) string {
	n, alt := resolveOne(g, name)
	if n == nil {
		return alt
	}
	return withNotes(g, graph.SymbolText(g, n))
}

func traceAnswer(g *graph.Graph, name string, opt graph.TraceOptions) string {
	n, alt := resolveOne(g, name)
	if n == nil {
		return alt
	}
	return withNotes(g, graph.TraceText(g.Trace(n, opt), opt))
}

func impactAnswer(g *graph.Graph, name string, depth int) string {
	n, alt := resolveOne(g, name)
	if n == nil {
		return alt
	}
	return withNotes(g, graph.ImpactText(g.Impact(n, depth)))
}

func withNotes(g *graph.Graph, text string) string {
	switch len(g.Notes) {
	case 0:
		return text
	case 1:
		return text + "⚠ Índice parcial: " + g.Notes[0] + "\n"
	}
	return text + fmt.Sprintf("⚠ Índice parcial: %s (y %d notas más: ver overview)\n", g.Notes[0], len(g.Notes)-1)
}
