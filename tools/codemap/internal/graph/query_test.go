package graph

import (
	"slices"
	"strings"
	"testing"
)

// fixtureGraph is a one-feature app: a form whose handler calls a contract
// member that dispatches to a Go bound method (desktop) and to the web engine,
// both ending in the same table.
func fixtureGraph() *Graph {
	g := New()
	nodes := []*Node{
		{ID: "ts:form", Name: "Form", Lang: LangTS, Kind: KindComponent, Pos: Pos{File: "frontend/src/components/Form.tsx", Line: 1, EndLine: 10}},
		{ID: "ts:form#save", Name: "Form.save", Lang: LangTS, Kind: KindFunc, Parent: "ts:form", Pos: Pos{File: "frontend/src/components/Form.tsx", Line: 4, EndLine: 6}},
		{ID: "ts:form#format", Name: "Form.format", Lang: LangTS, Kind: KindFunc, Parent: "ts:form", Pos: Pos{File: "frontend/src/components/Form.tsx", Line: 7, EndLine: 8}},
		{ID: "ts:iface", Name: "SvcContract", Lang: LangTS, Kind: KindType, Pos: Pos{File: "frontend/src/services/contract.ts", Line: 1, EndLine: 5}},
		{ID: "ts:hub", Name: "SvcContract.Save", Lang: LangTS, Kind: KindContractMethod, Parent: "ts:iface", Pos: Pos{File: "frontend/src/services/contract.ts", Line: 2}},
		{ID: "go:pkg.Svc.Save", Name: "pkg.Svc.Save", Lang: LangGo, Kind: KindMethod, Bound: "Svc", Pos: Pos{File: "backend/pkg/svc.go", Line: 10, EndLine: 20}},
		{ID: "go:pkg.persist", Name: "pkg.persist", Lang: LangGo, Kind: KindFunc, Pos: Pos{File: "backend/pkg/svc.go", Line: 30, EndLine: 35}},
		{ID: "ts:engine#Save", Name: "createSvc.service.Save", Lang: LangTS, Kind: KindEngineMethod, Pos: Pos{File: "frontend/src/engine/svc.ts", Line: 5, EndLine: 9}},
		{ID: "sql:things", Name: "things", Lang: LangSQL, Kind: KindTable, Pos: Pos{File: "backend/pkg/migrations/1.up.sql", Line: 1}},
		{ID: "go:pkg.TestSave", Name: "pkg.TestSave", Lang: LangGo, Kind: KindTestFunc, Pos: Pos{File: "backend/pkg/svc_test.go", Line: 3}},
		{ID: "ts:engine.test", Name: "frontend/src/engine/svc.test.ts", Lang: LangTS, Kind: KindTestFile, Pos: Pos{File: "frontend/src/engine/svc.test.ts", Line: 1}},
	}
	for _, n := range nodes {
		g.AddNode(n)
	}
	at := func(file string, line int) Pos { return Pos{File: file, Line: line} }
	for _, e := range []Edge{
		{From: "ts:form", To: "ts:form#save", Kind: EdgeCall, At: at("frontend/src/components/Form.tsx", 9)},
		{From: "ts:form", To: "ts:form#format", Kind: EdgeCall, At: at("frontend/src/components/Form.tsx", 9)},
		{From: "ts:form#save", To: "ts:hub", Kind: EdgeCall, At: at("frontend/src/components/Form.tsx", 5)},
		{From: "ts:hub", To: "go:pkg.Svc.Save", Kind: EdgeDispatch, Target: TargetDesktop},
		{From: "ts:hub", To: "ts:engine#Save", Kind: EdgeDispatch, Target: TargetWeb},
		{From: "go:pkg.Svc.Save", To: "go:pkg.persist", Kind: EdgeCall, At: at("backend/pkg/svc.go", 12)},
		{From: "go:pkg.persist", To: "sql:things", Kind: EdgeWrite, At: at("backend/pkg/svc.go", 31)},
		{From: "ts:engine#Save", To: "sql:things", Kind: EdgeWrite, At: at("frontend/src/engine/svc.ts", 6)},
		{From: "ts:engine#Save", To: "sql:things", Kind: EdgeRead, At: at("frontend/src/engine/svc.ts", 7)},
		{From: "go:pkg.TestSave", To: "go:pkg.Svc.Save", Kind: EdgeCall, At: at("backend/pkg/svc_test.go", 4)},
		{From: "ts:engine.test", To: "ts:hub", Kind: EdgeCall, At: at("frontend/src/engine/svc.test.ts", 3)},
	} {
		g.AddEdge(e)
	}
	g.Finish()
	return g
}

