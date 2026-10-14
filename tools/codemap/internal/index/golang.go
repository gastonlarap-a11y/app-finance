package index

import (
	"context"
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"golang.org/x/tools/go/types/typeutil"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// wailsAppPkgSuffix identifies Wails' application package (its NewService
// registers a bound service); bunPkgSuffix identifies uptrace/bun. Matching by
// suffix lets the test fixture stand in small stubs for both.
const (
	wailsAppPkgSuffix = "/wails/v3/pkg/application"
	bunPkgSuffix      = "/bun"
)

// wailsLifecycle lists the methods Wails never binds (service lifecycle hooks).
var wailsLifecycle = map[string]bool{
	"ServiceName": true, "ServiceStartup": true, "ServiceShutdown": true, "ServeHTTP": true,
}

// goResult is the Go half of the graph: nodes, edges (which may point to
// table nodes) and the run-time-only SQL sites per node.
type goResult struct {
	nodes      []*graph.Node
	edges      []graph.Edge
	unresolved map[string][]graph.Pos
	notes      []string
}

// goIndexer carries the state of one Go load.
type goIndexer struct {
	root   string
	tables tableSet
	res    *goResult
	nodes  map[string]*graph.Node
	// modelTables maps "pkgpath.Type" to the table of a bun model struct.
	modelTables map[string]string
	// implementers maps an interface method ID to the module methods implementing it.
	implementers map[string][]string
	// modelParams: functions that hand a parameter typed `any` to bun's Model.
	modelParams map[string][]modelParam
	callSites   []callSite
	done        map[string]bool // files already walked (test variants repeat them)
}

type modelParam struct {
	index int
	kind  graph.EdgeKind
}

type callSite struct {
	from, to string
	at       graph.Pos
	// argTables[i] is the bun model table of argument i, "" if none.
	argTables []string
}

// loadGo indexes the module's Go code. The module's own packages are checked
// from source and every dependency comes from compiler export data, so a large
// dependency (Google's API clients) is never type-checked here.
func loadGo(ctx context.Context, root string, tables tableSet) (*goResult, error) {
	pkgs, err := loadGoPackages(ctx, root)
	if err != nil {
		return nil, err
	}
	ix := &goIndexer{
		root:         root,
		tables:       tables,
		res:          &goResult{unresolved: map[string][]graph.Pos{}},
		nodes:        map[string]*graph.Node{},
		modelTables:  map[string]string{},
		implementers: map[string][]string{},
		modelParams:  map[string][]modelParam{},
		done:         map[string]bool{},
	}
	pkgs = ix.usable(pkgs)
	for _, pkg := range pkgs {
		ix.declare(pkg)
	}
	ix.findImplementers(pkgs)
	for _, pkg := range pkgs {
		ix.markBound(pkg)
	}
	clear(ix.done)
	for _, pkg := range pkgs {
		ix.walkBodies(pkg)
	}
	ix.resolveModelParams()
	return ix.res, nil
}

// usable notes packages that failed to load (their syntax may still be
// indexed partially) or could not be indexed at all.
func (ix *goIndexer) usable(pkgs []*goPackage) []*goPackage {
	var out []*goPackage
	for _, pkg := range pkgs {
		variant := strings.Contains(pkg.ID, " [")
		if len(pkg.Errors) > 0 && !variant {
			ix.res.notes = append(ix.res.notes, fmt.Sprintf("Go: %s: %v", pkg.PkgPath, pkg.Errors[0]))
		}
		if pkg.TypesInfo == nil || pkg.Types == nil {
			if !variant {
				ix.res.notes = append(ix.res.notes, "Go: "+pkg.PkgPath+" not indexed (no type information)")
			}
			continue
		}
		out = append(out, pkg)
	}
	if len(out) == 0 {
		ix.res.notes = append(ix.res.notes, "Go: no package could be indexed (is `go build ./...` working here?)")
	}
	return out
}

// files yields each syntax tree of pkg that lies under root and has not been
// visited yet in the current pass, with its repo-relative path.
func (ix *goIndexer) files(pkg *goPackage, yield func(f *ast.File, rel string)) {
	for _, f := range pkg.Syntax {
		abs := pkg.Fset.Position(f.Package).Filename
		if ix.done[abs] {
			continue
		}
		rel, err := relPath(ix.root, abs)
		if err != nil || strings.HasPrefix(rel, "../") {
			continue
		}
		ix.done[abs] = true
		yield(f, rel)
	}
}

func (ix *goIndexer) pos(fset *token.FileSet, from, to token.Pos) graph.Pos {
	start, end := fset.Position(from), fset.Position(to)
	rel, err := relPath(ix.root, start.Filename)
	if err != nil {
		return graph.Pos{}
	}
	return graph.Pos{File: rel, Line: start.Line, EndLine: end.Line}
}

func (ix *goIndexer) addNode(n *graph.Node) {
	if _, dup := ix.nodes[n.ID]; dup {
		return
	}
	ix.nodes[n.ID] = n
	ix.res.nodes = append(ix.res.nodes, n)
}

// declare creates the nodes of pkg's functions, methods and named types, and
// records the table behind each bun model struct.
func (ix *goIndexer) declare(pkg *goPackage) {
	qualifier := func(p *types.Package) string { return p.Name() }
	ix.files(pkg, func(f *ast.File, rel string) {
		isTest := strings.HasSuffix(rel, "_test.go")
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				fn, ok := pkg.TypesInfo.Defs[d.Name].(*types.Func)
				if !ok {
					continue
				}
				id := funcID(fn)
				if id == "" {
					continue
				}
				n := &graph.Node{
					ID:        id,
					Name:      displayName(fn),
					Lang:      graph.LangGo,
					Kind:      graph.KindFunc,
					Pos:       ix.pos(pkg.Fset, d.Pos(), d.End()),
					Signature: clip(types.ObjectString(fn, qualifier), 240),
					Doc:       firstSentence(d.Doc.Text()),
				}
				if recv := fn.Signature().Recv(); recv != nil {
					n.Kind = graph.KindMethod
					n.Parent = "go:" + fn.Pkg().Path() + "." + recvTypeName(recv.Type())
				} else if isTest && isTestFunc(d.Name.Name) {
					n.Kind = graph.KindTestFunc
				}
				ix.addNode(n)
			case *ast.GenDecl:
				ix.declareTypes(pkg, d)
			}
		}
	})
}

