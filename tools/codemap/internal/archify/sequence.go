package archify

import (
	"errors"
	"fmt"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

const (
	firstMessageY = 170.0
	messageStep   = 28.0 // Archify's spacing for messages without notes
	segmentGap    = 16.0
	maxMessages   = 40
	// Archify narrows every lifeline as participants are added (86px at
	// seven), so names stay short and all tables share one "SQLite" lifeline:
	// each message names its table instead.
	maxLabel = 16
)

// SequenceOptions shapes a flow diagram.
type SequenceOptions struct {
	Output string // portable POSIX path of the HTML, relative to the repository root
	Target string // graph.TargetDesktop or graph.TargetWeb
}

// ErrNoFlow means the symbol reaches no table and no contract on that build.
var ErrNoFlow = errors.New("el flujo no llega a ninguna tabla ni al contrato en ese build")

// Sequence draws one traced flow on one build, in call order: the UI calls a
// contract member, the contract dispatches to the Go service (desktop) or the
// TS engine (web), and the code behind it reads and writes tables. Calls
// between functions of the same layer stay inside its lifeline.
func Sequence(g *graph.Graph, from *graph.Node, repo Repo, opt SequenceOptions) (SequenceDiagram, error) {
	b := &seqBuilder{
		g: g, repo: repo, ids: ids{}, byKey: map[string]int{}, y: firstMessageY,
		touched: map[string]bool{}, tables: map[string]bool{},
	}
	start := b.startRole(from)
	b.walk(g.Trace(from, graph.TraceOptions{Target: opt.Target, Budget: 600}), start)
	if len(b.messages) == 0 || len(b.participants) < 2 {
		return SequenceDiagram{}, ErrNoFlow
	}
	if i, ok := b.byKey["db"]; ok {
		b.participants[i].Sublabel = count(len(b.tables), "tabla", "tablas")
	}
	cited := false
	for i := range b.participants {
		b.participants[i].Sources = repo.Cite(b.sources[i]...)
		cited = cited || len(b.participants[i].Sources) > 0
	}
	d := SequenceDiagram{
		SchemaVersion: 1,
		DiagramType:   TypeSequence,
		Meta: Meta{
			Title:          clip(fmt.Sprintf("Flujo %s (%s)", from.Name, opt.Target), 80),
			Output:         opt.Output,
			Locale:         "es",
			QualityProfile: "standard",
			Repository:     repo.pinned(cited),
		},
		Participants: b.participants,
		Segments:     b.segments,
		Messages:     b.messages,
	}
	if card := b.notes(); card != nil {
		d.Cards = []Card{*card}
	}
	return d, nil
}

type seqBuilder struct {
	g            *graph.Graph
	repo         Repo
	ids          ids
	participants []Participant
	sources      [][]graph.Pos
	byKey        map[string]int // role key → participant index
	messages     []Message
	segments     []Segment
	y            float64
	dropped      int
	touched      map[string]bool // toucher|table|kind already drawn
	tables       map[string]bool // tables drawn so far
	unresolved   []graph.Pos
}

// role is one lifeline: its key and how to create it.
type role struct {
	key   string
	kind  string // Archify component type
	label string
	sub   string
	pos   graph.Pos
}

func (b *seqBuilder) startRole(n *graph.Node) role {
	switch {
	case n.Kind == graph.KindContractMethod:
		return b.contractRole(n)
	case n.Lang == graph.LangTS && n.Kind != graph.KindEngineMethod:
		// "ExpenseForm.submit": the component names the lifeline, the handler is its sublabel.
		label, sub := n.Name, "UI"
		if i := strings.IndexByte(n.Name, '.'); i > 0 {
			label, sub = n.Name[:i], n.Name[i+1:]
		}
		return role{key: "ui", kind: "frontend", label: clip(label, maxLabel), sub: clip(sub, 28), pos: n.Pos}
	}
	return b.implRole(n, "")
}

func (b *seqBuilder) contractRole(n *graph.Node) role {
	sub := "contract.ts"
	if p := b.g.Nodes[n.Parent]; p != nil {
		sub = p.Name
	}
	return role{key: "contract", kind: "frontend", label: "Contrato", sub: clip(sub, 28), pos: n.Pos}
}

// implRole is the lifeline of the code behind the contract on one build.
func (b *seqBuilder) implRole(n *graph.Node, target string) role {
	if n.Lang == graph.LangGo {
		name := n.Bound
		if name == "" {
			name = n.Name[:max(0, len(n.Name)-len(lastPart(n.Name))-1)]
		}
		return role{key: "go:" + name, kind: "backend", label: clip(name, maxLabel), sub: "Go (desktop)", pos: n.Pos}
	}
	owner := n.Name
	if p := b.g.Nodes[n.Parent]; p != nil {
		owner = p.Name
	}
	label := clip(owner, maxLabel)
	if target == graph.TargetWeb || n.Kind == graph.KindEngineMethod {
		label = "Motor TS"
	}
	return role{key: "ts:" + owner, kind: "backend", label: label, sub: clip(owner, 28), pos: n.Pos}
}

// lifeline returns the participant ID of r, adding it on first use.
func (b *seqBuilder) lifeline(r role) string {
	if i, ok := b.byKey[r.key]; ok {
		if len(b.sources[i]) < 3 {
			b.sources[i] = append(b.sources[i], r.pos)
		}
		return b.participants[i].ID
	}
	b.byKey[r.key] = len(b.participants)
	b.participants = append(b.participants, Participant{ID: b.ids.next(r.key), Type: r.kind, Label: r.label, Sublabel: r.sub})
	b.sources = append(b.sources, []graph.Pos{r.pos})
	return b.participants[len(b.participants)-1].ID
}

// dbRole is the one lifeline of every table; its sources cite the first tables used.
func (b *seqBuilder) dbRole(t *graph.Node) role {
	return role{key: "db", kind: "database", label: "SQLite", sub: "tablas", pos: graph.Pos{File: t.Pos.File, Line: t.Pos.Line}}
}

func (b *seqBuilder) message(from, to, label, variant string) {
	if from == to {
		return // Archify has no self-messages; work inside one lifeline stays implicit
	}
	if len(b.messages) == maxMessages {
		b.dropped++
		return
	}
	b.messages = append(b.messages, Message{From: from, To: to, Y: b.y, Label: clip(label, 40), Variant: variant})
	b.y += messageStep
}

// walk emits the messages below tn, whose code runs on the lifeline of cur.
func (b *seqBuilder) walk(tn *graph.TraceNode, cur role) {
	b.unresolved = append(b.unresolved, tn.Node.Unresolved...)
	for _, c := range tn.Children {
		switch {
		case c.Node.Kind == graph.KindContractMethod:
			b.call(c, cur)
		case c.Via.Kind == graph.EdgeDispatch:
			impl := b.implRole(c.Node, c.Via.Target)
			label := "binding Wails"
			if c.Via.Target == graph.TargetWeb {
				label = "worker (comlink)"
			}
			b.message(b.lifeline(cur), b.lifeline(impl), label, "")
			b.walk(c, impl)
		case c.Node.Kind == graph.KindTable:
			b.touch(tn.Node, c, cur)
		default:
			b.walk(c, cur) // a helper on the same lifeline
		}
	}
}

// call draws one contract call as a segment: request, the build's work, result.
func (b *seqBuilder) call(c *graph.TraceNode, caller role) {
	method := lastPart(c.Node.Name)
	top, first := b.y, len(b.messages)
	contract := b.contractRole(c.Node)
	callerID := b.lifeline(caller)
	b.message(callerID, b.lifeline(contract), method+"()", "emphasis")
	before := len(b.messages)
	b.walk(c, contract)
	if len(b.messages) > before {
		b.message(b.messages[before].To, callerID, "resultado", "return")
	}
	// Past maxMessages nothing is drawn: no empty band either.
	if len(b.messages) > first {
		b.segments = append(b.segments, Segment{From: top - 12, To: b.y - messageStep + 12, Label: clip(method, 32)})
		b.y += segmentGap
	}
}

// touch draws one table access by toucher, once per (toucher, table, verb).
func (b *seqBuilder) touch(toucher *graph.Node, c *graph.TraceNode, cur role) {
	verb := map[graph.EdgeKind]string{graph.EdgeRead: "lee", graph.EdgeWrite: "escribe"}[c.Via.Kind]
	if verb == "" {
		verb = "menciona"
	}
	key := toucher.ID + "|" + c.Node.ID + "|" + verb
	if b.touched[key] {
		return
	}
	b.touched[key] = true
	variant := ""
	if c.Via.Kind == graph.EdgeRead {
		variant = "dashed"
	}
	b.message(b.lifeline(cur), b.lifeline(b.dbRole(c.Node)), lastPart(toucher.Name)+": "+verb+" "+c.Node.Name, variant)
	b.tables[c.Node.Name] = true
}

// notes is a card with what the diagram leaves out, if anything.
func (b *seqBuilder) notes() *Card {
	var items []string
	if b.dropped > 0 {
		items = append(items, fmt.Sprintf("%d mensajes más no caben: traza desde un símbolo más abajo", b.dropped))
	}
	for i, p := range b.unresolved {
		if i == 5 {
			items = append(items, fmt.Sprintf("… y %d más", len(b.unresolved)-5))
			break
		}
		items = append(items, "tabla armada en tiempo de ejecución: "+graph.Loc(p))
	}
	if len(items) == 0 {
		return nil
	}
	return &Card{Dot: "amber", Title: "Lo que el diagrama no muestra", Items: items}
}
