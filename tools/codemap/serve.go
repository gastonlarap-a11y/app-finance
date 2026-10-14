package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/archify"
	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/index"
	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/viewer"
)

// serveViewer runs the local web UI on 127.0.0.1 until ctx ends.
func serveViewer(ctx context.Context, root string, port int, model string, out io.Writer) error {
	ix := index.New(index.Options{Root: root})
	opts := viewer.Options{
		Graph:      ix.Graph,
		DiagramDir: filepath.Join(root, filepath.FromSlash(diagramDir)),
		Diagram: func(ctx context.Context, kind, from, target string) (string, string, error) {
			return viewerDiagram(ctx, root, ix, kind, from, target)
		},
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locating codemap for the MCP server: %w", err)
	}
	asker, err := viewer.NewAsker(ctx, root, []string{exe, "mcp", "-root", root}, model)
	if err != nil {
		opts.AskOff = "Preguntar a la IA no está disponible: " + err.Error()
	} else {
		opts.Asker = asker
	}

	srv, err := viewer.New(opts)
	if err != nil {
		return err
	}
	ln, url, err := srv.Listen(port)
	if err != nil {
		return err
	}
	go func() {
		// Warm-up only: a failure resurfaces, with its message, on the first page.
		if _, err := ix.Graph(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "codemap: indexing:", err)
		}
	}()
	ask := "Preguntar a la IA: activo (tu Claude Code, solo lectura)"
	if opts.Asker == nil {
		ask = opts.AskOff
	}
	fmt.Fprintf(out, "codemap: abre %s\n%s\nCtrl+C para salir.\n", url, ask)

	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdown) // best effort on exit: open asks end with their context
	}()
	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serving: %w", err)
	}
	return nil
}

// viewerDiagram generates a diagram for the viewer and names its HTML file.
func viewerDiagram(ctx context.Context, root string, ix *index.Index, kind, from, target string) (string, string, error) {
	positional := []string{kind}
	if from != "" {
		positional = append(positional, from)
	}
	req, err := parseDiagram(positional, target, false)
	if err != nil {
		return "", "", err
	}
	g, err := ix.Graph(ctx)
	if err != nil {
		return "", "", err
	}
	var report strings.Builder
	file, err := runDiagram(ctx, root, g, req, &report)
	if err != nil {
		return "", report.String(), err
	}
	if file == "" {
		return "", report.String(), errors.New("el JSON quedó escrito pero falta Archify para el HTML: " + archify.InstallHint)
	}
	return file, report.String(), nil
}
