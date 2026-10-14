package archify

import (
	"cmp"
	"fmt"
	"slices"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// Box size and the gaps between boxes, sized by Archify's authoring rules: a
// labeled edge between side-by-side boxes needs 6.5px per character + 21px.
const (
	boxW, boxH = 170.0, 64.0
	originX    = 40.0
	originY    = 40.0
)

// gapFor is the horizontal room a relationship label needs.
func gapFor(label string) float64 { return max(120, 6.5*float64(len([]rune(label)))+41) }

// ArchitectureOptions names the output.
type ArchitectureOptions struct {
	Output string // portable POSIX path of the HTML, relative to the repository root
}

// Architecture is the system overview: the React UI calls the contract,
// which runs on the Go services (desktop, Wails) or on the TS engine (web,
// iPad), each over its own SQLite. Counts and citations come from the graph.
func Architecture(g *graph.Graph, repo Repo, opt ArchitectureOptions) ArchitectureDiagram {
	s := summarize(g)
	id := ids{}
	ui, contract, goSvc, goDB, engine, webDB := id.next("ui"), id.next("contract"), id.next("go-services"),
		id.next("sqlite-desktop"), id.next("engine"), id.next("sqlite-web")

	callsLabel := count(s.uiCalls, "llamada", "llamadas")
	desktopLabel := "desktop · Wails"
	goDBLabel := fmt.Sprintf("escribe %d · lee %s", s.goWrites, count(s.goReads, "tabla", "tablas"))
	webDBLabel := fmt.Sprintf("escribe %d · lee %s", s.tsWrites, count(s.tsReads, "tabla", "tablas"))

	// Main path left to right on the top row; the web build hangs below the
	// contract, its store to its right.
	contractX := originX + boxW + gapFor(callsLabel)
	goX := contractX + boxW + gapFor(desktopLabel)
	goDBX := goX + boxW + gapFor(goDBLabel)
	webY := originY + boxH + 140
	webDBX := contractX + boxW + gapFor(webDBLabel)

	comps := []Component{
		{ID: ui, Type: "frontend", Label: "UI React",
			Sublabel: count(s.components, "componente", "componentes") + " · " + count(s.hooks, "hook", "hooks"),
			Sources:  repo.Cite(s.uiSources...), Pos: [2]float64{originX, originY}},
		{ID: contract, Type: "frontend", Label: "services/contract.ts",
			Sublabel: count(len(s.contracts), "contrato", "contratos") + " · " + count(s.contractMethods, "método", "métodos"),
			Sources:  repo.Cite(positions(s.contracts)...), Pos: [2]float64{contractX, originY}},
		{ID: goSvc, Type: "backend", Label: "Servicios Go",
			Sublabel: count(len(s.services), "servicio", "servicios") + " · " + count(s.boundMethods, "método", "métodos"),
			Sources:  repo.Cite(s.serviceSources...), Pos: [2]float64{goX, originY}},
		{ID: goDB, Type: "database", Label: "SQLite escritorio",
			Sublabel: count(s.migratedTables, "tabla", "tablas") + " (migraciones)",
			Sources:  repo.Cite(s.migrationSources...), Pos: [2]float64{goDBX, originY}},
		{ID: engine, Type: "backend", Label: "Motor TS (worker)",
			Sublabel: count(s.engineMethods, "método", "métodos") + " en " + count(len(s.engines), "servicio", "servicios"),
			Sources:  repo.Cite(positions(s.engines)...), Pos: [2]float64{contractX, webY}},
		{ID: webDB, Type: "database", Label: "SQLite web (OPFS)",
			Sublabel: count(s.migratedTables+len(s.webOnlyTables), "tabla", "tablas"),
			Sources:  repo.Cite(s.webTableSources...), Pos: [2]float64{webDBX, webY}},
	}
	cited := false
	for i := range comps {
		comps[i].Size = [2]float64{boxW, boxH}
		cited = cited || len(comps[i].Sources) > 0
	}

	return ArchitectureDiagram{
		SchemaVersion: 1,
		DiagramType:   TypeArchitecture,
		Meta: Meta{
			Title:          "Arquitectura: UI, contrato y los dos backends",
			Output:         opt.Output,
			Locale:         "es",
			QualityProfile: "standard",
			Repository:     repo.pinned(cited),
		},
		Components: comps,
		Boundaries: []Boundary{
			{Kind: "region", Label: "Escritorio (Wails, Go)", Wraps: []string{goSvc, goDB}},
			{Kind: "region", Label: "Web / iPad (PWA)", Wraps: []string{engine, webDB}},
		},
		Connections: []Connection{
			{ID: "ui-calls", From: ui, To: contract, Label: callsLabel, Variant: "emphasis"},
			{ID: "desktop-dispatch", From: contract, To: goSvc, Label: desktopLabel},
			// The one vertical edge: pin its ports and put the label in the gap
			// between the boxes, where the automatic placement would sit on the contract.
			{ID: "web-dispatch", From: contract, To: engine, Label: "web · worker", FromSide: "bottom", ToSide: "top",
				LabelAt: &[2]float64{contractX + boxW/2, (originY + boxH + webY) / 2}},
			{ID: "desktop-sql", From: goSvc, To: goDB, Label: goDBLabel},
			{ID: "web-sql", From: engine, To: webDB, Label: webDBLabel},
		},
		Cards: s.cards(),
	}
}

// summary is everything the overview counts.
type summary struct {
	components, hooks, uiCalls     int
	contracts, engines             []*graph.Node
	contractMethods, engineMethods int
	services                       []graph.ServiceSummary
	boundMethods                   int
	goWrites, goReads              int
	tsWrites, tsReads              int
	migratedTables                 int
	webOnlyTables                  []*graph.Node
	tableUse                       []graph.TableSummary
	uiSources, serviceSources      []graph.Pos
	migrationSources               []graph.Pos
	webTableSources                []graph.Pos
}

func summarize(g *graph.Graph) summary {
	var s summary
	ov := g.Overview()
	s.services, s.tableUse = ov.Services, ov.TableUse
	contracts, engines := map[string]*graph.Node{}, map[string]*graph.Node{}
	goTables := map[string]map[graph.EdgeKind]bool{}
	tsTables := map[string]map[graph.EdgeKind]bool{}
	for _, n := range g.SortedNodes() {
		if graph.IsTestCode(n) {
			continue
		}
		switch n.Kind {
		case graph.KindComponent:
			s.components++
			if lastPart(n.Name) == "App" {
				s.uiSources = append([]graph.Pos{n.Pos}, s.uiSources...)
			} else if len(s.uiSources) < 3 {
				s.uiSources = append(s.uiSources, n.Pos)
			}
		case graph.KindHook:
			s.hooks++
		case graph.KindContractMethod:
			s.contractMethods++
			if p := g.Nodes[n.Parent]; p != nil {
				contracts[p.ID] = p
			}
			for _, e := range g.In[n.ID] {
				if e.Kind == graph.EdgeCall && !graph.IsTestCode(g.Nodes[e.From]) {
					s.uiCalls++
				}
			}
		case graph.KindEngineMethod:
			s.engineMethods++
			if p := g.Nodes[n.Parent]; p != nil {
				engines[p.ID] = p
			}
		case graph.KindTable:
			s.countTable(n)
		}
		if n.Bound != "" {
			s.boundMethods++
		}
		for _, e := range g.Out[n.ID] {
			if e.Kind != graph.EdgeRead && e.Kind != graph.EdgeWrite {
				continue
			}
			byLang := goTables
			if n.Lang == graph.LangTS {
				byLang = tsTables
			}
			if byLang[e.To] == nil {
				byLang[e.To] = map[graph.EdgeKind]bool{}
			}
			byLang[e.To][e.Kind] = true
		}
	}
	s.goWrites, s.goReads = countKinds(goTables)
	s.tsWrites, s.tsReads = countKinds(tsTables)
	s.contracts, s.engines = sortedValues(contracts), sortedValues(engines)
	for _, svc := range s.services {
		if t := findType(g, svc); t != nil && len(s.serviceSources) < 3 {
			s.serviceSources = append(s.serviceSources, t.Pos)
		}
	}
	return s
}

func (s *summary) countTable(t *graph.Node) {
	if strings.HasSuffix(t.Pos.File, ".sql") {
		s.migratedTables++
		if len(s.migrationSources) < 3 {
			s.migrationSources = append(s.migrationSources, graph.Pos{File: t.Pos.File, Line: t.Pos.Line})
		}
		return
	}
	s.webOnlyTables = append(s.webOnlyTables, t)
	s.webTableSources = append(s.webTableSources, t.Pos)
}

func countKinds(tables map[string]map[graph.EdgeKind]bool) (writes, reads int) {
	for _, kinds := range tables {
		if kinds[graph.EdgeWrite] {
			writes++
		}
		if kinds[graph.EdgeRead] {
			reads++
		}
	}
	return writes, reads
}

func sortedValues(m map[string]*graph.Node) []*graph.Node {
	out := make([]*graph.Node, 0, len(m))
	for _, n := range m {
		out = append(out, n)
	}
	slices.SortFunc(out, func(a, b *graph.Node) int { return cmp.Compare(a.Name, b.Name) })
	return out
}

func positions(nodes []*graph.Node) []graph.Pos {
	out := make([]graph.Pos, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, graph.Pos{File: n.Pos.File, Line: n.Pos.Line})
	}
	return out
}

