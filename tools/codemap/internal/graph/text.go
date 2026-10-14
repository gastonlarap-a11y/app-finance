package graph

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// MaxChars is the default size of one answer: about 2k tokens, enough for an
// agent to act on without flooding its context.
const MaxChars = 8000

// listLimit caps every list inside an answer.
const listLimit = 15

// Loc is "file:line" or "file:start-end".
func Loc(p Pos) string {
	switch {
	case p.IsZero():
		return "?"
	case p.EndLine > p.Line:
		return fmt.Sprintf("%s:%d-%d", p.File, p.Line, p.EndLine)
	}
	return fmt.Sprintf("%s:%d", p.File, p.Line)
}

// Tag is "[go method · bound FinanceService]".
func Tag(n *Node) string {
	tag := n.Lang.String() + " " + n.Kind.String()
	if n.Bound != "" {
		tag += " · bound " + n.Bound
	}
	return "[" + tag + "]"
}

// Clip cuts text at a line boundary to at most maxChars, saying how much was left out.
func Clip(text string, maxChars int) string {
	if len(text) <= maxChars {
		return text
	}
	cut := strings.LastIndexByte(text[:maxChars], '\n')
	if cut < 0 {
		cut = maxChars
	}
	rest := strings.Count(text[cut:], "\n")
	return text[:cut] + fmt.Sprintf("\n… (%d líneas más: acota la consulta)\n", rest)
}

// bullets writes up to listLimit lines and a "… y N más" line.
func bullets[T any](b *strings.Builder, items []T, line func(T) string) {
	for i, it := range items {
		if i == listLimit {
			fmt.Fprintf(b, "    … y %d más\n", len(items)-listLimit)
			return
		}
		fmt.Fprintf(b, "    %s\n", line(it))
	}
}

