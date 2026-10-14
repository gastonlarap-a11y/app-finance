// Package graph is codemap's language-neutral model of the repository: Go and
// TypeScript symbols, SQL tables, and the edges between them (calls, renders,
// Wails dispatch across the Go⇄TS boundary, table reads and writes).
//
// The index package builds a Graph; the query and text files answer questions
// over it (search, symbol, trace, impact) for the CLI, the MCP server and the
// viewer alike.
package graph

import (
	"cmp"
	"slices"
)

// Lang is the language a node is written in.
type Lang uint8

const (
	LangGo Lang = iota + 1
	LangTS
	LangSQL
)

func (l Lang) String() string {
	switch l {
	case LangGo:
		return "go"
	case LangTS:
		return "ts"
	case LangSQL:
		return "sql"
	}
	return "?"
}

// Kind says what a node is.
type Kind uint8

const (
	KindFunc Kind = iota + 1
	KindMethod
	KindType
	KindComponent
	KindHook
	// KindContractMethod is a member of a services/contract.ts *ServiceContract:
	// the hub that TS callers point to and that dispatches to Go (desktop) and to
	// the web engine.
	KindContractMethod
	// KindEngineMethod implements a contract member in TS (web/PWA target).
	KindEngineMethod
	KindTable
	KindTestFunc
	KindTestFile
	KindModule
)

var kindNames = map[Kind]string{
	KindFunc:           "func",
	KindMethod:         "method",
	KindType:           "type",
	KindComponent:      "component",
	KindHook:           "hook",
	KindContractMethod: "contract",
	KindEngineMethod:   "engine",
	KindTable:          "table",
	KindTestFunc:       "test",
	KindTestFile:       "testfile",
	KindModule:         "module",
}

func (k Kind) String() string {
	if s, ok := kindNames[k]; ok {
		return s
	}
	return "?"
}

// ParseKind is the inverse of Kind.String; ok is false for an unknown name.
func ParseKind(s string) (Kind, bool) {
	for k, name := range kindNames {
		if name == s {
			return k, true
		}
	}
	return 0, false
}

// IsTest reports whether the node is test code (a Go test function or a TS test file).
func (k Kind) IsTest() bool { return k == KindTestFunc || k == KindTestFile }

// EdgeKind says how two nodes relate.
type EdgeKind uint8

const (
	EdgeCall EdgeKind = iota + 1
	// EdgeRef: a function used as a value (handler, callback, method value).
	EdgeRef
	// EdgeRender: a React component renders another (JSX).
	EdgeRender
	// EdgeDispatch: a contract member (or Go interface) reaches its
	// implementation; Edge.Target says on which build ("desktop" or "web").
	EdgeDispatch
	EdgeRead
	EdgeWrite
	// EdgeMention: code names a table without a recognizable verb (a table
	// name passed to a generic helper).
	EdgeMention
)

var edgeNames = map[EdgeKind]string{
	EdgeCall:     "call",
	EdgeRef:      "ref",
	EdgeRender:   "render",
	EdgeDispatch: "dispatch",
	EdgeRead:     "read",
	EdgeWrite:    "write",
	EdgeMention:  "mention",
}

func (k EdgeKind) String() string {
	if s, ok := edgeNames[k]; ok {
		return s
	}
	return "?"
}

// IsData reports whether the edge reaches a table.
func (k EdgeKind) IsData() bool { return k == EdgeRead || k == EdgeWrite || k == EdgeMention }

// Dispatch targets.
const (
	TargetDesktop = "desktop"
	TargetWeb     = "web"
)

// Pos is a source range. File is repo-relative with forward slashes.
type Pos struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine,omitempty"`
}

// IsZero reports whether the position is unknown.
func (p Pos) IsZero() bool { return p.File == "" }