func (ix *goIndexer) declareTypes(pkg *goPackage, d *ast.GenDecl) {
	if d.Tok != token.TYPE {
		return
	}
	for _, spec := range d.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok {
			continue
		}
		obj, ok := pkg.TypesInfo.Defs[ts.Name].(*types.TypeName)
		if !ok || obj.Pkg() == nil {
			continue
		}
		doc := ts.Doc
		if doc == nil {
			doc = d.Doc
		}
		key := obj.Pkg().Path() + "." + obj.Name()
		what := "type"
		switch u := obj.Type().Underlying().(type) {
		case *types.Struct:
			what = "struct"
			if table := bunTable(u); table != "" {
				ix.modelTables[key] = table
			}
		case *types.Interface:
			what = "interface"
		}
		ix.addNode(&graph.Node{
			ID:        "go:" + key,
			Name:      obj.Pkg().Name() + "." + obj.Name(),
			Lang:      graph.LangGo,
			Kind:      graph.KindType,
			Pos:       ix.pos(pkg.Fset, ts.Pos(), ts.End()),
			Signature: "type " + obj.Name() + " " + what,
			Doc:       firstSentence(doc.Text()),
		})
	}
}

// bunTable reads `bun:"table:<name>,…"` from a struct's embedded bun.BaseModel.
func bunTable(s *types.Struct) string {
	for i := range s.NumFields() {
		f := s.Field(i)
		if f.Name() != "BaseModel" || !f.Embedded() {
			continue
		}
		for part := range strings.SplitSeq(reflect.StructTag(s.Tag(i)).Get("bun"), ",") {
			if table, ok := strings.CutPrefix(part, "table:"); ok {
				return strings.ToLower(table)
			}
		}
	}
	return ""
}