func names(nodes []*Node) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.Name)
	}
	return out
}

func TestResolve(t *testing.T) {
	g := fixtureGraph()
	tests := []struct {
		name, query string
		want        []string
	}{
		{"mirrors collapse to their contract member", "Save", []string{"SvcContract.Save"}},
		{"full name", "pkg.Svc.Save", []string{"pkg.Svc.Save"}},
		{"node ID", "go:pkg.persist", []string{"pkg.persist"}},
		{"file:line picks the innermost symbol", "frontend/src/components/Form.tsx:5", []string{"Form.save"}},
		{"case-insensitive fallback", "form.SAVE", []string{"Form.save"}},
		{"unknown", "nothing", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := names(g.Resolve(tt.query)); !slices.Equal(got, tt.want) {
				t.Errorf("Resolve(%q) = %v, want %v", tt.query, got, tt.want)
			}
		})
	}
}

func TestSearch(t *testing.T) {
	g := fixtureGraph()
	tests := []struct {
		name, query string
		opt         SearchOptions
		want        string // first hit
	}{
		{"exact beats prefix", "persist", SearchOptions{}, "pkg.persist"},
		{"prefix", "pers", SearchOptions{}, "pkg.persist"},
		{"camel humps", "SC", SearchOptions{Kind: KindType}, "SvcContract"},
		{"language filter", "save", SearchOptions{Lang: LangGo}, "pkg.Svc.Save"},
		{"kind filter", "save", SearchOptions{Kind: KindEngineMethod}, "createSvc.service.Save"},
		{"subsequence", "frmt", SearchOptions{}, "Form.format"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hits := g.Search(tt.query, tt.opt)
			if len(hits) == 0 || hits[0].Name != tt.want {
				t.Errorf("Search(%q) = %v, want first %q", tt.query, names(hits), tt.want)
			}
		})
	}
}

// flatten lists "depth:name" for every node of a trace.
func flatten(tn *TraceNode, depth int, out *[]string) {
	for _, c := range tn.Children {
		label := c.Node.Name
		if c.Via.Kind == EdgeDispatch {
			label = "[" + c.Via.Target + "]" + label
		}
		*out = append(*out, strings.Repeat(" ", depth)+label)
		flatten(c, depth+1, out)
	}
}

