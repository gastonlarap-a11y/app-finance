package graph

import (
	"strings"
	"testing"
)

func TestClip(t *testing.T) {
	text := strings.Repeat("0123456789\n", 10)
	got := Clip(text, 35)
	if !strings.HasPrefix(got, "0123456789\n0123456789\n0123456789\n") || !strings.Contains(got, "(8 líneas más") {
		t.Errorf("Clip = %q", got)
	}
	if Clip("short\n", 100) != "short\n" {
		t.Error("Clip changed a short text")
	}
}

func TestTestCommands(t *testing.T) {
	im := &Impact{
		GoTests: map[string][]string{"backend/finance": {"TestA", "TestB"}},
		TSTests: []string{"frontend/src/engine/x.test.ts", "frontend/src/components/Y.dom.test.tsx"},
	}
	got := TestCommands(im)
	for _, want := range []string{
		"go test -race -run '^(TestA|TestB)$' ./backend/finance",
		"cd frontend && npx vitest run --project unit src/engine/x.test.ts",
		"cd frontend && npx vitest run --project browser src/components/Y.dom.test.tsx",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("TestCommands missing %q in:\n%s", want, got)
		}
	}
	if !strings.Contains(TestCommands(&Impact{GoTests: map[string][]string{}}), "Ningún test") {
		t.Error("no tests must say so")
	}
}

func TestSymbolText(t *testing.T) {
	g := fixtureGraph()
	got := SymbolText(g, g.Nodes["go:pkg.Svc.Save"])
	for _, want := range []string{
		"pkg.Svc.Save [go method · bound Svc]",
		"contrato  SvcContract.Save",
		"desktop   pkg.Svc.Save",
		"web       createSvc.service.Save",
		"call Form.save [ts func]  @frontend/src/components/Form.tsx:5  (vía contrato)",
		"call pkg.persist",
		"escribe things  (vía pkg.persist)",
		"Tests que lo llaman directamente: 1",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("SymbolText missing %q in:\n%s", want, got)
		}
	}
}

func TestSymbolTextSplitsTablesByBuildForUI(t *testing.T) {
	g := fixtureGraph()
	got := SymbolText(g, g.Nodes["ts:form"])
	if !strings.Contains(got, "Tablas (desktop):") || !strings.Contains(got, "Tablas (web):") {
		t.Errorf("a component reaching the contract shows tables per build:\n%s", got)
	}
}

func TestTraceText(t *testing.T) {
	g := fixtureGraph()
	got := TraceText(g.Trace(g.Nodes["ts:form"], TraceOptions{}), TraceOptions{})
	for _, want := range []string{
		"└─ call Form.save  frontend/src/components/Form.tsx:4-6  @frontend/src/components/Form.tsx:9",
		"├─ [desktop] pkg.Svc.Save  backend/pkg/svc.go:10-20",
		"└─ [web] createSvc.service.Save",
		"write things",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("TraceText missing %q in:\n%s", want, got)
		}
	}
}
