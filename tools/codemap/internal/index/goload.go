package index

import (
	"bufio"
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"runtime"
	"strings"

	"golang.org/x/tools/go/gcexportdata"
	"golang.org/x/tools/go/packages"
)

// goListMode asks go/packages only to list the module's packages and their
// test variants, with the compiler export data of every dependency: no type
// checking happens there.
const goListMode = packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
	packages.NeedImports | packages.NeedDeps | packages.NeedExportFile | packages.NeedModule

// goPackage is one type-checked package of the module (or a test variant).
type goPackage struct {
	ID        string // "pkg" or "pkg [pkg.test]" for a test variant
	PkgPath   string
	Name      string
	Fset      *token.FileSet
	Syntax    []*ast.File
	Types     *types.Package
	TypesInfo *types.Info
	Errors    []error
}

// loadGoPackages type-checks the module's packages one at a time, each against
// the export data of its dependencies.
//
// Why not let go/packages type-check: it checks packages concurrently, and
// Go 1.27's go/types races when two checkers share an imported named type
// (Named.unpack writes while cycles.go isComplete reads without the lock:
// `go test -race` fails at random). Checking sequentially costs about a second
// on this repo and keeps the race detector clean.
func loadGoPackages(ctx context.Context, root string) ([]*goPackage, error) {
	cfg := &packages.Config{Context: ctx, Dir: root, Mode: goListMode, Tests: true}
	roots, err := packages.Load(cfg, "./...")
	if err != nil {
		return nil, fmt.Errorf("listing Go packages: %w", err)
	}
	l := &seqLoader{
		fset:    token.NewFileSet(),
		sizes:   types.SizesFor("gc", runtime.GOARCH),
		checked: map[string]*goPackage{},
		exports: map[string]*types.Package{},
		module:  map[string]bool{},
	}
	for _, p := range roots {
		l.module[p.ID] = true
	}
	out := make([]*goPackage, 0, len(roots))
	for _, p := range roots {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if p.Name == "main" && strings.HasSuffix(p.PkgPath, ".test") {
			continue // the generated test main
		}
		out = append(out, l.check(p))
	}
	return out, nil
}

type seqLoader struct {
	fset    *token.FileSet
	sizes   types.Sizes
	checked map[string]*goPackage // by package ID
	// exports holds the dependencies read from export data, shared so that a
	// type means the same *types.Package everywhere.
	exports map[string]*types.Package
	module  map[string]bool // IDs of the module's own packages (checked from source)
}

// check parses and type-checks p after the module packages it imports.
func (l *seqLoader) check(p *packages.Package) *goPackage {
	if gp, ok := l.checked[p.ID]; ok {
		return gp
	}
	gp := &goPackage{ID: p.ID, PkgPath: p.PkgPath, Name: p.Name, Fset: l.fset}
	l.checked[p.ID] = gp
	for _, e := range p.Errors {
		gp.Errors = append(gp.Errors, e)
	}
	for _, imp := range p.Imports {
		if l.module[imp.ID] {
			l.check(imp)
		}
	}
	for _, file := range p.CompiledGoFiles {
		f, err := parser.ParseFile(l.fset, file, nil, parser.ParseComments|parser.SkipObjectResolution)
		if err != nil {
			gp.Errors = append(gp.Errors, err)
		}
		if f != nil {
			gp.Syntax = append(gp.Syntax, f)
		}
	}
	gp.TypesInfo = &types.Info{
		Types:      map[ast.Expr]types.TypeAndValue{},
		Defs:       map[*ast.Ident]types.Object{},
		Uses:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
		Instances:  map[*ast.Ident]types.Instance{},
	}
	conf := types.Config{
		Importer: importerFunc(func(path string) (*types.Package, error) { return l.importFor(p, path) }),
		Sizes:    l.sizes,
		// Keep going after an error: a half-typed package still maps.
		Error: func(err error) { gp.Errors = append(gp.Errors, err) },
	}
	if p.Module != nil && p.Module.GoVersion != "" {
		conf.GoVersion = "go" + p.Module.GoVersion
	}
	gp.Types, _ = conf.Check(p.PkgPath, l.fset, gp.Syntax, gp.TypesInfo) // every error already went to conf.Error
	return gp
}

// importFor resolves an import of p: a module package from its source check,
// anything else from export data.
func (l *seqLoader) importFor(p *packages.Package, path string) (*types.Package, error) {
	if path == "unsafe" {
		return types.Unsafe, nil
	}
	imp := p.Imports[path]
	if imp == nil {
		return nil, fmt.Errorf("%s: no package for import %q", p.PkgPath, path)
	}
	if l.module[imp.ID] {
		if gp := l.check(imp); gp.Types != nil {
			return gp.Types, nil
		}
		return nil, fmt.Errorf("%s: import %q did not type-check", p.PkgPath, path)
	}
	if tp := l.exports[imp.PkgPath]; tp != nil && tp.Complete() {
		return tp, nil
	}
	if imp.ExportFile == "" {
		return nil, fmt.Errorf("%s: no export data for %q (does it build?)", p.PkgPath, path)
	}
	return l.readExport(imp)
}

func (l *seqLoader) readExport(imp *packages.Package) (*types.Package, error) {
	f, err := os.Open(imp.ExportFile)
	if err != nil {
		return nil, fmt.Errorf("opening export data of %s: %w", imp.PkgPath, err)
	}
	defer f.Close()
	r, err := gcexportdata.NewReader(bufio.NewReader(f))
	if err != nil {
		return nil, fmt.Errorf("reading export data of %s: %w", imp.PkgPath, err)
	}
	tp, err := gcexportdata.Read(r, l.fset, l.exports, imp.PkgPath)
	if err != nil {
		return nil, fmt.Errorf("decoding export data of %s: %w", imp.PkgPath, err)
	}
	return tp, nil
}

type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }
