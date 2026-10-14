package index

import (
	"cmp"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// tableSet maps each live table to where it was (last) created or renamed.
type tableSet map[string]graph.Pos

var (
	createTableRe = regexp.MustCompile(`(?i)\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["` + "`" + `]?(\w+)`)
	dropTableRe   = regexp.MustCompile(`(?i)\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["` + "`" + `]?(\w+)`)
	renameTableRe = regexp.MustCompile(`(?i)\bALTER\s+TABLE\s+["` + "`" + `]?(\w+)["` + "`" + `]?\s+RENAME\s+TO\s+["` + "`" + `]?(\w+)`)
	sqlCommentRe  = regexp.MustCompile(`--[^\n]*`)
)

// skipDir lists directories never scanned for sources: VCS data, dependencies,
// generated output and test fixtures of other tools.
func skipDir(name string) bool {
	switch name {
	case "node_modules", "frontend", "bin", "build", "dist", "vendor", "testdata", "logs":
		return true
	}
	return strings.HasPrefix(name, ".")
}

// replayMigrations applies every *.up.sql under root in version (file name)
// order and returns the tables that exist at the end: a table that a later
// migration drops or renames is not live, whatever its CREATE says.
func replayMigrations(root string) (tableSet, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != root && skipDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(d.Name(), ".up.sql") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("listing migrations: %w", err)
	}
	slices.SortFunc(files, func(a, b string) int { return strings.Compare(filepath.Base(a), filepath.Base(b)) })

	tables := tableSet{}
	for _, path := range files {
		src, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading migration: %w", err)
		}
		rel, err := relPath(root, path)
		if err != nil {
			return nil, err
		}
		applyDDL(tables, rel, string(src))
	}
	return tables, nil
}

type ddlOp struct {
	offset   int
	kind     byte // 'c'reate, 'd'rop, 'r'ename
	name, to string
}

// applyDDL replays one migration's CREATE/DROP/RENAME TABLE statements in
// source order.
func applyDDL(tables tableSet, file, src string) {
	// Blank out comments without shifting offsets, so line numbers stay right.
	src = sqlCommentRe.ReplaceAllStringFunc(src, func(c string) string { return strings.Repeat(" ", len(c)) })
	var ops []ddlOp
	for _, m := range createTableRe.FindAllStringSubmatchIndex(src, -1) {
		ops = append(ops, ddlOp{offset: m[0], kind: 'c', name: src[m[2]:m[3]]})
	}
	for _, m := range dropTableRe.FindAllStringSubmatchIndex(src, -1) {
		ops = append(ops, ddlOp{offset: m[0], kind: 'd', name: src[m[2]:m[3]]})
	}
	for _, m := range renameTableRe.FindAllStringSubmatchIndex(src, -1) {
		ops = append(ops, ddlOp{offset: m[0], kind: 'r', name: src[m[2]:m[3]], to: src[m[4]:m[5]]})
	}
	slices.SortFunc(ops, func(a, b ddlOp) int { return cmp.Compare(a.offset, b.offset) })
	for _, op := range ops {
		pos := graph.Pos{File: file, Line: 1 + strings.Count(src[:op.offset], "\n")}
		switch op.kind {
		case 'c':
			tables[strings.ToLower(op.name)] = pos
		case 'd':
			delete(tables, strings.ToLower(op.name))
		case 'r':
			delete(tables, strings.ToLower(op.name))
			tables[strings.ToLower(op.to)] = pos
		}
	}
}

// sqlVerbRe finds the keywords that put a table name right after them. Only
// upper-case keywords count: the repo writes SQL in upper case, and English or
// Spanish prose ("read from cards") must not look like a query.
var sqlVerbRe = regexp.MustCompile(`\b(DELETE\s+FROM|INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|FROM|JOIN)\b`)

var sqlIdentRe = regexp.MustCompile(`^\s*["` + "`" + `]?([A-Za-z_][A-Za-z0-9_]*)`)

// tableAccess is one table a SQL fragment reads or writes.
type tableAccess struct {
	table string
	kind  graph.EdgeKind
}

// classifySQL returns the known tables that a SQL fragment reads (FROM, JOIN)
// or writes (INSERT/REPLACE INTO, UPDATE, DELETE FROM). dynamic is true when a
// table slot holds a placeholder or ends the fragment: the name is built at
// run time ("… FROM " + table, `FROM ${table}`, "FROM %s").
//
// A fragment that is exactly a table name (a table passed to a generic helper)
// is reported as a mention.
func classifySQL(text string, tables tableSet) (acc []tableAccess, dynamic bool) {
	if _, ok := tables[text]; ok {
		return []tableAccess{{table: text, kind: graph.EdgeMention}}, false
	}
	for _, m := range sqlVerbRe.FindAllStringSubmatchIndex(text, -1) {
		verb := text[m[2]:m[3]]
		rest := text[m[1]:]
		trimmed := strings.TrimLeft(rest, " \t\r\n")
		if trimmed == "" || strings.HasPrefix(trimmed, "?") || strings.HasPrefix(trimmed, "%") || strings.HasPrefix(trimmed, "$") {
			dynamic = true
			continue
		}
		id := sqlIdentRe.FindStringSubmatch(rest)
		if id == nil {
			continue // a subquery: "FROM (SELECT …)"
		}
		name := strings.ToLower(id[1])
		if _, ok := tables[name]; !ok {
			continue // "DO UPDATE SET", sqlite_master, a CTE name…
		}
		kind := graph.EdgeWrite
		if verb == "FROM" || verb == "JOIN" {
			kind = graph.EdgeRead
		}
		acc = append(acc, tableAccess{table: name, kind: kind})
	}
	return acc, dynamic
}

// relPath returns path relative to root with forward slashes.
func relPath(root, path string) (string, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return "", fmt.Errorf("relative path of %s: %w", path, err)
	}
	return filepath.ToSlash(rel), nil
}
