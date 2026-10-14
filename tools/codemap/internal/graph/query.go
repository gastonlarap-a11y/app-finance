package graph

import (
	"cmp"
	"path"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// Resolve finds the nodes a person means by name. It accepts an ID, a full or
// trailing name ("CreateExpense", "FinanceService.CreateExpense"), a TS file
// path, or "file:line" (the innermost symbol at that line). When the matches
// are one contract member and its implementations, the contract member alone
// is returned: it is the hub that shows all of them.
func (g *Graph) Resolve(name string) []*Node {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	if n := g.Nodes[name]; n != nil {
		return []*Node{n}
	}
	if n := g.Nodes["ts:"+name]; n != nil {
		return []*Node{n}
	}
	if file, line, ok := splitFileLine(name); ok {
		if n := g.innermostAt(file, line); n != nil {
			return []*Node{n}
		}
	}
	var exact, suffix, folded []*Node
	lower := strings.ToLower(name)
	for _, n := range g.Nodes {
		switch {
		case n.Name == name:
			exact = append(exact, n)
		case strings.HasSuffix(n.Name, "."+name):
			suffix = append(suffix, n)
		case strings.EqualFold(n.Name, name) || strings.HasSuffix(strings.ToLower(n.Name), "."+lower):
			folded = append(folded, n)
		}
	}
	for _, list := range [][]*Node{exact, suffix, folded} {
		if len(list) > 0 {
			sortNodes(list)
			return g.preferHub(list)
		}
	}
	return nil
}

func splitFileLine(s string) (string, int, bool) {
	i := strings.LastIndexByte(s, ':')
	if i <= 0 {
		return "", 0, false
	}
	line, err := strconv.Atoi(s[i+1:])
	if err != nil || line <= 0 {
		return "", 0, false
	}
	return s[:i], line, true
}

// innermostAt is the smallest symbol whose range holds file:line.
func (g *Graph) innermostAt(file string, line int) *Node {
	var best *Node
	for _, n := range g.Nodes {
		if n.Pos.File != file || n.Kind == KindModule || n.Kind == KindTestFile || n.Kind == KindTable {
			continue
		}
		end := max(n.Pos.EndLine, n.Pos.Line)
		if line < n.Pos.Line || line > end {
			continue
		}
		if best == nil || end-n.Pos.Line < max(best.Pos.EndLine, best.Pos.Line)-best.Pos.Line {
			best = n
		}
	}
	return best
}

// preferHub collapses {contract member, its implementations} to the member.
func (g *Graph) preferHub(list []*Node) []*Node {
	for _, hub := range list {
		if hub.Kind != KindContractMethod {
			continue
		}
		targets := map[string]bool{hub.ID: true}
		for _, e := range g.Out[hub.ID] {
			if e.Kind == EdgeDispatch {
				targets[e.To] = true
			}
		}
		if !slices.ContainsFunc(list, func(n *Node) bool { return !targets[n.ID] }) {
			return []*Node{hub}
		}
	}
	return list
}

func sortNodes(list []*Node) {
	slices.SortFunc(list, func(a, b *Node) int {
		return cmp.Or(cmp.Compare(kindRank(a.Kind), kindRank(b.Kind)), cmp.Compare(len(a.Name), len(b.Name)), cmp.Compare(a.ID, b.ID))
	})
}

// kindRank orders kinds by how likely a person is looking for them.
func kindRank(k Kind) int {
	switch k {
	case KindContractMethod:
		return 0
	case KindMethod, KindComponent:
		return 1
	case KindFunc, KindHook, KindEngineMethod, KindType:
		return 2
	case KindTable:
		return 3
	}
	return 4
}

// SearchOptions narrows Search.
type SearchOptions struct {
	Kind  Kind // 0 = any
	Lang  Lang // 0 = any
	Limit int  // default 25
}

// Search ranks nodes by how well their name matches query: exact, prefix,
// camel-hump initials ("CE" → CreateExpense), substring, then subsequence.
func (g *Graph) Search(query string, opt SearchOptions) []*Node {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil
	}
	if opt.Limit <= 0 {
		opt.Limit = 25
	}
	type hit struct {
		n     *Node
		score int
	}
	var hits []hit
	for _, n := range g.Nodes {
		if (opt.Kind != 0 && n.Kind != opt.Kind) || (opt.Lang != 0 && n.Lang != opt.Lang) {
			continue
		}
		if n.Kind == KindModule && opt.Kind != KindModule {
			continue
		}
		if s := matchScore(n.Name, query); s > 0 {
			hits = append(hits, hit{n, s - kindRank(n.Kind)})
		}
	}
	slices.SortFunc(hits, func(a, b hit) int {
		return cmp.Or(cmp.Compare(b.score, a.score), cmp.Compare(len(a.n.Name), len(b.n.Name)), cmp.Compare(a.n.ID, b.n.ID))
	})
	out := make([]*Node, 0, min(len(hits), opt.Limit))
	for _, h := range hits[:min(len(hits), opt.Limit)] {
		out = append(out, h.n)
	}
	return out
}