// Node is one symbol or table.
type Node struct {
	// ID is unique and stable across runs: "go:<pkgpath>.<Recv>.<Name>",
	// "ts:<relpath>#<Outer.Name>" (a bare "ts:<relpath>" is the module itself)
	// or "sql:<table>".
	ID string
	// Name is what people search for: "finance.FinanceService.CreateExpense",
	// "FinanceServiceContract.CreateExpense", "ExpenseForm.onSubmit", "expenses".
	Name      string
	Lang      Lang
	Kind      Kind
	Pos       Pos
	Signature string
	// Doc is the first sentence of the declaration's comment.
	Doc string
	// Parent is the ID of the enclosing type, function or object, if any.
	Parent string
	// Bound names the Go service type when Wails exposes this method to TS.
	Bound string
	// Unresolved lists places whose callee or table is only known at run time
	// (a table name in a variable): shown to readers, never silently dropped.
	Unresolved []Pos
}

// PosOrZero is n's position, or the zero Pos for a nil node (an edge to code
// that was not indexed).
func (n *Node) PosOrZero() Pos {
	if n == nil {
		return Pos{}
	}
	return n.Pos
}

// Edge is a directed relation From → To; At is where it happens (the call site).
type Edge struct {
	From, To string
	Kind     EdgeKind
	Target   string
	At       Pos
}

type edgeKey struct {
	from, to, target string
	kind             EdgeKind
	at               Pos
}

// Graph holds the whole map. Build it with AddNode/AddEdge, then call Finish
// once before querying.
type Graph struct {
	Nodes map[string]*Node
	Out   map[string][]Edge
	In    map[string][]Edge
	// Notes explains degraded results ("TypeScript not indexed: …").
	Notes []string

	seen map[edgeKey]struct{}
}

// New returns an empty graph.
func New() *Graph {
	return &Graph{
		Nodes: map[string]*Node{},
		Out:   map[string][]Edge{},
		In:    map[string][]Edge{},
		seen:  map[edgeKey]struct{}{},
	}
}

// AddNode inserts n unless a node with its ID exists; it returns the stored node.
func (g *Graph) AddNode(n *Node) *Node {
	if old, ok := g.Nodes[n.ID]; ok {
		return old
	}
	g.Nodes[n.ID] = n
	return n
}

// AddEdge inserts e once; edges to or from unknown nodes are dropped (a call
// into code that was not indexed, like the standard library).
func (g *Graph) AddEdge(e Edge) {
	if g.Nodes[e.From] == nil || g.Nodes[e.To] == nil || e.From == e.To {
		return
	}
	k := edgeKey{from: e.From, to: e.To, target: e.Target, kind: e.Kind, at: e.At}
	if _, dup := g.seen[k]; dup {
		return
	}
	g.seen[k] = struct{}{}
	g.Out[e.From] = append(g.Out[e.From], e)
	g.In[e.To] = append(g.In[e.To], e)
}

// Note records a degraded-mode explanation.
func (g *Graph) Note(msg string) { g.Notes = append(g.Notes, msg) }

// Finish sorts every adjacency list so output is deterministic.
func (g *Graph) Finish() {
	for _, list := range g.Out {
		slices.SortFunc(list, compareEdges(func(e Edge) string { return e.To }))
	}
	for _, list := range g.In {
		slices.SortFunc(list, compareEdges(func(e Edge) string { return e.From }))
	}
	g.seen = nil
}

func compareEdges(other func(Edge) string) func(a, b Edge) int {
	return func(a, b Edge) int {
		return cmp.Or(
			cmp.Compare(a.Kind, b.Kind),
			cmp.Compare(other(a), other(b)),
			cmp.Compare(a.At.File, b.At.File),
			cmp.Compare(a.At.Line, b.At.Line),
			cmp.Compare(a.Target, b.Target),
		)
	}
}

// SortedNodes returns every node ordered by ID.
func (g *Graph) SortedNodes() []*Node {
	nodes := make([]*Node, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		nodes = append(nodes, n)
	}
	slices.SortFunc(nodes, func(a, b *Node) int { return cmp.Compare(a.ID, b.ID) })
	return nodes
}
