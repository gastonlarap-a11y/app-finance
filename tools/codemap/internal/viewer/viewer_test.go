package viewer

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// ---------- a fake claude: this test binary, run with CODEMAP_FAKE_CLAUDE=1 ----------

func TestMain(m *testing.M) {
	if os.Getenv("CODEMAP_FAKE_CLAUDE") == "1" {
		os.Exit(fakeClaude())
	}
	os.Exit(m.Run())
}

// fakeClaude records its argv, stdin and auth environment, then answers in
// claude's stream-json shape. A question containing "lento" waits first.
func fakeClaude() int {
	stdin, _ := io.ReadAll(os.Stdin)
	rec := map[string]any{
		"args":   os.Args[1:],
		"stdin":  string(stdin),
		"apiKey": os.Getenv("ANTHROPIC_API_KEY"),
	}
	raw, _ := json.Marshal(rec)
	_ = os.WriteFile(os.Getenv("CODEMAP_FAKE_RECORD"), raw, 0o600)
	if strings.Contains(string(stdin), "lento") {
		_ = os.WriteFile(os.Getenv("CODEMAP_FAKE_RECORD")+".started", nil, 0o600)
		time.Sleep(3 * time.Second)
	}
	for _, line := range []string{
		`{"type":"system","subtype":"init","session_id":"0b6c1f3e-1111-2222-3333-444455556666"}`,
		`{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp__codemap__codemap_trace"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hola "}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"mundo"}}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Hola mundo"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Hola mundo","session_id":"0b6c1f3e-1111-2222-3333-444455556666"}`,
	} {
		fmt.Println(line)
	}
	return 0
}

// ---------- fixtures ----------

func testGraph() *graph.Graph {
	g := graph.New()
	p := func(file string, line int) graph.Pos { return graph.Pos{File: file, Line: line, EndLine: line + 3} }
	for _, n := range []*graph.Node{
		{ID: "ts:form", Name: "Form", Lang: graph.LangTS, Kind: graph.KindComponent, Pos: p("frontend/src/components/Form.tsx", 1)},
		{ID: "ts:form#save", Name: "Form.save", Lang: graph.LangTS, Kind: graph.KindFunc, Parent: "ts:form", Pos: p("frontend/src/components/Form.tsx", 4)},
		{ID: "ts:iface", Name: "SvcContract", Lang: graph.LangTS, Kind: graph.KindType, Pos: p("frontend/src/services/contract.ts", 1)},
		{ID: "ts:hub", Name: "SvcContract.Save", Lang: graph.LangTS, Kind: graph.KindContractMethod, Parent: "ts:iface", Pos: p("frontend/src/services/contract.ts", 2)},
		{ID: "go:pkg.Svc", Name: "pkg.Svc", Lang: graph.LangGo, Kind: graph.KindType, Pos: p("backend/pkg/svc.go", 1)},
		{ID: "go:pkg.Svc.Save", Name: "pkg.Svc.Save", Lang: graph.LangGo, Kind: graph.KindMethod, Bound: "Svc", Parent: "go:pkg.Svc", Pos: p("backend/pkg/svc.go", 10)},
		{ID: "ts:engine#Save", Name: "createSvc.service.Save", Lang: graph.LangTS, Kind: graph.KindEngineMethod, Pos: p("frontend/src/engine/svc.ts", 5)},
		{ID: "sql:things", Name: "things", Lang: graph.LangSQL, Kind: graph.KindTable, Pos: graph.Pos{File: "backend/pkg/migrations/1.up.sql", Line: 1}},
		{ID: "go:pkg.TestSave", Name: "pkg.TestSave", Lang: graph.LangGo, Kind: graph.KindTestFunc, Pos: p("backend/pkg/svc_test.go", 3)},
		{ID: "ts:evil", Name: "<script>alert(1)</script>", Lang: graph.LangTS, Kind: graph.KindFunc, Pos: p("frontend/src/x.ts", 1)},
	} {
		g.AddNode(n)
	}
	for _, e := range []graph.Edge{
		{From: "ts:form", To: "ts:form#save", Kind: graph.EdgeCall},
		{From: "ts:form#save", To: "ts:hub", Kind: graph.EdgeCall, At: graph.Pos{File: "frontend/src/components/Form.tsx", Line: 5}},
		{From: "ts:hub", To: "go:pkg.Svc.Save", Kind: graph.EdgeDispatch, Target: graph.TargetDesktop},
		{From: "ts:hub", To: "ts:engine#Save", Kind: graph.EdgeDispatch, Target: graph.TargetWeb},
		{From: "go:pkg.Svc.Save", To: "sql:things", Kind: graph.EdgeWrite},
		{From: "ts:engine#Save", To: "sql:things", Kind: graph.EdgeWrite},
		{From: "go:pkg.TestSave", To: "go:pkg.Svc.Save", Kind: graph.EdgeCall},
	} {
		g.AddEdge(e)
	}
	g.Finish()
	return g
}

