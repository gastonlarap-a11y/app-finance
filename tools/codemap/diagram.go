package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/archify"
	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// diagramDir holds generated diagrams (gitignored: Archify pins each one to a
// commit, so a checked-in copy would go stale with the next commit).
const diagramDir = ".codemap/diagrams"

// diagramRequest is one `codemap diagram` invocation.
type diagramRequest struct {
	kind     string // archify.TypeArchitecture or archify.TypeSequence
	from     string // sequence: the symbol the flow starts at
	target   string // sequence: desktop or web
	finalize bool   // also run Archify's real-browser check
}

func parseDiagram(positional []string, target string, finalize bool) (diagramRequest, error) {
	if len(positional) == 0 {
		return diagramRequest{}, errors.New("diagram needs a type: architecture | sequence NAME")
	}
	req := diagramRequest{kind: positional[0], target: target, finalize: finalize}
	switch req.kind {
	case archify.TypeArchitecture:
		if len(positional) > 1 {
			return req, errors.New("diagram architecture takes no name")
		}
	case archify.TypeSequence:
		req.from = strings.Join(positional[1:], " ")
		if req.from == "" {
			return req, errors.New("diagram sequence needs the symbol the flow starts at")
		}
		if req.target == "" {
			req.target = graph.TargetDesktop
		}
	default:
		return req, fmt.Errorf("unknown diagram type %q (architecture or sequence)", req.kind)
	}
	return req, nil
}

// runDiagram writes the Archify JSON under .codemap/diagrams and renders it
// with the installed Archify CLI; without Archify, it says how to get it.
// It returns the HTML file name when one was rendered.
func runDiagram(ctx context.Context, root string, g *graph.Graph, req diagramRequest, out io.Writer) (string, error) {
	// A diagram of a partial index would look complete: say so first.
	if _, err := io.WriteString(out, withNotes(g, "")); err != nil {
		return "", err
	}
	repo, err := archify.ReadRepo(ctx, root)
	if err != nil {
		return "", err
	}
	var slug string
	var doc any
	switch req.kind {
	case archify.TypeArchitecture:
		slug = "architecture"
		doc = archify.Architecture(g, repo, archify.ArchitectureOptions{Output: diagramDir + "/" + slug + ".html"})
	case archify.TypeSequence:
		nodes := g.Resolve(req.from)
		if len(nodes) != 1 {
			return "", errors.New(strings.TrimSpace(graph.CandidatesText(req.from, nodes)))
		}
		n := nodes[0]
		slug = "sequence-" + slugify(n.Name) + "-" + req.target
		seq, err := archify.Sequence(g, n, repo, archify.SequenceOptions{Output: diagramDir + "/" + slug + ".html", Target: req.target})
		if err != nil {
			return "", fmt.Errorf("%s (%s): %w", n.Name, req.target, err)
		}
		doc = seq
	}

	jsonRel, htmlRel := diagramDir+"/"+slug+".json", diagramDir+"/"+slug+".html"
	if err := writeJSON(filepath.Join(root, filepath.FromSlash(jsonRel)), doc); err != nil {
		return "", err
	}
	fmt.Fprintf(out, "JSON: %s\n", filepath.Join(root, filepath.FromSlash(jsonRel)))
	if len(repo.Dirty) > 0 && repo.Meta != nil {
		fmt.Fprintf(out, "Nota: %d archivos con cambios sin commit no se citan (Archify verifica contra %s).\n", len(repo.Dirty), repo.Meta.Revision[:7])
	}

	cli, err := archify.FindCLI(root, os.Getenv)
	if errors.Is(err, archify.ErrNotInstalled) {
		_, err := fmt.Fprintf(out, "Sin render: %s.\n", archify.InstallHint)
		return "", err
	}
	if err != nil {
		return "", err
	}
	cmd := archify.Deliver
	if req.finalize {
		cmd = archify.Finalize
	}
	report, err := cli.Render(ctx, cmd, req.kind, root, jsonRel, htmlRel)
	if err != nil {
		return "", fmt.Errorf("%w\n%s", err, graph.Clip(report, 4000))
	}
	_, err = fmt.Fprintf(out, "HTML: %s (archify %s %s)\n", filepath.Join(root, filepath.FromSlash(htmlRel)), cli.Version, cmd)
	return slug + ".html", err
}

func writeJSON(path string, doc any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Dir(path), err)
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding diagram: %w", err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

var slugChars = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	return strings.Trim(slugChars.ReplaceAllString(strings.ToLower(name), "-"), "-")
}