// findImplementers maps each module interface method to the module methods
// that implement it, so a call through an interface reaches real code. Only
// the plain (non-test) package variants are compared: types from different
// variants are never identical.
func (ix *goIndexer) findImplementers(pkgs []*goPackage) {
	var ifaces, concretes []*types.TypeName
	for _, pkg := range pkgs {
		if strings.Contains(pkg.ID, " [") {
			continue
		}
		scope := pkg.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			if _, isIface := tn.Type().Underlying().(*types.Interface); isIface {
				ifaces = append(ifaces, tn)
			} else {
				concretes = append(concretes, tn)
			}
		}
	}
	for _, it := range ifaces {
		iface, _ := it.Type().Underlying().(*types.Interface)
		if iface.NumMethods() == 0 {
			continue
		}
		for _, ct := range concretes {
			if !types.Implements(ct.Type(), iface) && !types.Implements(types.NewPointer(ct.Type()), iface) {
				continue
			}
			for m := range iface.Methods() {
				from := "go:" + it.Pkg().Path() + "." + it.Name() + "." + m.Name()
				to := "go:" + ct.Pkg().Path() + "." + ct.Name() + "." + m.Name()
				ix.implementers[from] = append(ix.implementers[from], to)
			}
		}
	}
}

// markBound finds `application.NewService(x)` calls and flags the exported
// methods of x's type as bound to TypeScript, the way Wails does.
func (ix *goIndexer) markBound(pkg *goPackage) {
	info := pkg.TypesInfo
	for _, f := range pkg.Syntax {
		ast.Inspect(f, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			fn, ok := typeutil.Callee(info, call).(*types.Func)
			if !ok || fn.Pkg() == nil || !strings.HasSuffix(fn.Pkg().Path(), wailsAppPkgSuffix) ||
				(fn.Name() != "NewService" && fn.Name() != "NewServiceWithOptions") || len(call.Args) == 0 {
				return true
			}
			named := namedOf(info.TypeOf(call.Args[0]))
			if named == nil {
				ix.res.notes = append(ix.res.notes, "Go: a Wails service whose type could not be resolved at "+
					ix.pos(pkg.Fset, call.Pos(), call.End()).File)
				return true
			}
			ms := types.NewMethodSet(types.NewPointer(named))
			for sel := range ms.Methods() {
				m, ok := sel.Obj().(*types.Func)
				if !ok || !m.Exported() || wailsLifecycle[m.Name()] {
					continue
				}
				if n := ix.nodes[funcID(m)]; n != nil {
					n.Bound = named.Obj().Name()
				}
			}
			return true
		})
	}
}

// walkBodies records the calls, function references and table accesses inside
// every function body (closures count as part of the function around them).
func (ix *goIndexer) walkBodies(pkg *goPackage) {
	ix.files(pkg, func(f *ast.File, _ string) {
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Body == nil {
				continue
			}
			fn, ok := pkg.TypesInfo.Defs[fd.Name].(*types.Func)
			if !ok {
				continue
			}
			from := funcID(fn)
			if ix.nodes[from] == nil {
				continue
			}
			ix.walkBody(pkg, fd, from)
		}
	})
}

func (ix *goIndexer) walkBody(pkg *goPackage, fd *ast.FuncDecl, from string) {
	info := pkg.TypesInfo
	callees := map[*ast.Ident]bool{}
	seenConst := map[*types.Const]bool{}
	params := paramIndex(info, fd)

	ast.Inspect(fd.Body, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.CallExpr:
			if id := calleeIdent(n.Fun); id != nil {
				callees[id] = true
			}
			ix.call(pkg, n, from, params)
		case *ast.Ident:
			if callees[n] {
				return true
			}
			switch obj := info.Uses[n].(type) {
			case *types.Func:
				if to := funcID(obj); ix.nodes[to] != nil {
					ix.edge(from, to, graph.EdgeRef, ix.pos(pkg.Fset, n.Pos(), n.End()))
				}
			case *types.Const:
				if !seenConst[obj] && obj.Val().Kind() == constant.String {
					seenConst[obj] = true
					ix.sqlText(constant.StringVal(obj.Val()), from, ix.pos(pkg.Fset, n.Pos(), n.End()))
				}
			}
		case *ast.BasicLit:
			if n.Kind == token.STRING {
				if s, err := strconv.Unquote(n.Value); err == nil {
					ix.sqlText(s, from, ix.pos(pkg.Fset, n.Pos(), n.End()))
				}
			}
		}
		return true
	})
}