func matchScore(name, query string) int {
	last := name[strings.LastIndexByte(name, '.')+1:]
	ln, lq, ll := strings.ToLower(name), strings.ToLower(query), strings.ToLower(last)
	switch {
	case ll == lq || ln == lq:
		return 100
	case strings.HasPrefix(ll, lq):
		return 80
	case strings.HasPrefix(humps(last), strings.ToUpper(query)) && len(query) > 1:
		return 60
	case strings.Contains(ln, lq):
		return 40
	case isSubsequence(ln, lq):
		return 20
	}
	return 0
}

// humps is the initials of a camelCase or snake_case word: CreateExpense → CE.
func humps(word string) string {
	var b strings.Builder
	prev := '_'
	for _, r := range word {
		if unicode.IsUpper(r) || (prev == '_' && r != '_') {
			b.WriteRune(unicode.ToUpper(r))
		}
		prev = r
	}
	return b.String()
}

func isSubsequence(s, sub string) bool {
	i := 0
	for _, r := range s {
		if i < len(sub) && byte(r) == sub[i] {
			i++
		}
	}
	return i == len(sub)
}

// ---------- trace ----------

// TraceOptions shapes a Trace.
type TraceOptions struct {
	// Target follows only "desktop" or "web" dispatch; "" follows both.
	Target string
	// Depth limits the tree (default 8).
	Depth int
	// Full keeps every branch; by default only branches that reach data (a
	// table, or the Go⇄TS boundary) are kept.
	Full bool
	// Budget caps the number of tree nodes (default 300).
	Budget int
}

// TraceNode is one step of a flow; Via is the edge that led to it.
type TraceNode struct {
	Node     *Node
	Via      Edge
	Children []*TraceNode
	// Repeat: already expanded earlier in the tree.
	Repeat bool
	// Truncated: depth or budget reached while the node still had children.
	Truncated bool
}

// follows reports whether a trace walks e.
func follows(e Edge, target string) bool {
	switch e.Kind {
	case EdgeCall, EdgeRef, EdgeRender, EdgeRead, EdgeWrite, EdgeMention:
		return target == "" || e.Target == "" || e.Target == target
	case EdgeDispatch:
		return target == "" || e.Target == target
	}
	return false
}

// Trace walks the flow forward from a symbol: UI → contract → Go bound
// method (desktop) and web engine → helpers → tables. Asked for the other
// build's flow, an implementation (a Go bound method and web, an engine
// method and desktop) is traced from its contract member instead.
func (g *Graph) Trace(from *Node, opt TraceOptions) *TraceNode {
	if hub := g.Hub(from); opt.Target != "" && hub != nil && hub != from && g.dispatchTarget(hub, from) != opt.Target {
		from = hub
	}
	if opt.Depth <= 0 {
		opt.Depth = 8
	}
	if opt.Budget <= 0 {
		opt.Budget = 300
	}
	t := &tracer{g: g, opt: opt, expanded: map[string]bool{}, memo: map[string]int8{}}
	root := &TraceNode{Node: from}
	t.expand(root, 0)
	return root
}

type tracer struct {
	g        *Graph
	opt      TraceOptions
	expanded map[string]bool
	memo     map[string]int8 // 1 reaches data, -1 does not, 2 in progress
	used     int
}

func (t *tracer) expand(tn *TraceNode, depth int) {
	t.expanded[tn.Node.ID] = true
	for _, e := range t.g.Out[tn.Node.ID] {
		to := t.g.Nodes[e.To]
		if !follows(e, t.opt.Target) || to.Kind.IsTest() || (!t.opt.Full && !t.reachesData(to.ID)) {
			continue
		}
		if depth >= t.opt.Depth || t.used >= t.opt.Budget {
			tn.Truncated = true
			return
		}
		t.used++
		child := &TraceNode{Node: to, Via: e}
		tn.Children = append(tn.Children, child)
		if t.expanded[to.ID] {
			child.Repeat = len(t.g.Out[to.ID]) > 0
			continue
		}
		t.expand(child, depth+1)
	}
}

