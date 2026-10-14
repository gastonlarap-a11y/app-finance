package archify

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// testGraph is one feature on both builds: a form handler calls a contract
// member that dispatches to a Go bound method (desktop, through a helper) and
// to the web engine; both end in the same table.
func testGraph() *graph.Graph {
	g := graph.New()
	pos := func(file string, line int) graph.Pos { return graph.Pos{File: file, Line: line, EndLine: line + 4} }
	for _, n := range []*graph.Node{
		{ID: "ts:app", Name: "App", Lang: graph.LangTS, Kind: graph.KindComponent, Pos: pos("frontend/src/App.tsx", 10)},
		{ID: "ts:form", Name: "Form", Lang: graph.LangTS, Kind: graph.KindComponent, Pos: pos("frontend/src/components/Form.tsx", 1)},
		{ID: "ts:form#save", Name: "Form.save", Lang: graph.LangTS, Kind: graph.KindFunc, Parent: "ts:form", Pos: pos("frontend/src/components/Form.tsx", 4)},
		{ID: "ts:iface", Name: "SvcContract", Lang: graph.LangTS, Kind: graph.KindType, Pos: pos("frontend/src/services/contract.ts", 1)},
		{ID: "ts:hub", Name: "SvcContract.Save", Lang: graph.LangTS, Kind: graph.KindContractMethod, Parent: "ts:iface", Pos: pos("frontend/src/services/contract.ts", 2)},
		{ID: "go:pkg.Svc", Name: "pkg.Svc", Lang: graph.LangGo, Kind: graph.KindType, Pos: pos("backend/pkg/svc.go", 3)},
		{ID: "go:pkg.Svc.Save", Name: "pkg.Svc.Save", Lang: graph.LangGo, Kind: graph.KindMethod, Bound: "Svc", Parent: "go:pkg.Svc", Pos: pos("backend/pkg/svc.go", 10)},
		{ID: "go:pkg.persist", Name: "pkg.persist", Lang: graph.LangGo, Kind: graph.KindFunc, Pos: pos("backend/pkg/svc.go", 30)},
		{ID: "ts:engine", Name: "createSvc", Lang: graph.LangTS, Kind: graph.KindFunc, Pos: pos("frontend/src/engine/svc.ts", 1)},
		{ID: "ts:engine#Save", Name: "createSvc.service.Save", Lang: graph.LangTS, Kind: graph.KindEngineMethod, Parent: "ts:engine", Pos: pos("frontend/src/engine/svc.ts", 5)},
		{ID: "sql:things", Name: "things", Lang: graph.LangSQL, Kind: graph.KindTable, Pos: graph.Pos{File: "backend/pkg/migrations/1.up.sql", Line: 1}},
		{ID: "sql:web_prefs", Name: "web_prefs", Lang: graph.LangSQL, Kind: graph.KindTable, Pos: graph.Pos{File: "frontend/src/engine/svc.ts", Line: 2}},
	} {
		g.AddNode(n)
	}
	for _, e := range []graph.Edge{
		{From: "ts:app", To: "ts:form", Kind: graph.EdgeRender},
		{From: "ts:form", To: "ts:form#save", Kind: graph.EdgeCall},
		{From: "ts:form#save", To: "ts:hub", Kind: graph.EdgeCall, At: graph.Pos{File: "frontend/src/components/Form.tsx", Line: 5}},
		{From: "ts:hub", To: "go:pkg.Svc.Save", Kind: graph.EdgeDispatch, Target: graph.TargetDesktop},
		{From: "ts:hub", To: "ts:engine#Save", Kind: graph.EdgeDispatch, Target: graph.TargetWeb},
		{From: "go:pkg.Svc.Save", To: "go:pkg.persist", Kind: graph.EdgeCall},
		{From: "go:pkg.persist", To: "sql:things", Kind: graph.EdgeWrite},
		{From: "go:pkg.Svc.Save", To: "sql:things", Kind: graph.EdgeRead},
		{From: "ts:engine#Save", To: "sql:things", Kind: graph.EdgeWrite},
	} {
		g.AddEdge(e)
	}
	g.Finish()
	return g
}