// findType is the Go type declaration of a bound service.
func findType(g *graph.Graph, svc graph.ServiceSummary) *graph.Node {
	for _, n := range g.SortedNodes() {
		if n.Lang == graph.LangGo && n.Kind == graph.KindType && lastPart(n.Name) == svc.Name &&
			strings.HasPrefix(n.Pos.File, svc.Dir+"/") && !strings.Contains(strings.TrimPrefix(n.Pos.File, svc.Dir+"/"), "/") {
			return n
		}
	}
	return nil
}

func (s summary) cards() []Card {
	var services, unused, direct []string
	for _, svc := range s.services {
		line := fmt.Sprintf("%s (%s) · %d métodos", svc.Name, svc.Dir, svc.Methods)
		if svc.Contract == "" {
			direct = append(direct, line)
		} else {
			services = append(services, line+" · "+svc.Contract)
		}
		for _, m := range svc.NoUI {
			unused = append(unused, svc.Name+"."+m)
		}
	}
	var hot []string
	for _, t := range s.tableUse {
		if len(hot) == 6 || t.GoWriters+t.TSWriters == 0 {
			break
		}
		hot = append(hot, fmt.Sprintf("%s · escriben %d Go / %d TS", t.Table.Name, t.GoWriters, t.TSWriters))
	}
	// An empty card would marshal its items as null, which Archify rejects.
	var cards []Card
	for _, c := range []Card{
		{Dot: "cyan", Title: "Servicios con contrato", Items: services},
		{Dot: "slate", Title: "Bindings directos (sin contrato)", Items: direct},
		{Dot: "amber", Title: "Tablas más escritas", Items: hot},
		{Dot: "rose", Title: "Métodos bound sin uso desde la UI", Items: unused},
	} {
		if len(c.Items) > 0 {
			cards = append(cards, c)
		}
	}
	return cards
}