// reachesData: the node is a table or a Go⇄TS boundary, or leads to one.
func (t *tracer) reachesData(id string) bool {
	switch t.memo[id] {
	case 1:
		return true
	case -1, 2:
		return false
	}
	n := t.g.Nodes[id]
	if n.Kind == KindTable || n.Kind == KindContractMethod || n.Kind == KindEngineMethod || n.Bound != "" {
		t.memo[id] = 1
		return true
	}
	t.memo[id] = 2
	for _, e := range t.g.Out[id] {
		if follows(e, t.opt.Target) && !t.g.Nodes[e.To].Kind.IsTest() && t.reachesData(e.To) {
			t.memo[id] = 1
			return true
		}
	}
	t.memo[id] = -1
	return false
}

// ---------- tables ----------

// TableUse is how a symbol (directly or through its callees) uses one table.
type TableUse struct {
	Table  *Node
	Read   bool
	Write  bool
	Direct bool
	// Via is the nearest symbol that touches the table itself (nil if direct).
	Via *Node
}

// Tables lists the tables a symbol reaches through calls and dispatch
// (target "" = both builds), nearest first.
func (g *Graph) Tables(from *Node, target string) []TableUse {
	uses := map[string]*TableUse{}
	seen := map[string]bool{from.ID: true}
	queue := []string{from.ID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, e := range g.Out[cur] {
			if !follows(e, target) {
				continue
			}
			to := g.Nodes[e.To]
			if to.Kind == KindTable {
				u := uses[to.ID]
				if u == nil {
					u = &TableUse{Table: to, Direct: cur == from.ID}
					if !u.Direct {
						u.Via = g.Nodes[cur]
					}
					uses[to.ID] = u
				}
				u.Read = u.Read || e.Kind == EdgeRead
				u.Write = u.Write || e.Kind == EdgeWrite
				continue
			}
			if to.Kind.IsTest() || seen[to.ID] {
				continue
			}
			seen[to.ID] = true
			queue = append(queue, to.ID)
		}
	}
	out := make([]TableUse, 0, len(uses))
	for _, u := range uses {
		out = append(out, *u)
	}
	slices.SortFunc(out, func(a, b TableUse) int {
		return cmp.Or(compareBool(b.Direct, a.Direct), compareBool(b.Write, a.Write), cmp.Compare(a.Table.Name, b.Table.Name))
	})
	return out
}

func compareBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case a:
		return 1
	}
	return -1
}

// ReachesBoundary reports whether from leads to a contract member, i.e. its
// flow differs between the desktop and web builds.
func (g *Graph) ReachesBoundary(from *Node) bool {
	seen := map[string]bool{}
	var walk func(id string) bool
	walk = func(id string) bool {
		if seen[id] {
			return false
		}
		seen[id] = true
		if g.Nodes[id].Kind == KindContractMethod {
			return true
		}
		for _, e := range g.Out[id] {
			if follows(e, "") && !g.Nodes[e.To].Kind.IsTest() && walk(e.To) {
				return true
			}
		}
		return false
	}
	return walk(from.ID)
}

// ---------- mirrors and callers ----------

// Hub is the contract member n implements (or n itself when it is one), nil otherwise.
func (g *Graph) Hub(n *Node) *Node {
	if n.Kind == KindContractMethod {
		return n
	}
	for _, e := range g.In[n.ID] {
		if e.Kind == EdgeDispatch && g.Nodes[e.From].Kind == KindContractMethod {
			return g.Nodes[e.From]
		}
	}
	return nil
}

// dispatchTarget is the build on which hub dispatches to impl.
func (g *Graph) dispatchTarget(hub, impl *Node) string {
	for _, e := range g.Out[hub.ID] {
		if e.Kind == EdgeDispatch && e.To == impl.ID {
			return e.Target
		}
	}
	return ""
}

// Mirror is one implementation of a contract member on one build.
type Mirror struct {
	Target string
	Node   *Node
}

// Mirrors lists the implementations behind a contract member.
func (g *Graph) Mirrors(hub *Node) []Mirror {
	var out []Mirror
	for _, e := range g.Out[hub.ID] {
		if e.Kind == EdgeDispatch {
			out = append(out, Mirror{Target: e.Target, Node: g.Nodes[e.To]})
		}
	}
	return out
}