type harness struct {
	srv    *Server
	ts     *httptest.Server
	client *http.Client // logged in (has the cookie)
	record string       // fake claude's record file
}

// start serves the fixture with a fake claude; askOff disables Ask.
func start(t *testing.T, askOff bool) *harness {
	t.Helper()
	dir := t.TempDir()
	diagrams := filepath.Join(dir, "diagrams")
	if err := os.MkdirAll(diagrams, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(diagrams, "architecture.html"), []byte("<p>diagram</p>"), 0o600); err != nil {
		t.Fatal(err)
	}
	g := testGraph()
	record := filepath.Join(dir, "claude.json")
	opts := Options{
		Graph:      func(context.Context) (*graph.Graph, error) { return g, nil },
		DiagramDir: diagrams,
		Diagram: func(_ context.Context, kind, from, target string) (string, string, error) {
			if kind == "architecture" {
				return "architecture.html", "ok", nil
			}
			return "", "report", fmt.Errorf("no %s for %s/%s", kind, from, target)
		},
	}
	if askOff {
		opts.AskOff = "sin claude"
	} else {
		env := append(os.Environ(), "CODEMAP_FAKE_CLAUDE=1", "CODEMAP_FAKE_RECORD="+record, "ANTHROPIC_API_KEY=sk-should-not-pass")
		opts.Asker = newAsker(os.Args[0], dir, []string{"/bin/codemap", "mcp", "-root", dir}, "", env)
	}
	srv, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	ln, link, err := srv.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(srv.Handler())
	ts.Listener = ln
	ts.Start()
	t.Cleanup(ts.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	res, err := client.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Request.URL.Path != "/" {
		t.Fatalf("login via token link: %d %s", res.StatusCode, res.Request.URL)
	}
	return &harness{srv: srv, ts: ts, client: client, record: record}
}

func (h *harness) get(t *testing.T, path string) (int, string, http.Header) {
	t.Helper()
	res, err := h.client.Get(h.ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, string(body), res.Header
}

func (h *harness) post(ctx context.Context, t *testing.T, path, body string, mutate func(*http.Request)) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.ts.URL)
	if mutate != nil {
		mutate(req)
	}
	res, err := h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// ---------- security ----------

func TestGuard(t *testing.T) {
	h := start(t, true)
	anonymous := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	t.Run("no token", func(t *testing.T) {
		res, err := anonymous.Get(h.ts.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("status %d, want 401", res.StatusCode)
		}
	})

	t.Run("wrong token", func(t *testing.T) {
		res, err := anonymous.Get(h.ts.URL + "/?t=nope")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("status %d, want 403", res.StatusCode)
		}
	})

	t.Run("token becomes a strict HttpOnly cookie", func(t *testing.T) {
		res, err := anonymous.Get(h.ts.URL + "/?t=" + h.srv.token)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		c := res.Cookies()
		if res.StatusCode != http.StatusSeeOther || len(c) != 1 || !c[0].HttpOnly || c[0].SameSite != http.SameSiteStrictMode {
			t.Errorf("status %d cookies %+v", res.StatusCode, c)
		}
	})

	t.Run("foreign Host (DNS rebinding)", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodGet, h.ts.URL+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = "evil.example:80"
		res, err := h.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusMisdirectedRequest {
			t.Errorf("status %d, want 421", res.StatusCode)
		}
	})

	posts := []struct {
		name   string
		mutate func(*http.Request)
		want   int
	}{
		{"POST without Origin (CSRF)", func(r *http.Request) { r.Header.Del("Origin") }, http.StatusForbidden},
		{"POST from another origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, http.StatusForbidden},
		{"POST not JSON (simple form request)", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, http.StatusUnsupportedMediaType},
	}
	for _, tt := range posts {
		t.Run(tt.name, func(t *testing.T) {
			res := h.post(context.Background(), t, "/api/ask", `{"question":"x"}`, tt.mutate)
			res.Body.Close()
			if res.StatusCode != tt.want {
				t.Errorf("status %d, want %d", res.StatusCode, tt.want)
			}
		})
	}

	t.Run("pages carry a strict CSP", func(t *testing.T) {
		_, _, hdr := h.get(t, "/")
		if hdr.Get("Content-Security-Policy") != pageCSP || hdr.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("headers %v", hdr)
		}
	})
}