// cleanRepo cites everything; it stands for a fully committed checkout.
func cleanRepo() Repo {
	return Repo{
		Meta:  &Repository{URL: "https://github.com/acme/app", Provider: "github", LinkMode: "web", Revision: strings.Repeat("a", 40)},
		Dirty: map[string]bool{},
	}
}

var archifyID = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]*$`)

func TestIDs(t *testing.T) {
	seen := ids{}
	for _, tt := range []struct{ in, want string }{
		{"ui", "ui"},
		{"ui", "ui-2"},
		{"go:Finance Service", "go-Finance-Service"},
		{"9lives", "n-9lives"},
		{"table:*", "table"},
	} {
		if got := seen.next(tt.in); got != tt.want || !archifyID.MatchString(got) {
			t.Errorf("next(%q) = %q, want %q (and a valid Archify ID)", tt.in, got, tt.want)
		}
	}
}

func TestCanonicalRemote(t *testing.T) {
	tests := []struct{ origin, url, provider string }{
		{"https://github.com/acme/app.git", "https://github.com/acme/app", "github"},
		{"git@github.com:acme/app.git", "https://github.com/acme/app", "github"},
		{"https://user:token@gitlab.com/group/sub/app.git", "https://gitlab.com/group/sub/app", "gitlab"},
		{"https://git.example.com/acme/app", "https://git.example.com/acme/app", ""},
		{"/srv/git/app.git", "/srv/git/app.git", ""},
	}
	for _, tt := range tests {
		url, provider := canonicalRemote(tt.origin)
		if url != tt.url || provider != tt.provider {
			t.Errorf("canonicalRemote(%q) = %q, %q; want %q, %q", tt.origin, url, provider, tt.url, tt.provider)
		}
	}
}

func TestCite(t *testing.T) {
	repo := cleanRepo()
	repo.Dirty["dirty.go"] = true
	p := func(file string, line int) graph.Pos { return graph.Pos{File: file, Line: line} }
	got := repo.Cite(p("a.go", 1), graph.Pos{}, p("dirty.go", 2), p("a.go", 1), p("b.go", 3), p("c.go", 4), p("d.go", 5))
	want := []Source{{Path: "a.go", Line: 1}, {Path: "b.go", Line: 3}, {Path: "c.go", Line: 4}}
	if !slices.Equal(got, want) {
		t.Errorf("Cite = %+v, want %+v (no zero, dirty or repeated position; at most three)", got, want)
	}
	if (Repo{}).Cite(p("a.go", 1)) != nil {
		t.Error("without a repository nothing can be cited")
	}
}

func TestReadRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()
	gitIn := func(args ...string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	gitIn("init", "-q")
	for name, body := range map[string]string{"clean.go": "package x\n", "edited.go": "package x\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gitIn("add", ".")
	gitIn("commit", "-q", "-m", "init")
	gitIn("remote", "add", "origin", "git@github.com:acme/app.git")
	if err := os.WriteFile(filepath.Join(root, "edited.go"), []byte("package x // changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new.go"), []byte("package x\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	repo, err := ReadRepo(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if repo.Meta == nil || repo.Meta.URL != "https://github.com/acme/app" || len(repo.Meta.Revision) != 40 {
		t.Fatalf("meta = %+v", repo.Meta)
	}
	if repo.Meta.LinkMode != "local-only" {
		t.Errorf("link mode = %q: a commit no remote branch has must not get web links", repo.Meta.LinkMode)
	}
	if !repo.Dirty["edited.go"] || !repo.Dirty["new.go"] || repo.Dirty["clean.go"] {
		t.Errorf("dirty = %v", repo.Dirty)
	}

	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o750); err != nil {
		t.Fatal(err)
	}
	if inner, _ := ReadRepo(ctx, sub); inner.Meta != nil {
		t.Error("a root below the checkout's top cannot pin citations")
	}
}

func TestArchitecture(t *testing.T) {
	g := testGraph()
	d := Architecture(g, cleanRepo(), ArchitectureOptions{Output: ".codemap/diagrams/architecture.html"})

	if d.SchemaVersion != 1 || d.DiagramType != TypeArchitecture || d.Meta.QualityProfile != "standard" || d.Meta.Locale != "es" {
		t.Errorf("header = %d %s %+v", d.SchemaVersion, d.DiagramType, d.Meta)
	}
	byID := map[string]Component{}
	for _, c := range d.Components {
		byID[c.ID] = c
		if !archifyID.MatchString(c.ID) {
			t.Errorf("invalid id %q", c.ID)
		}
		if right := c.Pos[0] + c.Size[0]; right > 1240 {
			t.Errorf("%s ends at x=%v, past Archify's 1240px canvas", c.ID, right)
		}
	}
	for id, sub := range map[string]string{
		"ui":             "2 componentes · 0 hooks", // App and Form
		"contract":       "1 contrato · 1 método",
		"go-services":    "1 servicio · 1 método",
		"engine":         "1 método en 1 servicio",
		"sqlite-web":     "2 tablas", // the migrated one + the engine's own web_prefs
		"sqlite-desktop": "1 tabla (migraciones)",
	} {
		if got := byID[id].Sublabel; got != sub {
			t.Errorf("%s sublabel = %q, want %q", id, got, sub)
		}
	}
	if src := byID["ui"].Sources; len(src) == 0 || src[0].Path != "frontend/src/App.tsx" {
		t.Errorf("ui sources = %+v, want App.tsx first", src)
	}
	conns := map[string]Connection{}
	for _, c := range d.Connections {
		conns[c.ID] = c
	}
	if c := conns["desktop-sql"]; c.Label != "escribe 1 · lee 1 tabla" {
		t.Errorf("desktop-sql = %+v", c)
	}
	if c := conns["ui-calls"]; c.Label != "1 llamada" {
		t.Errorf("ui-calls = %+v", c)
	}
	if d.Meta.Repository == nil {
		t.Error("cited components need the pinned repository")
	}
	if Architecture(g, Repo{}, ArchitectureOptions{Output: "a.html"}).Meta.Repository != nil {
		t.Error("no citations, no repository: Archify rejects a pin without sources")
	}
	goOnly := graph.New()
	goOnly.AddNode(&graph.Node{ID: "go:x.F", Name: "x.F", Lang: graph.LangGo, Kind: graph.KindFunc})
	goOnly.Finish()
	for _, c := range Architecture(goOnly, Repo{}, ArchitectureOptions{Output: "a.html"}).Cards {
		if len(c.Items) == 0 {
			t.Errorf("card %q is empty: its items would marshal as null, which Archify rejects", c.Title)
		}
	}
}

func TestSequence(t *testing.T) {
	g := testGraph()
	tests := []struct {
		name, target string
		participants []string
		messages     []string
	}{
		{"desktop", graph.TargetDesktop,
			[]string{"Form", "Contrato", "Svc", "SQLite"},
			[]string{"Form→Contrato Save()", "Contrato→Svc binding Wails", "Svc→SQLite persist: escribe things", "Svc→SQLite Save: lee things", "Svc→Form resultado"}},
		{"web", graph.TargetWeb,
			[]string{"Form", "Contrato", "Motor TS", "SQLite"},
			[]string{"Form→Contrato Save()", "Contrato→Motor TS worker (comlink)", "Motor TS→SQLite Save: escribe things", "Motor TS→Form resultado"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := Sequence(g, g.Nodes["ts:form#save"], cleanRepo(), SequenceOptions{Output: "s.html", Target: tt.target})
			if err != nil {
				t.Fatal(err)
			}
			label := map[string]string{}
			var parts []string
			for _, p := range d.Participants {
				label[p.ID] = p.Label
				parts = append(parts, p.Label)
			}
			if !slices.Equal(parts, tt.participants) {
				t.Errorf("participants = %v, want %v", parts, tt.participants)
			}
			var msgs []string
			lastY := 0.0
			for _, m := range d.Messages {
				msgs = append(msgs, label[m.From]+"→"+label[m.To]+" "+m.Label)
				if m.From == m.To || m.Y <= lastY || m.Y < 160 {
					t.Errorf("message %+v: no self-messages, y strictly increasing from 160", m)
				}
				lastY = m.Y
			}
			if !slices.Equal(msgs, tt.messages) {
				t.Errorf("messages =\n%s\nwant\n%s", strings.Join(msgs, "\n"), strings.Join(tt.messages, "\n"))
			}
			if len(d.Segments) != 1 || d.Segments[0].Label != "Save" || d.Segments[0].To <= d.Segments[0].From {
				t.Errorf("segments = %+v", d.Segments)
			}
		})
	}

	t.Run("an implementation is drawn from its contract member, on the requested build", func(t *testing.T) {
		d, err := Sequence(g, g.Nodes["go:pkg.Svc.Save"], cleanRepo(), SequenceOptions{Output: "s.html", Target: graph.TargetWeb})
		if err != nil {
			t.Fatal(err)
		}
		var parts []string
		for _, p := range d.Participants {
			parts = append(parts, p.Label)
		}
		if !slices.Equal(parts, []string{"Contrato", "Motor TS", "SQLite"}) {
			t.Errorf("participants = %v: the web flow of a Go method goes through its contract to the engine", parts)
		}
		if d.Meta.Legend == nil || d.Meta.Legend.Entries["dashed"].Label != "lectura de tabla" {
			t.Errorf("legend = %+v: a dashed read must not be labelled async", d.Meta.Legend)
		}
	})

	t.Run("a flow without data is an error", func(t *testing.T) {
		if _, err := Sequence(g, g.Nodes["ts:app"], cleanRepo(), SequenceOptions{Target: graph.TargetDesktop}); err != nil {
			t.Fatalf("App reaches the table through Form: %v", err)
		}
		lonely := graph.New()
		lonely.AddNode(&graph.Node{ID: "ts:x", Name: "X", Lang: graph.LangTS, Kind: graph.KindFunc})
		lonely.Finish()
		if _, err := Sequence(lonely, lonely.Nodes["ts:x"], Repo{}, SequenceOptions{Target: graph.TargetDesktop}); !errors.Is(err, ErrNoFlow) {
			t.Errorf("err = %v, want ErrNoFlow", err)
		}
	})
}

func TestCheckVersion(t *testing.T) {
	for v, ok := range map[string]bool{"3.1.0": true, "3.4.2": true, "3.0.1": false, "4.0.0": false, "x": false} {
		if err := checkVersion(v); (err == nil) != ok {
			t.Errorf("checkVersion(%q) = %v, want ok=%v", v, err, ok)
		}
	}
}

// fakeArchify installs a stand-in archify.mjs that records its arguments and
// environment, and returns the getenv FindCLI should see.
func fakeArchify(t *testing.T, version string) (getenv func(string) string, record string) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not installed")
	}
	dir := t.TempDir()
	record = filepath.Join(dir, "args.txt")
	script := filepath.Join(dir, "archify", "bin", "archify.mjs")
	if err := os.MkdirAll(filepath.Dir(script), 0o750); err != nil {
		t.Fatal(err)
	}
	body := `import { writeFileSync } from 'node:fs'
writeFileSync(` + "`" + record + "`" + `, process.argv.slice(2).join(' ') + '\n' + process.env.ARCHIFY_UPDATE_CHECK_DISABLED)
`
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	pkg := `{"name":"archify","version":"` + version + `"}`
	if err := os.WriteFile(filepath.Join(dir, "archify", "package.json"), []byte(pkg), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"ARCHIFY_BIN": script, "HOME": t.TempDir()}
	return func(k string) string { return env[k] }, record
}

func TestFindCLIAndRender(t *testing.T) {
	getenv, record := fakeArchify(t, "3.1.0")
	root := t.TempDir()
	cli, err := FindCLI(root, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cli.Render(context.Background(), Deliver, TypeArchitecture, root, "d.json", "d.html"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	if want := "deliver architecture d.json d.html --quality standard --json\n1"; string(got) != want {
		t.Errorf("archify ran with %q, want %q (no --repo-root outside a checkout; update check off)", got, want)
	}

	old, _ := fakeArchify(t, "3.0.1")
	if _, err := FindCLI(root, old); err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Errorf("3.0.1: err = %v, want unsupported version", err)
	}
	none := func(string) string { return "" }
	if _, err := FindCLI(root, none); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("err = %v, want ErrNotInstalled", err)
	}
}