// call handles one call expression: a call edge (fanned out to implementers
// for an interface method) and, for bun's Model/TableExpr, a table access.
func (ix *goIndexer) call(pkg *goPackage, call *ast.CallExpr, from string, params map[types.Object]int) {
	info := pkg.TypesInfo
	fn, ok := typeutil.Callee(info, call).(*types.Func)
	if !ok {
		return
	}
	at := ix.pos(pkg.Fset, call.Pos(), call.End())
	if kind, isBun := bunVerb(fn); isBun {
		ix.bunCall(info, call, fn, kind, from, at, params)
		return
	}
	to := funcID(fn)
	targets := ix.implementers[to]
	if ix.nodes[to] != nil {
		targets = []string{to}
	}
	for _, t := range targets {
		ix.edge(from, t, graph.EdgeCall, at)
	}
	if len(targets) == 1 && ix.nodes[to] != nil {
		site := callSite{from: from, to: to, at: at, argTables: make([]string, len(call.Args))}
		for i, arg := range call.Args {
			site.argTables[i] = ix.modelTable(info.TypeOf(arg))
		}
		ix.callSites = append(ix.callSites, site)
	}
}

// bunVerb reports whether fn is bun's Model or TableExpr on a query builder,
// and whether that query reads or writes.
func bunVerb(fn *types.Func) (graph.EdgeKind, bool) {
	if fn.Name() != "Model" && fn.Name() != "TableExpr" {
		return 0, false
	}
	recv := fn.Signature().Recv()
	if recv == nil || fn.Pkg() == nil || !strings.HasSuffix(fn.Pkg().Path(), bunPkgSuffix) {
		return 0, false
	}
	switch recvTypeName(recv.Type()) {
	case "SelectQuery":
		return graph.EdgeRead, true
	case "InsertQuery", "UpdateQuery", "DeleteQuery":
		return graph.EdgeWrite, true
	}
	return 0, false
}

func (ix *goIndexer) bunCall(info *types.Info, call *ast.CallExpr, fn *types.Func, kind graph.EdgeKind,
	from string, at graph.Pos, params map[types.Object]int,
) {
	if len(call.Args) == 0 {
		return
	}
	arg := call.Args[0]
	if fn.Name() == "TableExpr" {
		if tv, ok := info.Types[arg]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
			// "installments AS i": the table is the first word.
			if words := strings.Fields(constant.StringVal(tv.Value)); len(words) > 0 {
				name := strings.ToLower(words[0])
				if _, known := ix.tables[name]; known {
					ix.edge(from, tableID(name), kind, at)
					return
				}
			}
		}
		ix.res.unresolved[from] = append(ix.res.unresolved[from], at)
		return
	}
	if table := ix.modelTable(info.TypeOf(arg)); table != "" {
		ix.edge(from, tableID(table), kind, at)
		return
	}
	// A model handed in as `any`: the callers' argument types decide.
	if id, ok := arg.(*ast.Ident); ok {
		if i, isParam := params[info.Uses[id]]; isParam {
			ix.modelParams[from] = append(ix.modelParams[from], modelParam{index: i, kind: kind})
			return
		}
	}
	ix.res.unresolved[from] = append(ix.res.unresolved[from], at)
}

// resolveModelParams attributes each table passed into a generic helper
// (softDelete(ctx, (*Card)(nil), …)) to the caller, one hop up.
func (ix *goIndexer) resolveModelParams() {
	for _, site := range ix.callSites {
		for _, mp := range ix.modelParams[site.to] {
			if mp.index < len(site.argTables) && site.argTables[mp.index] != "" {
				ix.edge(site.from, tableID(site.argTables[mp.index]), mp.kind, site.at)
			}
		}
	}
}

