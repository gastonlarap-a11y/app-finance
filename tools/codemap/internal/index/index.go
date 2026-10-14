// Package index builds codemap's graph of the repository: the Go half from
// go/packages + go/types (calls, Wails bound services, bun table access), the
// SQL tables from the migrations, and the TypeScript half from the frontend's
// own compiler (frontend/scripts/codemap-ts.ts), linked across the Go⇄TS
// boundary through services/contract.ts.
package index

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"maps"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// Options says what to index.
type Options struct {
	// Root is the repository root (the directory holding go.mod).
	Root string
	// Frontend is the frontend directory; default <Root>/frontend.
	Frontend string
	// Script is the TypeScript extractor; default <Frontend>/scripts/codemap-ts.ts.
	Script string
	// Node is the Node.js binary; default "node".
	Node string
}

func (o Options) withDefaults() Options {
	// Every path the index reports is relative to Root: resolve the paths once,
	// or a relative Root would make every file look outside the repository.
	o.Root = absPath(o.Root)
	if o.Frontend == "" {
		o.Frontend = filepath.Join(o.Root, "frontend")
	}
	o.Frontend = absPath(o.Frontend)
	if o.Script == "" {
		o.Script = filepath.Join(o.Frontend, "scripts", "codemap-ts.ts")
	}
	o.Script = absPath(o.Script)
	if o.Node == "" {
		o.Node = "node"
	}
	return o
}

// absPath is path made absolute; filepath.Abs only fails when the working
// directory is gone, and then the path is kept as given.
func absPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// recheckEvery bounds how often Graph walks the tree looking for changes.
const recheckEvery = time.Second

// Index keeps a graph fresh for a long-running process (the MCP server, the
// viewer): each half (Go+SQL, TypeScript) is rebuilt only when one of its
// files changed. Safe for concurrent use; a returned Graph is never mutated.
type Index struct {
	opts    Options
	recheck time.Duration

	mu      sync.Mutex
	g       *graph.Graph
	checked time.Time
	goFP    string
	tsFP    string
	tables  tableSet
	goRes   *goResult
	tsRes   *tsExtract
	tsErr   error
}

// New returns an Index; nothing is loaded until the first Graph call.
func New(opts Options) *Index { return &Index{opts: opts.withDefaults(), recheck: recheckEvery} }

// Build indexes the repository once.
func Build(ctx context.Context, opts Options) (*graph.Graph, error) {
	return New(opts).Graph(ctx)
}

// Graph returns the current graph, rebuilding the halves whose files changed.
func (ix *Index) Graph(ctx context.Context) (*graph.Graph, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.g != nil && time.Since(ix.checked) < ix.recheck {
		return ix.g, nil
	}
	goFP, tsFP, err := fingerprints(ix.opts)
	if err != nil {
		return nil, err
	}
	ix.checked = time.Now()
	if ix.g != nil && goFP == ix.goFP && tsFP == ix.tsFP {
		return ix.g, nil
	}
	if ix.goRes == nil || goFP != ix.goFP {
		tables, err := replayMigrations(ix.opts.Root)
		if err != nil {
			return nil, err
		}
		goRes, err := loadGo(ctx, ix.opts.Root, tables)
		if err != nil {
			return nil, err
		}
		ix.tables, ix.goRes, ix.goFP = tables, goRes, goFP
	}
	if ix.g == nil || tsFP != ix.tsFP {
		ix.tsRes, ix.tsErr = loadTS(ctx, ix.opts.Root, tsSource{
			Script:   ix.opts.Script,
			Tsconfig: filepath.Join(ix.opts.Frontend, "tsconfig.json"),
			Node:     ix.opts.Node,
		})
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		ix.tsFP = tsFP
	}
	ix.g = assemble(ix.tables, ix.goRes, ix.tsRes, ix.tsErr)
	return ix.g, nil
}

// assemble builds a fresh graph from both halves (nodes are copied: the halves
// are reused by later rebuilds).
func assemble(migrated tableSet, goRes *goResult, ts *tsExtract, tsErr error) *graph.Graph {
	g := graph.New()
	tables := maps.Clone(migrated)
	if ts != nil {
		addWebTables(tables, ts)
	}
	for name, pos := range tables {
		g.AddNode(&graph.Node{ID: tableID(name), Name: name, Lang: graph.LangSQL, Kind: graph.KindTable, Pos: pos})
	}
	for _, n := range goRes.nodes {
		c := *n
		c.Unresolved = goRes.unresolved[n.ID]
		g.AddNode(&c)
	}
	if ts != nil {
		addTSNodes(g, ts)
	}
	for _, e := range goRes.edges {
		g.AddEdge(e)
	}
	if ts != nil {
		linkTS(g, ts, tables)
	}
	for _, note := range goRes.notes {
		g.Note(note)
	}
	switch {
	case errors.Is(tsErr, errNoTS):
		g.Note(tsErr.Error() + "; the map covers Go and SQL only")
	case tsErr != nil:
		g.Note("TypeScript not indexed: " + tsErr.Error())
	}
	g.Finish()
	return g
}

// fingerprints hashes (path, size, mtime) of the files each half depends on.
func fingerprints(opts Options) (goFP, tsFP string, err error) {
	goHash, tsHash := fnv.New64a(), fnv.New64a()
	frontend := filepath.Clean(opts.Frontend)
	err = filepath.WalkDir(opts.Root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == opts.Root || path == frontend {
				return nil
			}
			if skipDir(d.Name()) || d.Name() == "bindings" {
				return filepath.SkipDir
			}
			return nil
		}
		inFrontend := strings.HasPrefix(path, frontend+string(filepath.Separator))
		var h io.Writer
		switch {
		case inFrontend && tsFilesUnder(path):
			h = tsHash
		case !inFrontend && goFilesUnder(path):
			h = goHash
		default:
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		_, err = h.Write([]byte(path + "|" + strconv.FormatInt(info.Size(), 10) + "|" +
			strconv.FormatInt(info.ModTime().UnixNano(), 10) + "\n"))
		return err
	})
	if err != nil {
		return "", "", fmt.Errorf("scanning sources: %w", err)
	}
	return strconv.FormatUint(goHash.Sum64(), 16), strconv.FormatUint(tsHash.Sum64(), 16), nil
}