// ---------- pages ----------

func TestPages(t *testing.T) {
	h := start(t, true)
	tests := []struct {
		path string
		want []string
	}{
		{"/", []string{"Servicios Wails", "Svc", "things"}},
		{"/symbol?id=" + url.QueryEscape("go:pkg.Svc.Save"), []string{
			"pkg.Svc.Save", "bound Svc", "Espejos", "SvcContract.Save", "createSvc.service.Save",
			"Form.save", "(vía contrato)", "escribe", "things", "pkg.TestSave",
		}},
		{"/symbol?id=" + url.QueryEscape("ts:form"), []string{"Flujo desktop", "Flujo web", "Tablas (desktop)", "Tablas (web)"}},
		{"/trace?id=" + url.QueryEscape("ts:form"), []string{"[desktop]", "[web]", "pkg.Svc.Save", "createSvc.service.Save", "things"}},
		{"/trace?id=" + url.QueryEscape("ts:form") + "&target=web", []string{"[web]"}},
		{"/impact?id=" + url.QueryEscape("go:pkg.Svc.Save"), []string{"Cambian juntos", "Form", "go test -race -run &#39;^(TestSave)$&#39; ./backend/pkg"}},
		{"/search?q=sav", []string{"Form.save", "pkg.Svc.Save"}},
		{"/symbol?id=" + url.QueryEscape("ts:evil"), []string{"&lt;script&gt;alert(1)&lt;/script&gt;"}},
		{"/diagrams", []string{"architecture.html"}},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			status, body, _ := h.get(t, tt.path)
			if status != http.StatusOK {
				t.Fatalf("status %d:\n%s", status, body)
			}
			for _, want := range tt.want {
				if !strings.Contains(body, want) {
					t.Errorf("page lacks %q", want)
				}
			}
			if strings.Contains(body, "<script>alert(1)") {
				t.Error("a symbol name reached the page unescaped")
			}
		})
	}

	t.Run("web-only trace leaves the desktop branch out", func(t *testing.T) {
		_, body, _ := h.get(t, "/trace?id="+url.QueryEscape("ts:form")+"&target=web")
		if strings.Contains(body, "[desktop]") {
			t.Error("desktop branch in a web trace")
		}
	})

	t.Run("unknown symbol is a 404 with candidates", func(t *testing.T) {
		if status, _, _ := h.get(t, "/symbol?id=nothing-like-this"); status != http.StatusNotFound {
			t.Errorf("status %d, want 404", status)
		}
	})

	t.Run("Ask off says why", func(t *testing.T) {
		_, body, _ := h.get(t, "/")
		if !strings.Contains(body, "sin claude") || strings.Contains(body, `id="ask-form"`) {
			t.Error("the panel must show why Ask is off and no form")
		}
	})
}