// modelTable is the bun table of a model type: *T, []T, *[]T, … of a tagged struct.
func (ix *goIndexer) modelTable(t types.Type) string {
	named := namedOf(t)
	if named == nil || named.Obj().Pkg() == nil {
		return ""
	}
	return ix.modelTables[named.Obj().Pkg().Path()+"."+named.Obj().Name()]
}

// sqlText classifies a string used by a function as SQL.
func (ix *goIndexer) sqlText(s, from string, at graph.Pos) {
	acc, dynamic := classifySQL(s, ix.tables)
	for _, a := range acc {
		ix.edge(from, tableID(a.table), a.kind, at)
	}
	if dynamic {
		ix.res.unresolved[from] = append(ix.res.unresolved[from], at)
	}
}

func (ix *goIndexer) edge(from, to string, kind graph.EdgeKind, at graph.Pos) {
	ix.res.edges = append(ix.res.edges, graph.Edge{From: from, To: to, Kind: kind, At: at})
}

// ---------- helpers ----------

func tableID(table string) string { return "sql:" + table }

// funcID is the node ID of a function or method; "" for builtins and for
// methods of unnamed types.
func funcID(fn *types.Func) string {
	fn = fn.Origin()
	if fn.Pkg() == nil {
		return ""
	}
	if recv := fn.Signature().Recv(); recv != nil {
		name := recvTypeName(recv.Type())
		if name == "" {
			return ""
		}
		return "go:" + fn.Pkg().Path() + "." + name + "." + fn.Name()
	}
	return "go:" + fn.Pkg().Path() + "." + fn.Name()
}

// displayName is "pkg.Recv.Name" or "pkg.Name".
func displayName(fn *types.Func) string {
	if recv := fn.Signature().Recv(); recv != nil {
		return fn.Pkg().Name() + "." + recvTypeName(recv.Type()) + "." + fn.Name()
	}
	return fn.Pkg().Name() + "." + fn.Name()
}

func recvTypeName(t types.Type) string {
	if named := namedOf(t); named != nil {
		return named.Obj().Name()
	}
	return ""
}

// namedOf unwraps pointers, slices and arrays down to a named type.
func namedOf(t types.Type) *types.Named {
	for t != nil {
		switch u := types.Unalias(t).(type) {
		case *types.Named:
			return u.Origin()
		case *types.Pointer:
			t = u.Elem()
		case *types.Slice:
			t = u.Elem()
		case *types.Array:
			t = u.Elem()
		default:
			return nil
		}
	}
	return nil
}

// calleeIdent is the identifier naming a call's function (f, x.f, f[T]).
func calleeIdent(fun ast.Expr) *ast.Ident {
	switch f := ast.Unparen(fun).(type) {
	case *ast.Ident:
		return f
	case *ast.SelectorExpr:
		return f.Sel
	case *ast.IndexExpr:
		return calleeIdent(f.X)
	case *ast.IndexListExpr:
		return calleeIdent(f.X)
	}
	return nil
}

// paramIndex maps each parameter object of fd to its position.
func paramIndex(info *types.Info, fd *ast.FuncDecl) map[types.Object]int {
	idx := map[types.Object]int{}
	i := 0
	for _, field := range fd.Type.Params.List {
		if len(field.Names) == 0 {
			i++
			continue
		}
		for _, name := range field.Names {
			if obj := info.Defs[name]; obj != nil {
				idx[obj] = i
			}
			i++
		}
	}
	return idx
}

func isTestFunc(name string) bool {
	for _, prefix := range []string{"Test", "Benchmark", "Fuzz", "Example"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// firstSentence trims a doc comment to its first sentence.
func firstSentence(doc string) string {
	doc = strings.Join(strings.Fields(doc), " ")
	if i := strings.Index(doc, ". "); i >= 0 {
		doc = doc[:i+1]
	}
	return clip(doc, 240)
}

// clip shortens s to at most n runes, marking the cut.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// goFilesUnder reports whether path is a Go source or module file that the Go
// half of the index depends on.
func goFilesUnder(path string) bool {
	switch filepath.Ext(path) {
	case ".go", ".sql":
		return true
	}
	base := filepath.Base(path)
	return base == "go.mod" || base == "go.sum"
}