// Caller is a symbol that reaches n, with the edge it uses.
type Caller struct {
	Node *Node
	Edge Edge
	// ViaContract: the caller reaches n through its contract member.
	ViaContract bool
}

// Callers lists who calls, renders or references n; for an implementation of
// a contract member, the member's own callers too.
func (g *Graph) Callers(n *Node) []Caller {
	var out []Caller
	add := func(id string, via bool) {
		for _, e := range g.In[id] {
			if e.Kind == EdgeCall || e.Kind == EdgeRef || e.Kind == EdgeRender {
				out = append(out, Caller{Node: g.Nodes[e.From], Edge: e, ViaContract: via})
			}
		}
	}
	add(n.ID, false)
	if hub := g.Hub(n); hub != nil && hub != n {
		add(hub.ID, true)
	}
	return out
}

// Callees lists what n calls, renders or references (not tables, not dispatch).
func (g *Graph) Callees(n *Node) []Edge {
	var out []Edge
	for _, e := range g.Out[n.ID] {
		if e.Kind == EdgeCall || e.Kind == EdgeRef || e.Kind == EdgeRender {
			out = append(out, e)
		}
	}
	return out
}

// ---------- impact ----------

// Impact is what may break when a symbol changes.
type Impact struct {
	Root *Node
	// Levels[i] holds the symbols i+1 steps upstream (tests excluded).
	Levels [][]*Node
	// UI holds the components and hooks reached.
	UI []*Node
	// Hub and Mirrors: a contract member's implementations change together.
	Hub     *Node
	Mirrors []Mirror
	// GoTests maps a package directory to the test functions reached.
	GoTests map[string][]string
	// TSTests lists the TS test files reached.
	TSTests []string
}

// Impact walks upstream from n (callers, renders, references, and from an
// implementation to its contract member) up to depth steps (default 6).
func (g *Graph) Impact(n *Node, depth int) *Impact {
	if depth <= 0 {
		depth = 6
	}
	im := &Impact{Root: n, GoTests: map[string][]string{}}
	if hub := g.Hub(n); hub != nil {
		im.Hub, im.Mirrors = hub, g.Mirrors(hub)
	}
	// step is one upstream symbol; fromDesktop marks a path that went from Go
	// up to its contract member: TS tests found past that point exercise the
	// web engine, not the Go code that changed.
	type step struct {
		id          string
		fromDesktop bool
	}
	seen := map[string]bool{n.ID: true}
	frontier := []step{{id: n.ID}}
	tsTests := map[string]bool{}
	for level := 0; level < depth && len(frontier) > 0; level++ {
		var next []step
		var nodes []*Node
		for _, cur := range frontier {
			for _, e := range g.In[cur.id] {
				if e.Kind.IsData() || seen[e.From] {
					continue
				}
				seen[e.From] = true
				from := g.Nodes[e.From]
				up := step{id: from.ID, fromDesktop: cur.fromDesktop || (e.Kind == EdgeDispatch && e.Target == TargetDesktop)}
				switch {
				case from.Kind == KindTestFunc:
					dir := path.Dir(from.Pos.File)
					im.GoTests[dir] = append(im.GoTests[dir], from.Name[strings.LastIndexByte(from.Name, '.')+1:])
					continue
				case from.Lang == LangTS && IsTSTestFile(from.Pos.File):
					if !up.fromDesktop {
						tsTests[from.Pos.File] = true
					}
					continue
				case strings.HasSuffix(from.Pos.File, "_test.go"):
					next = append(next, up) // a test helper: its tests are one step up
					continue
				}
				nodes = append(nodes, from)
				next = append(next, up)
				if from.Kind == KindComponent || from.Kind == KindHook {
					im.UI = append(im.UI, from)
				}
			}
		}
		if len(nodes) > 0 {
			sortNodes(nodes)
			im.Levels = append(im.Levels, nodes)
		}
		frontier = next
	}
	for dir := range im.GoTests {
		slices.Sort(im.GoTests[dir])
	}
	for f := range tsTests {
		im.TSTests = append(im.TSTests, f)
	}
	slices.Sort(im.TSTests)
	sortNodes(im.UI)
	return im
}

// IsTSTestFile reports whether a repo-relative path is a vitest file.
func IsTSTestFile(file string) bool {
	return strings.HasSuffix(file, ".test.ts") || strings.HasSuffix(file, ".test.tsx")
}