// SearchText renders search hits.
func SearchText(query string, hits []*Node) string {
	if len(hits) == 0 {
		return fmt.Sprintf("Sin resultados para %q.\n", query)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d resultados para %q:\n", len(hits), query)
	for _, n := range hits {
		fmt.Fprintf(&b, "  %s %s  %s\n", n.Name, Tag(n), Loc(n.Pos))
	}
	return b.String()
}

// CandidatesText answers an ambiguous or unknown name.
func CandidatesText(name string, candidates []*Node) string {
	if len(candidates) == 0 {
		return fmt.Sprintf("No encontré %q. Prueba codemap_search con parte del nombre.\n", name)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%q es ambiguo (%d coincidencias). Repite con el nombre completo o el ID:\n", name, len(candidates))
	bullets(&b, candidates, func(n *Node) string { return fmt.Sprintf("%s %s  %s  id=%s", n.Name, Tag(n), Loc(n.Pos), n.ID) })
	return b.String()
}

// SymbolText explains one symbol: where it is, what it mirrors, who calls it,
// what it calls and which tables it ends up reading or writing.
func SymbolText(g *Graph, n *Node) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s\n  %s\n", n.Name, Tag(n), Loc(n.Pos))
	if n.Signature != "" {
		fmt.Fprintf(&b, "  %s\n", n.Signature)
	}
	if n.Doc != "" {
		fmt.Fprintf(&b, "  Doc: %s\n", n.Doc)
	}
	if parent := g.Nodes[n.Parent]; parent != nil {
		fmt.Fprintf(&b, "  Dentro de: %s  %s\n", parent.Name, Loc(parent.Pos))
	}
	if n.Kind == KindTable {
		tableText(&b, g, n)
		return b.String()
	}
	if hub := g.Hub(n); hub != nil {
		b.WriteString("Espejos Go⇄TS (cambian juntos):\n")
		fmt.Fprintf(&b, "    contrato  %s  %s\n", hub.Name, Loc(hub.Pos))
		for _, m := range g.Mirrors(hub) {
			fmt.Fprintf(&b, "    %-8s  %s  %s\n", m.Target, m.Node.Name, Loc(m.Node.Pos))
		}
	}
	if n.Kind == KindType {
		var members []*Node
		for _, m := range g.Nodes {
			if m.Parent == n.ID {
				members = append(members, m)
			}
		}
		sortNodes(members)
		if len(members) > 0 {
			fmt.Fprintf(&b, "Miembros (%d):\n", len(members))
			bullets(&b, members, func(m *Node) string { return fmt.Sprintf("%s  %s", m.Name, Loc(m.Pos)) })
		}
	}
	callers := g.Callers(n)
	var prod, tests []Caller
	for _, c := range callers {
		if IsTestCode(c.Node) {
			// A TS test reaching a Go method through the contract exercises the
			// web engine, not this code.
			if !c.ViaContract || n.Lang != LangGo {
				tests = append(tests, c)
			}
		} else {
			prod = append(prod, c)
		}
	}
	if len(prod) > 0 {
		fmt.Fprintf(&b, "Llamado por (%d):\n", len(prod))
		bullets(&b, prod, func(c Caller) string {
			via := ""
			if c.ViaContract {
				via = "  (vía contrato)"
			}
			return fmt.Sprintf("%s %s %s  @%s%s", c.Edge.Kind, c.Node.Name, Tag(c.Node), Loc(c.Edge.At), via)
		})
	}
	if callees := g.Callees(n); len(callees) > 0 {
		fmt.Fprintf(&b, "Llama a (%d):\n", len(callees))
		bullets(&b, callees, func(e Edge) string {
			to := g.Nodes[e.To]
			return fmt.Sprintf("%s %s %s  @%s", e.Kind, to.Name, Tag(to), Loc(e.At))
		})
	}
	if g.ReachesBoundary(n) && n.Kind != KindEngineMethod && n.Bound == "" {
		tablesText(&b, g, n, TargetDesktop)
		tablesText(&b, g, n, TargetWeb)
	} else {
		tablesText(&b, g, n, "")
	}
	if len(n.Unresolved) > 0 {
		b.WriteString("Sin resolver (tabla o llamada armada en tiempo de ejecución):\n")
		bullets(&b, n.Unresolved, Loc)
	}
	if len(tests) > 0 {
		files := map[string]bool{}
		for _, c := range tests {
			files[c.Node.Pos.File] = true
		}
		fmt.Fprintf(&b, "Tests que lo llaman directamente: %d (en %s; codemap_impact da los comandos)\n",
			len(tests), strings.Join(firstN(slices.Sorted(maps.Keys(files)), 5), ", "))
	}
	return b.String()
}

func tablesText(b *strings.Builder, g *Graph, n *Node, target string) {
	uses := g.Tables(n, target)
	if len(uses) == 0 {
		return
	}
	title := "Tablas"
	if target != "" {
		title += " (" + target + ")"
	}
	fmt.Fprintf(b, "%s:\n", title)
	bullets(b, uses, func(u TableUse) string {
		var verbs []string
		if u.Write {
			verbs = append(verbs, "escribe")
		}
		if u.Read {
			verbs = append(verbs, "lee")
		}
		if len(verbs) == 0 {
			verbs = append(verbs, "menciona")
		}
		how := "directo"
		if !u.Direct && u.Via != nil {
			how = "vía " + u.Via.Name
		}
		return fmt.Sprintf("%s %s  (%s)", strings.Join(verbs, "+"), u.Table.Name, how)
	})
}

func tableText(b *strings.Builder, g *Graph, t *Node) {
	var writers, readers, others []Edge
	for _, e := range g.In[t.ID] {
		if IsTestCode(g.Nodes[e.From]) {
			continue
		}
		switch e.Kind {
		case EdgeWrite:
			writers = append(writers, e)
		case EdgeRead:
			readers = append(readers, e)
		default:
			others = append(others, e)
		}
	}
	for _, sec := range []struct {
		title string
		edges []Edge
	}{{"Escriben", writers}, {"Leen", readers}, {"La mencionan", others}} {
		if len(sec.edges) == 0 {
			continue
		}
		fmt.Fprintf(b, "%s (%d):\n", sec.title, len(sec.edges))
		bullets(b, sec.edges, func(e Edge) string {
			from := g.Nodes[e.From]
			return fmt.Sprintf("%s %s  @%s", from.Name, Tag(from), Loc(e.At))
		})
	}
}

// TraceText renders a flow as an indented tree.
func TraceText(root *TraceNode, opt TraceOptions) string {
	var b strings.Builder
	target := opt.Target
	if target == "" {
		target = "desktop y web"
	}
	scope := "solo ramas que llegan a datos o al límite Go⇄TS"
	if opt.Full {
		scope = "todas las ramas"
	}
	fmt.Fprintf(&b, "Flujo desde %s %s — destino: %s; %s\n", root.Node.Name, Tag(root.Node), target, scope)
	fmt.Fprintf(&b, "%s  %s\n", root.Node.Name, Loc(root.Node.Pos))
	traceLines(&b, root, "")
	if len(root.Children) == 0 {
		b.WriteString("  (no llega a ninguna tabla ni al límite Go⇄TS; prueba full=true)\n")
	}
	return b.String()
}

func traceLines(b *strings.Builder, tn *TraceNode, indent string) {
	for i, c := range tn.Children {
		branch, next := "├─ ", "│  "
		if i == len(tn.Children)-1 && !tn.Truncated {
			branch, next = "└─ ", "   "
		}
		label := c.Via.Kind.String()
		if c.Via.Kind == EdgeDispatch {
			label = "[" + c.Via.Target + "]"
		}
		line := fmt.Sprintf("%s%s%s %s  %s", indent, branch, label, c.Node.Name, Loc(c.Node.Pos))
		if c.Via.Kind != EdgeDispatch && !c.Via.At.IsZero() {
			line += "  @" + Loc(c.Via.At)
		}
		if c.Repeat {
			line += "  (expandido arriba)"
		}
		fmt.Fprintln(b, line)
		traceLines(b, c, indent+next)
	}
	if tn.Truncated {
		fmt.Fprintf(b, "%s└─ … (límite de profundidad o tamaño; traza desde un nodo más abajo)\n", indent)
	}
}

// ImpactText renders what may break when a symbol changes, with ready-to-run test commands.
func ImpactText(im *Impact) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Impacto de cambiar %s %s  %s\n", im.Root.Name, Tag(im.Root), Loc(im.Root.Pos))
	if im.Hub != nil {
		b.WriteString("Cambian juntos (paridad Go⇄TS):\n")
		fmt.Fprintf(&b, "    contrato  %s  %s\n", im.Hub.Name, Loc(im.Hub.Pos))
		for _, m := range im.Mirrors {
			fmt.Fprintf(&b, "    %-8s  %s  %s\n", m.Target, m.Node.Name, Loc(m.Node.Pos))
		}
	}
	if len(im.Levels) == 0 {
		b.WriteString("Nadie lo llama fuera de los tests.\n")
	}
	for i, level := range im.Levels {
		fmt.Fprintf(&b, "Nivel %d (%d):\n", i+1, len(level))
		bullets(&b, level, func(n *Node) string { return fmt.Sprintf("%s %s  %s", n.Name, Tag(n), Loc(n.Pos)) })
	}
	if len(im.UI) > 0 {
		fmt.Fprintf(&b, "UI afectada (%d):\n", len(im.UI))
		bullets(&b, im.UI, func(n *Node) string { return fmt.Sprintf("%s  %s", n.Name, Loc(n.Pos)) })
	}
	b.WriteString(TestCommands(im))
	return b.String()
}