// ---------- diagrams ----------

func TestDiagrams(t *testing.T) {
	h := start(t, true)

	t.Run("listed file is served sandboxed", func(t *testing.T) {
		status, body, hdr := h.get(t, "/diagram-file/architecture.html")
		if status != http.StatusOK || body != "<p>diagram</p>" || !strings.HasPrefix(hdr.Get("Content-Security-Policy"), "sandbox allow-scripts") {
			t.Errorf("status %d CSP %q body %q", status, hdr.Get("Content-Security-Policy"), body)
		}
	})

	for _, path := range []string{
		"/diagram-file/missing.html",
		"/diagram-file/..%2F..%2Fgo.mod",
		"/diagrams/view?name=" + url.QueryEscape("../../go.mod"),
		"/diagrams/view?name=ARCHITECTURE.html",
	} {
		t.Run("rejects "+path, func(t *testing.T) {
			if status, _, _ := h.get(t, path); status != http.StatusNotFound {
				t.Errorf("status %d, want 404", status)
			}
		})
	}

	t.Run("generate returns the viewer link", func(t *testing.T) {
		res := h.post(context.Background(), t, "/api/diagram", `{"kind":"architecture"}`, nil)
		defer res.Body.Close()
		var body map[string]string
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK || body["view"] != "/diagrams/view?name=architecture.html" {
			t.Errorf("status %d body %v", res.StatusCode, body)
		}
	})

	t.Run("generation errors are reported", func(t *testing.T) {
		res := h.post(context.Background(), t, "/api/diagram", `{"kind":"sequence","from":"x","target":"web"}`, nil)
		res.Body.Close()
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("status %d, want 422", res.StatusCode)
		}
	})
}

// ---------- ask ----------

func readEvents(t *testing.T, r io.Reader) []AskEvent {
	t.Helper()
	var out []AskEvent
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		var ev AskEvent
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("bad event %q: %v", sc.Text(), err)
		}
		out = append(out, ev)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

type fakeRecord struct {
	Args   []string `json:"args"`
	Stdin  string   `json:"stdin"`
	APIKey string   `json:"apiKey"`
}

