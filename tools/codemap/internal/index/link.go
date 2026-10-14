package index

import (
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

var tsKinds = map[string]graph.Kind{
	"module":         graph.KindModule,
	"testFile":       graph.KindTestFile,
	"function":       graph.KindFunc,
	"component":      graph.KindComponent,
	"hook":           graph.KindHook,
	"method":         graph.KindMethod,
	"class":          graph.KindType,
	"interface":      graph.KindType,
	"contractMethod": graph.KindContractMethod,
	"engineMethod":   graph.KindEngineMethod,
}

var tsEdgeKinds = map[string]graph.EdgeKind{
	"call":   graph.EdgeCall,
	"ref":    graph.EdgeRef,
	"render": graph.EdgeRender,
}

func (p tsPos) pos() graph.Pos { return graph.Pos{File: p.File, Line: p.Line, EndLine: p.EndLine} }

// addWebTables adds the tables only the web engine creates (CREATE TABLE in a
// TS string, like its web_prefs key-value table) to the migration tables.
func addWebTables(tables tableSet, ex *tsExtract) {
	for _, s := range ex.SQL {
		for _, m := range createTableRe.FindAllStringSubmatch(s.Text, -1) {
			name := strings.ToLower(m[1])
			if _, ok := tables[name]; !ok {
				tables[name] = s.At.pos()
			}
		}
	}
}

// addTSNodes inserts the TypeScript symbols.
func addTSNodes(g *graph.Graph, ex *tsExtract) {
	for _, s := range ex.Symbols {
		kind, ok := tsKinds[s.Kind]
		if !ok {
			continue
		}
		g.AddNode(&graph.Node{
			ID:        s.ID,
			Name:      s.Name,
			Lang:      graph.LangTS,
			Kind:      kind,
			Pos:       s.Pos.pos(),
			Parent:    s.Parent,
			Signature: s.Signature,
			Doc:       s.Doc,
		})
	}
}

// linkTS adds the TypeScript edges and the links across the Go⇄TS boundary:
//
//   - each contract member dispatches to the web implementation (engine) and,
//     through the binding the desktop wrapper declares, to the Go bound method;
//   - a direct call into Wails bindings reaches the Go method;
//   - SQL strings in TS read or write tables, like Go's.
func linkTS(g *graph.Graph, ex *tsExtract, tables tableSet) {
	for _, e := range ex.Edges {
		if kind, ok := tsEdgeKinds[e.Kind]; ok {
			g.AddEdge(graph.Edge{From: e.From, To: e.To, Kind: kind, At: e.At.pos()})
		}
	}
	for _, impl := range ex.Implementations {
		g.AddEdge(graph.Edge{From: impl.Contract, To: impl.Impl, Kind: graph.EdgeDispatch, Target: graph.TargetWeb,
			At: g.Nodes[impl.Impl].PosOrZero()})
	}
	members := map[string][]*graph.Node{} // contract interface ID → members
	for _, n := range g.Nodes {
		if n.Kind == graph.KindContractMethod {
			members[n.Parent] = append(members[n.Parent], n)
		}
	}
	for _, b := range ex.Bindings {
		for _, m := range members[b.Contract] {
			method := m.Name[strings.LastIndex(m.Name, ".")+1:]
			to := "go:" + b.GoPkg + "." + b.GoType + "." + method
			g.AddEdge(graph.Edge{From: m.ID, To: to, Kind: graph.EdgeDispatch, Target: graph.TargetDesktop,
				At: g.Nodes[to].PosOrZero()})
		}
	}
	for _, c := range ex.BindingCalls {
		to := "go:" + c.GoPkg + "." + c.GoType + "." + c.Method
		g.AddEdge(graph.Edge{From: c.From, To: to, Kind: graph.EdgeCall, Target: graph.TargetDesktop, At: c.At.pos()})
	}
	for _, s := range ex.SQL {
		acc, dynamic := classifySQL(s.Text, tables)
		for _, a := range acc {
			g.AddEdge(graph.Edge{From: s.From, To: tableID(a.table), Kind: a.kind, At: s.At.pos()})
		}
		if n := g.Nodes[s.From]; dynamic && n != nil {
			n.Unresolved = append(n.Unresolved, s.At.pos())
		}
	}
}