// TestCommands are the commands that run every test the impact reached.
func TestCommands(im *Impact) string {
	if len(im.GoTests) == 0 && len(im.TSTests) == 0 {
		return "Ningún test lo alcanza: considera agregar uno.\n"
	}
	var b strings.Builder
	b.WriteString("Tests a correr:\n")
	for _, dir := range slices.Sorted(maps.Keys(im.GoTests)) {
		fmt.Fprintf(&b, "    go test -race -run '^(%s)$' ./%s\n", strings.Join(im.GoTests[dir], "|"), dir)
	}
	var unit, browser []string
	for _, f := range im.TSTests {
		rel := strings.TrimPrefix(f, "frontend/")
		if strings.HasSuffix(f, ".dom.test.tsx") {
			browser = append(browser, rel)
		} else {
			unit = append(unit, rel)
		}
	}
	if len(unit) > 0 {
		fmt.Fprintf(&b, "    cd frontend && npx vitest run --project unit %s\n", strings.Join(unit, " "))
	}
	if len(browser) > 0 {
		fmt.Fprintf(&b, "    cd frontend && npx vitest run --project browser %s\n", strings.Join(browser, " "))
	}
	return b.String()
}

// OverviewText renders the architecture summary.
func OverviewText(ov Overview) string {
	var b strings.Builder
	total := func(m map[Kind]int) (n int) {
		for _, c := range m {
			n += c
		}
		return n
	}
	fmt.Fprintf(&b, "Mapa: Go %d símbolos %s · TS %d símbolos %s · %d tablas · %d relaciones\n",
		total(ov.GoKinds), kindCounts(ov.GoKinds), total(ov.TSKinds), kindCounts(ov.TSKinds), ov.Tables, ov.Edges)
	if len(ov.Services) > 0 {
		b.WriteString("Servicios Wails (métodos Go expuestos a TS):\n")
		bullets(&b, ov.Services, func(s ServiceSummary) string {
			line := fmt.Sprintf("%s  %s  %d métodos", s.Name, s.Dir, s.Methods)
			if s.Contract != "" {
				line += "  contrato " + s.Contract
			}
			if len(s.NoUI) > 0 {
				line += fmt.Sprintf("  · %d sin uso desde la UI: %s", len(s.NoUI), strings.Join(firstN(s.NoUI, 8), ", "))
			}
			return line
		})
	}
	areas := func(title string, items []AreaSummary) {
		if len(items) == 0 {
			return
		}
		fmt.Fprintf(&b, "%s:\n", title)
		bullets(&b, items, func(a AreaSummary) string { return fmt.Sprintf("%s  %d %s", a.Dir, a.Total, kindCounts(a.Counts)) })
	}
	areas("Paquetes Go", ov.Packages)
	areas("Frontend", ov.Frontend)
	if len(ov.TableUse) > 0 {
		b.WriteString("Tablas (símbolos que escriben / leen, Go·TS):\n")
		bullets(&b, ov.TableUse, func(t TableSummary) string {
			return fmt.Sprintf("%-26s escriben %d·%d  leen %d·%d", t.Table.Name, t.GoWriters, t.TSWriters, t.GoReaders, t.TSReaders)
		})
	}
	for _, note := range ov.Notes {
		fmt.Fprintf(&b, "Nota: %s\n", note)
	}
	return b.String()
}

func kindCounts(m map[Kind]int) string {
	kinds := slices.Sorted(maps.Keys(m))
	parts := make([]string, 0, len(kinds))
	for _, k := range kinds {
		parts = append(parts, fmt.Sprintf("%d %s", m[k], k))
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

func firstN(items []string, n int) []string {
	if len(items) <= n {
		return items
	}
	return append(slices.Clone(items[:n]), "…")
}