func (h *harness) lastRun(t *testing.T) fakeRecord {
	t.Helper()
	raw, err := os.ReadFile(h.record)
	if err != nil {
		t.Fatal(err)
	}
	var rec fakeRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestAsk(t *testing.T) {
	h := start(t, false)

	res := h.post(context.Background(), t, "/api/ask", `{"question":"¿Qué hace Save?","symbol":"go:pkg.Svc.Save"}`, nil)
	events := readEvents(t, res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("status %d type %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	var text strings.Builder
	var kinds []string
	for _, ev := range events {
		kinds = append(kinds, ev.Kind)
		if ev.Kind == "text" {
			text.WriteString(ev.Text)
		}
	}
	if text.String() != "Hola mundo" {
		t.Errorf("text = %q (the full assistant message must not repeat the deltas)", text.String())
	}
	if want := []string{"session", "tool", "text", "text", "done"}; !slices.Equal(kinds, want) {
		t.Errorf("events = %v, want %v", kinds, want)
	}

	rec := h.lastRun(t)
	args := strings.Join(rec.Args, " ")
	root := "//" + strings.TrimPrefix(filepath.ToSlash(h.srv.opts.Asker.Root), "/")
	for _, want := range []string{
		"--print", "--output-format stream-json", "--restricted", "--tools Read,Grep,Glob", "--strict-mcp-config",
		"--allowedTools Read,Grep,Glob,mcp__codemap", "--permission-mode dontAsk", "--permission-prompts none",
		`"command":"/bin/codemap"`, "Read(" + root + "/config.toml)", "Read(" + root + "/**/*.db)",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("claude argv lacks %q:\n%s", want, args)
		}
	}
	for _, never := range []string{"--bare", "--resume", "bypassPermissions"} {
		if strings.Contains(args, never) {
			t.Errorf("claude argv must not contain %q", never)
		}
	}
	if rec.APIKey != "" {
		t.Error("ANTHROPIC_API_KEY reached claude: it would bill the key instead of the subscription")
	}
	if !strings.Contains(rec.Stdin, "Contexto: estoy mirando pkg.Svc.Save") || !strings.Contains(rec.Stdin, "¿Qué hace Save?") {
		t.Errorf("stdin = %q", rec.Stdin)
	}

	t.Run("a follow-up resumes the session", func(t *testing.T) {
		res := h.post(context.Background(), t, "/api/ask", `{"question":"¿y en web?","session":"0b6c1f3e-1111-2222-3333-444455556666"}`, nil)
		readEvents(t, res.Body)
		res.Body.Close()
		if args := strings.Join(h.lastRun(t).Args, " "); !strings.Contains(args, "--resume 0b6c1f3e-1111-2222-3333-444455556666") {
			t.Errorf("argv lacks --resume: %s", args)
		}
	})

	t.Run("a session that looks like a flag is refused", func(t *testing.T) {
		res := h.post(context.Background(), t, "/api/ask", `{"question":"x","session":"--dangerously-skip-permissions"}`, nil)
		res.Body.Close()
		if res.StatusCode != http.StatusBadGateway {
			t.Errorf("status %d, want 502", res.StatusCode)
		}
	})

	t.Run("one question at a time, and a cancelled one frees the slot", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.ts.URL+"/api/ask", strings.NewReader(`{"question":"pregunta lento"}`))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", h.ts.URL)
			if res, err := h.client.Do(req); err == nil {
				_, _ = io.Copy(io.Discard, res.Body)
				res.Body.Close()
			}
		}()
		deadline := time.Now().Add(5 * time.Second)
		for {
			if _, err := os.Stat(h.record + ".started"); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the slow question never started")
			}
			time.Sleep(20 * time.Millisecond)
		}
		busy := h.post(context.Background(), t, "/api/ask", `{"question":"otra"}`, nil)
		busy.Body.Close()
		if busy.StatusCode != http.StatusConflict {
			t.Errorf("status %d, want 409 while another question runs", busy.StatusCode)
		}
		cancel()
		<-done
		deadline = time.Now().Add(10 * time.Second)
		for {
			res := h.post(context.Background(), t, "/api/ask", `{"question":"de nuevo"}`, nil)
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("slot never freed after cancel: %d", res.StatusCode)
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
}

func TestParseClaudeLines(t *testing.T) {
	var p claudeParser
	lines := []string{
		`{"type":"system","subtype":"status"}`,
		`not json`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"sin deltas"},{"type":"tool_use","name":"Read"}]}}`,
		`{"type":"result","is_error":true,"result":"límite alcanzado","session_id":"s"}`,
	}
	var got []AskEvent
	for _, l := range lines {
		got = append(got, p.parse([]byte(l))...)
	}
	want := []AskEvent{{Kind: "text", Text: "sin deltas"}, {Kind: "tool", Text: "Read"}, {Kind: "error", Text: "límite alcanzado", Session: "s"}}
	if !slices.Equal(got, want) {
		t.Errorf("events = %+v, want %+v (without deltas the assistant message carries the text)", got, want)
	}
}

func TestMissingFlags(t *testing.T) {
	help := strings.Join(requiredFlags[1:], "\n")
	if got := missingFlags(help); !slices.Equal(got, requiredFlags[:1]) {
		t.Errorf("missing = %v, want %v", got, requiredFlags[:1])
	}
}