func TestTrace(t *testing.T) {
	g := fixtureGraph()
	form := g.Nodes["ts:form"]
	tests := []struct {
		name string
		opt  TraceOptions
		want []string
	}{
		{"both builds, data branches only", TraceOptions{}, []string{
			"Form.save", " SvcContract.Save", "  [desktop]pkg.Svc.Save", "   pkg.persist", "    things",
			"  [web]createSvc.service.Save", "   things", "   things",
		}},
		{"web only", TraceOptions{Target: TargetWeb}, []string{
			"Form.save", " SvcContract.Save", "  [web]createSvc.service.Save", "   things", "   things",
		}},
		{"full keeps branches without data", TraceOptions{Target: TargetWeb, Full: true}, []string{
			"Form.format", "Form.save", " SvcContract.Save", "  [web]createSvc.service.Save", "   things", "   things",
		}},
		{"depth limit", TraceOptions{Depth: 1}, []string{"Form.save"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			flatten(g.Trace(form, tt.opt), 0, &got)
			if !slices.Equal(got, tt.want) {
				t.Errorf("trace =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tt.want, "\n"))
			}
		})
	}
}

func TestTables(t *testing.T) {
	g := fixtureGraph()
	desktop := g.Tables(g.Nodes["ts:form"], TargetDesktop)
	if len(desktop) != 1 || !desktop[0].Write || desktop[0].Read || desktop[0].Via.Name != "pkg.persist" {
		t.Errorf("desktop tables = %+v, want write things via pkg.persist", desktop)
	}
	web := g.Tables(g.Nodes["ts:form"], TargetWeb)
	if len(web) != 1 || !web[0].Write || !web[0].Read || web[0].Via.Name != "createSvc.service.Save" {
		t.Errorf("web tables = %+v, want read+write things via the engine", web)
	}
	if direct := g.Tables(g.Nodes["go:pkg.persist"], ""); len(direct) != 1 || !direct[0].Direct {
		t.Errorf("persist tables = %+v, want direct", direct)
	}
}

func TestImpact(t *testing.T) {
	g := fixtureGraph()

	t.Run("a Go helper reaches the UI through the contract and only Go tests", func(t *testing.T) {
		im := g.Impact(g.Nodes["go:pkg.persist"], 0)
		var levels []string
		for _, l := range im.Levels {
			levels = append(levels, strings.Join(names(l), ","))
		}
		want := []string{"pkg.Svc.Save", "SvcContract.Save", "Form.save", "Form"}
		if !slices.Equal(levels, want) {
			t.Errorf("levels = %v, want %v", levels, want)
		}
		if !slices.Equal(names(im.UI), []string{"Form"}) {
			t.Errorf("UI = %v", names(im.UI))
		}
		if !slices.Equal(im.GoTests["backend/pkg"], []string{"TestSave"}) || len(im.TSTests) != 0 {
			t.Errorf("tests = %v / %v (TS tests reached through the contract exercise the engine, not Go)", im.GoTests, im.TSTests)
		}
		if im.Hub != nil {
			t.Errorf("a helper has no contract hub, got %v", im.Hub.Name)
		}
	})

	t.Run("an engine method keeps its TS tests and names its mirrors", func(t *testing.T) {
		im := g.Impact(g.Nodes["ts:engine#Save"], 0)
		if !slices.Equal(im.TSTests, []string{"frontend/src/engine/svc.test.ts"}) {
			t.Errorf("TS tests = %v", im.TSTests)
		}
		if im.Hub == nil || len(im.Mirrors) != 2 {
			t.Errorf("hub %v mirrors %v, want the contract and both builds", im.Hub, im.Mirrors)
		}
	})
}

func TestCallers(t *testing.T) {
	g := fixtureGraph()
	var got []string
	for _, c := range g.Callers(g.Nodes["go:pkg.Svc.Save"]) {
		got = append(got, c.Node.Name)
		if c.Node.Name == "Form.save" && !c.ViaContract {
			t.Error("Form.save reaches the Go method through the contract")
		}
	}
	slices.Sort(got)
	if want := []string{"Form.save", "frontend/src/engine/svc.test.ts", "pkg.TestSave"}; !slices.Equal(got, want) {
		t.Errorf("callers = %v, want %v", got, want)
	}
}

func TestOverview(t *testing.T) {
	ov := fixtureGraph().Overview()
	if len(ov.Services) != 1 || ov.Services[0].Name != "Svc" || ov.Services[0].Contract != "SvcContract" || len(ov.Services[0].NoUI) != 0 {
		t.Errorf("services = %+v", ov.Services)
	}
	if len(ov.TableUse) != 1 || ov.TableUse[0].GoWriters != 1 || ov.TableUse[0].TSWriters != 1 || ov.TableUse[0].TSReaders != 1 {
		t.Errorf("table use = %+v", ov.TableUse)
	}
}
