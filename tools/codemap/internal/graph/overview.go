package graph

import (
	"cmp"
	"path"
	"slices"
	"strings"
)

// Overview summarizes the architecture: bound services, Go packages, frontend
// areas and who reads or writes each table.
type Overview struct {
	GoKinds  map[Kind]int
	TSKinds  map[Kind]int
	Tables   int
	Edges    int
	Services []ServiceSummary
	Packages []AreaSummary
	Frontend []AreaSummary
	TableUse []TableSummary
	Notes    []string
}

// ServiceSummary is one Go service Wails binds to TypeScript.
type ServiceSummary struct {
	Name     string
	Dir      string
	Contract string
	Methods  int
	// NoUI lists bound methods no non-test TypeScript code reaches.
	NoUI []string
}

// AreaSummary counts the symbols of one directory.
type AreaSummary struct {
	Dir    string
	Counts map[Kind]int
	Total  int
}

// TableSummary counts the distinct non-test symbols that write or read a table.
type TableSummary struct {
	Table                *Node
	GoWriters, TSWriters int
	GoReaders, TSReaders int
}

// IsTestCode reports whether n lives in test code (Go _test.go, vitest files).
func IsTestCode(n *Node) bool {
	return n.Kind.IsTest() || strings.HasSuffix(n.Pos.File, "_test.go") || IsTSTestFile(n.Pos.File)
}

// Overview computes the summary.
func (g *Graph) Overview() Overview {
	ov := Overview{GoKinds: map[Kind]int{}, TSKinds: map[Kind]int{}, Notes: g.Notes}
	services := map[string]*ServiceSummary{}
	areas := map[string]*AreaSummary{}
	for _, n := range g.SortedNodes() {
		ov.Edges += len(g.Out[n.ID])
		switch n.Lang {
		case LangGo:
			ov.GoKinds[n.Kind]++
			countArea(areas, "go:"+path.Dir(n.Pos.File), n.Kind)
		case LangTS:
			ov.TSKinds[n.Kind]++
			countArea(areas, "ts:"+frontendArea(n.Pos.File), n.Kind)
		case LangSQL:
			ov.Tables++
			ov.TableUse = append(ov.TableUse, g.tableSummary(n))
		}
		if n.Bound != "" {
			key := path.Dir(n.Pos.File) + "." + n.Bound
			s := services[key]
			if s == nil {
				s = &ServiceSummary{Name: n.Bound, Dir: path.Dir(n.Pos.File)}
				services[key] = s
			}
			s.Methods++
			hub := g.Hub(n)
			if hub == nil {
				hub = n
			}
			if s.Contract == "" && hub != n {
				if parent := g.Nodes[hub.Parent]; parent != nil {
					s.Contract = parent.Name
				}
			}
			if !g.reachedFromUI(n, hub) {
				s.NoUI = append(s.NoUI, n.Name[strings.LastIndexByte(n.Name, '.')+1:])
			}
		}
	}
	for _, s := range services {
		ov.Services = append(ov.Services, *s)
	}
	slices.SortFunc(ov.Services, func(a, b ServiceSummary) int { return cmp.Compare(b.Methods, a.Methods) })
	for key, a := range areas {
		if strings.HasPrefix(key, "go:") {
			ov.Packages = append(ov.Packages, *a)
		} else {
			ov.Frontend = append(ov.Frontend, *a)
		}
	}
	byTotal := func(a, b AreaSummary) int { return cmp.Or(cmp.Compare(b.Total, a.Total), cmp.Compare(a.Dir, b.Dir)) }
	slices.SortFunc(ov.Packages, byTotal)
	slices.SortFunc(ov.Frontend, byTotal)
	slices.SortFunc(ov.TableUse, func(a, b TableSummary) int {
		return cmp.Or(cmp.Compare(b.GoWriters+b.TSWriters, a.GoWriters+a.TSWriters), cmp.Compare(a.Table.Name, b.Table.Name))
	})
	return ov
}

func countArea(areas map[string]*AreaSummary, key string, k Kind) {
	a := areas[key]
	if a == nil {
		a = &AreaSummary{Dir: key[3:], Counts: map[Kind]int{}}
		areas[key] = a
	}
	a.Counts[k]++
	a.Total++
}

// frontendArea groups TS files by their first folder under src
// (frontend/src/components, frontend/src/engine, …).
func frontendArea(file string) string {
	parts := strings.Split(file, "/")
	for i, p := range parts {
		if p == "src" && i+2 < len(parts) {
			return strings.Join(parts[:i+2], "/")
		}
	}
	return path.Dir(file)
}

// reachedFromUI: some non-test TypeScript calls n directly or through its contract member.
func (g *Graph) reachedFromUI(n, hub *Node) bool {
	for _, id := range []string{n.ID, hub.ID} {
		for _, e := range g.In[id] {
			from := g.Nodes[e.From]
			if from.Lang == LangTS && e.Kind != EdgeDispatch && !IsTestCode(from) {
				return true
			}
		}
	}
	return false
}

func (g *Graph) tableSummary(t *Node) TableSummary {
	s := TableSummary{Table: t}
	seen := map[string]bool{}
	for _, e := range g.In[t.ID] {
		from := g.Nodes[e.From]
		key := e.From + e.Kind.String()
		if IsTestCode(from) || seen[key] {
			continue
		}
		seen[key] = true
		switch {
		case e.Kind == EdgeWrite && from.Lang == LangGo:
			s.GoWriters++
		case e.Kind == EdgeWrite:
			s.TSWriters++
		case e.Kind == EdgeRead && from.Lang == LangGo:
			s.GoReaders++
		case e.Kind == EdgeRead:
			s.TSReaders++
		}
	}
	return s
}
