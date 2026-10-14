// Package viewer is codemap's local web UI: search, symbol pages with their
// Go⇄TS mirrors, flows down to the tables, impact, Archify diagrams, and a
// panel that asks the user's own Claude Code about the code.
//
// It listens on 127.0.0.1 only and, because it can run the claude CLI, every
// request must carry the per-launch token (exchanged once for an HttpOnly,
// SameSite=Strict cookie), name this server as Host (DNS rebinding) and, for
// POSTs, come from this origin as JSON (CSRF).
package viewer

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

//go:embed templates/*.html static/*
var assets embed.FS

const cookieName = "codemap_token"

// pageCSP: scripts and styles only from this server, frames only of its own
// diagram files, nothing embeds the viewer.
const pageCSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// diagramCSP sandboxes an Archify HTML file: its inline viewer script runs,
// but in an opaque origin that cannot reach this server's API or cookies.
const diagramCSP = "sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox; " +
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
	"frame-ancestors 'self'"

var diagramName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*\.html$`)

// DiagramFunc generates a diagram (architecture, or the sequence of from on
// target) and returns the HTML file name written in DiagramDir and a report.
type DiagramFunc func(ctx context.Context, kind, from, target string) (file, report string, err error)

// Options wires the viewer.
type Options struct {
	Graph      func(ctx context.Context) (*graph.Graph, error)
	Asker      *Asker // nil: Ask is off, AskOff says why
	AskOff     string
	Diagram    DiagramFunc
	DiagramDir string
}

// Server serves the viewer on one listener.
type Server struct {
	opts   Options
	token  string
	tmpl   *template.Template
	static fs.FS
	host   string // "127.0.0.1:<port>", set by Listen
}

// New prepares a server with a fresh token.
func New(opts Options) (*Server, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("generating token: %w", err)
	}
	tmpl, err := template.New("").Funcs(funcs).ParseFS(assets, "templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parsing templates: %w", err)
	}
	static, err := fs.Sub(assets, "static")
	if err != nil {
		return nil, fmt.Errorf("static assets: %w", err)
	}
	return &Server{opts: opts, token: hex.EncodeToString(raw), tmpl: tmpl, static: static}, nil
}

// Listen binds 127.0.0.1:port (0 picks a free port) and returns the URL to
// open, which carries the token.
func (s *Server) Listen(port int) (net.Listener, string, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, "", fmt.Errorf("listening: %w", err)
	}
	s.host = ln.Addr().String()
	return ln, "http://" + s.host + "/?t=" + s.token, nil
}

// Handler is every route behind the security checks.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(s.static)))
	mux.HandleFunc("GET /{$}", s.home)
	mux.HandleFunc("GET /search", s.search)
	mux.HandleFunc("GET /symbol", s.symbol)
	mux.HandleFunc("GET /trace", s.trace)
	mux.HandleFunc("GET /impact", s.impact)
	mux.HandleFunc("GET /diagrams", s.diagrams)
	mux.HandleFunc("GET /diagrams/view", s.diagramView)
	mux.HandleFunc("GET /diagram-file/{name}", s.diagramFile)
	mux.HandleFunc("POST /api/diagram", s.apiDiagram)
	mux.HandleFunc("POST /api/ask", s.apiAsk)
	return s.guard(mux)
}

func (s *Server) allowedHost(host string) bool {
	_, port, err := net.SplitHostPort(s.host)
	return err == nil && (host == s.host || host == "localhost:"+port)
}

// guard enforces Host, token and (for POST) origin and content type.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		if !s.allowedHost(r.Host) {
			http.Error(w, "host no permitido", http.StatusMisdirectedRequest)
			return
		}
		if t := r.URL.Query().Get("t"); t != "" && r.URL.Path == "/" {
			if subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) != 1 {
				http.Error(w, "token inválido", http.StatusForbidden)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: s.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		c, err := r.Cookie(cookieName)
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.token)) != 1 {
			http.Error(w, "abre el enlace con token que imprimió `codemap serve`", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodPost {
			if r.Header.Get("Origin") != "http://"+r.Host {
				http.Error(w, "origen no permitido", http.StatusForbidden)
				return
			}
			if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
				http.Error(w, "se espera application/json", http.StatusUnsupportedMediaType)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- pages ----------

type page struct {
	Title  string
	Query  string
	Symbol *graph.Node // the page's subject: context for Ask
	AskOff string
	Notes  []string
	Body   any
}

func (s *Server) render(w http.ResponseWriter, name string, p page) {
	p.AskOff = s.askOff()
	w.Header().Set("Content-Security-Policy", pageCSP)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.tmpl.ExecuteTemplate(w, name, p); err != nil {
		http.Error(w, "error al mostrar la página: "+err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) askOff() string {
	if s.opts.Asker == nil {
		if s.opts.AskOff != "" {
			return s.opts.AskOff
		}
		return "Preguntar a la IA no está disponible"
	}
	return ""
}

func (s *Server) graph(w http.ResponseWriter, r *http.Request) (*graph.Graph, bool) {
	g, err := s.opts.Graph(r.Context())
	if err != nil {
		http.Error(w, "no se pudo indexar el repositorio: "+err.Error(), http.StatusInternalServerError)
		return nil, false
	}
	return g, true
}

func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	g, ok := s.graph(w, r)
	if !ok {
		return
	}
	ov := g.Overview()
	s.render(w, "home.html", page{Title: "Mapa del código", Notes: g.Notes, Body: homeBody{Overview: ov, Services: s.serviceLinks(g, ov)}})
}

type homeBody struct {
	Overview graph.Overview
	Services []serviceLink
}

type serviceLink struct {
	Summary graph.ServiceSummary
	Node    *graph.Node // the Go type, when found
}

func (s *Server) serviceLinks(g *graph.Graph, ov graph.Overview) []serviceLink {
	var out []serviceLink
	for _, svc := range ov.Services {
		link := serviceLink{Summary: svc}
		for _, n := range g.Resolve(svc.Name) {
			if n.Kind == graph.KindType && strings.HasPrefix(n.Pos.File, svc.Dir+"/") {
				link.Node = n
			}
		}
		out = append(out, link)
	}
	return out
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	g, ok := s.graph(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	hits := g.Search(q, graph.SearchOptions{Limit: 60})
	if len(hits) == 1 {
		http.Redirect(w, r, href(hits[0]), http.StatusSeeOther)
		return
	}
	s.render(w, "search.html", page{Title: "Buscar: " + q, Query: q, Notes: g.Notes, Body: hits})
}

// node reads ?id= (or a name) and answers 404 or a candidates page itself.
func (s *Server) node(w http.ResponseWriter, r *http.Request, g *graph.Graph) (*graph.Node, bool) {
	id := r.URL.Query().Get("id")
	if n := g.Nodes[id]; n != nil {
		return n, true
	}
	nodes := g.Resolve(id)
	if len(nodes) == 1 {
		return nodes[0], true
	}
	w.WriteHeader(http.StatusNotFound)
	s.render(w, "search.html", page{Title: "No encontrado: " + id, Query: id, Notes: g.Notes, Body: nodes})
	return nil, false
}

type symbolBody struct {
	Node      *graph.Node
	Parent    *graph.Node
	Hub       *graph.Node
	Mirrors   []graph.Mirror
	Members   []*graph.Node
	Callers   []graph.Caller
	Tests     []graph.Caller
	Callees   []edgeView
	Tables    []tableGroup
	Reachable bool // reaches the contract: has a desktop and a web flow
}

// edgeView is an outgoing edge with its target node.
type edgeView struct {
	Edge graph.Edge
	Node *graph.Node
}

type tableGroup struct {
	Target string
	Uses   []graph.TableUse
}

func (s *Server) symbol(w http.ResponseWriter, r *http.Request) {
	g, ok := s.graph(w, r)
	if !ok {
		return
	}
	n, ok := s.node(w, r, g)
	if !ok {
		return
	}
	b := symbolBody{Node: n, Parent: g.Nodes[n.Parent], Hub: g.Hub(n)}
	for _, e := range g.Callees(n) {
		b.Callees = append(b.Callees, edgeView{Edge: e, Node: g.Nodes[e.To]})
	}
	if b.Hub != nil {
		b.Mirrors = g.Mirrors(b.Hub)
	}
	for _, m := range g.SortedNodes() {
		if m.Parent == n.ID {
			b.Members = append(b.Members, m)
		}
	}
	for _, c := range g.Callers(n) {
		if graph.IsTestCode(c.Node) {
			// A TS test reaching a Go method through the contract tests the engine.
			if !c.ViaContract || n.Lang != graph.LangGo {
				b.Tests = append(b.Tests, c)
			}
		} else {
			b.Callers = append(b.Callers, c)
		}
	}
	b.Reachable = g.ReachesBoundary(n)
	if b.Reachable && n.Kind != graph.KindEngineMethod && n.Bound == "" {
		b.Tables = []tableGroup{{graph.TargetDesktop, g.Tables(n, graph.TargetDesktop)}, {graph.TargetWeb, g.Tables(n, graph.TargetWeb)}}
	} else if uses := g.Tables(n, ""); len(uses) > 0 {
		b.Tables = []tableGroup{{"", uses}}
	}
	s.render(w, "symbol.html", page{Title: n.Name, Symbol: n, Notes: g.Notes, Body: b})
}

type traceBody struct {
	Root   *graph.TraceNode
	Target string
	Full   bool
}

func (s *Server) trace(w http.ResponseWriter, r *http.Request) {
	g, ok := s.graph(w, r)
	if !ok {
		return
	}
	n, ok := s.node(w, r, g)
	if !ok {
		return
	}
	target := r.URL.Query().Get("target")
	if target != graph.TargetDesktop && target != graph.TargetWeb {
		target = ""
	}
	full := r.URL.Query().Get("full") == "1"
	root := g.Trace(n, graph.TraceOptions{Target: target, Full: full})
	s.render(w, "trace.html", page{Title: "Flujo: " + n.Name, Symbol: n, Notes: g.Notes, Body: traceBody{Root: root, Target: target, Full: full}})
}

func (s *Server) impact(w http.ResponseWriter, r *http.Request) {
	g, ok := s.graph(w, r)
	if !ok {
		return
	}
	n, ok := s.node(w, r, g)
	if !ok {
		return
	}
	im := g.Impact(n, 0)
	s.render(w, "impact.html", page{Title: "Impacto: " + n.Name, Symbol: n, Notes: g.Notes, Body: impactBody{Impact: im, Commands: graph.TestCommands(im)}})
}

type impactBody struct {
	Impact   *graph.Impact
	Commands string
}

// ---------- diagrams ----------

type diagramFile struct {
	Name     string
	Modified time.Time
}

func (s *Server) diagramFiles() []diagramFile {
	entries, err := os.ReadDir(s.opts.DiagramDir)
	if err != nil {
		return nil // no diagram generated yet
	}
	var out []diagramFile
	for _, e := range entries {
		if e.IsDir() || !diagramName.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, diagramFile{Name: e.Name(), Modified: info.ModTime()})
	}
	slices.SortFunc(out, func(a, b diagramFile) int { return b.Modified.Compare(a.Modified) })
	return out
}

func (s *Server) diagrams(w http.ResponseWriter, _ *http.Request) {
	s.render(w, "diagrams.html", page{Title: "Diagramas", Body: s.diagramFiles()})
}

func (s *Server) diagramView(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if !s.isDiagram(name) {
		http.NotFound(w, r)
		return
	}
	s.render(w, "diagram.html", page{Title: name, Body: name})
}

// isDiagram accepts only a listed file name: no path, no traversal.
func (s *Server) isDiagram(name string) bool {
	return slices.ContainsFunc(s.diagramFiles(), func(f diagramFile) bool { return f.Name == name })
}

func (s *Server) diagramFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !s.isDiagram(name) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Security-Policy", diagramCSP)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeFile(w, r, filepath.Join(s.opts.DiagramDir, name))
}

type diagramRequest struct {
	Kind   string `json:"kind"`
	From   string `json:"from"`
	Target string `json:"target"`
}

func (s *Server) apiDiagram(w http.ResponseWriter, r *http.Request) {
	var req diagramRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "solicitud inválida"})
		return
	}
	file, report, err := s.opts.Diagram(r.Context(), req.Kind, req.From, req.Target)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error(), "report": report})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"file": file, "report": report, "view": "/diagrams/view?name=" + url.QueryEscape(file)})
}

// ---------- ask ----------

func (s *Server) apiAsk(w http.ResponseWriter, r *http.Request) {
	if s.opts.Asker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": s.askOff()})
		return
	}
	var req AskRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "solicitud inválida"})
		return
	}
	symbolContext := ""
	if req.Symbol != "" {
		if g, err := s.opts.Graph(r.Context()); err == nil {
			if n := g.Nodes[req.Symbol]; n != nil {
				symbolContext = fmt.Sprintf("%s %s (%s)", n.Name, graph.Tag(n), graph.Loc(n.Pos))
			}
		}
	}
	flusher, _ := w.(http.Flusher)
	started := false
	enc := json.NewEncoder(w)
	emit := func(ev AskEvent) error {
		if !started {
			w.Header().Set("Content-Type", "application/x-ndjson")
			w.WriteHeader(http.StatusOK)
			started = true
		}
		if err := enc.Encode(ev); err != nil {
			return fmt.Errorf("writing event: %w", err)
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	err := s.opts.Asker.Ask(r.Context(), req, symbolContext, emit)
	switch {
	case errors.Is(err, errBusy):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case err != nil && !started:
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
	case err != nil:
		_ = emit(AskEvent{Kind: "error", Text: err.Error()}) // the client may already be gone; nothing else to tell
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) // the status line is sent; a write error means the client left
}

// ---------- template helpers ----------

var funcs = template.FuncMap{
	"href": href,
	"loc":  graph.Loc,
	"tag":  graph.Tag,
	"traceHref": func(n *graph.Node, target string) string {
		return "/trace?id=" + url.QueryEscape(n.ID) + "&target=" + url.QueryEscape(target)
	},
	"impactHref":  func(n *graph.Node) string { return "/impact?id=" + url.QueryEscape(n.ID) },
	"inc":         func(i int) int { return i + 1 },
	"verbs":       verbs,
	"kindCounts":  kindCounts,
	"sortedTests": sortedTests,
}

func href(n *graph.Node) string { return "/symbol?id=" + url.QueryEscape(n.ID) }

func verbs(u graph.TableUse) string {
	var v []string
	if u.Write {
		v = append(v, "escribe")
	}
	if u.Read {
		v = append(v, "lee")
	}
	if len(v) == 0 {
		v = append(v, "menciona")
	}
	return strings.Join(v, " + ")
}

func kindCounts(m map[graph.Kind]int) string {
	kinds := make([]graph.Kind, 0, len(m))
	for k := range m {
		kinds = append(kinds, k)
	}
	slices.Sort(kinds)
	parts := make([]string, 0, len(kinds))
	for _, k := range kinds {
		parts = append(parts, fmt.Sprintf("%d %s", m[k], k))
	}
	return strings.Join(parts, " · ")
}

// sortedTests lists test file names (TS) and test function names (Go) once each.
func sortedTests(tests []graph.Caller) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range tests {
		name := c.Node.Name
		if c.Node.Lang == graph.LangTS {
			name = c.Node.Pos.File
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	slices.Sort(out)
	return out
}
