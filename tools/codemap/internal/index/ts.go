package index

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// tsExtractVersion must match EXTRACT_VERSION in frontend/scripts/codemap-ts.ts.
const tsExtractVersion = 1

// tsExtract mirrors the JSON written by frontend/scripts/codemap-ts.ts.
type tsExtract struct {
	Version         int                `json:"version"`
	Symbols         []tsSymbol         `json:"symbols"`
	Edges           []tsEdge           `json:"edges"`
	Implementations []tsImplementation `json:"implementations"`
	Bindings        []tsBinding        `json:"bindings"`
	BindingCalls    []tsBindingCall    `json:"bindingCalls"`
	SQL             []tsSQL            `json:"sql"`
}

type tsPos struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine"`
}

type tsSymbol struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Pos       tsPos  `json:"pos"`
	Parent    string `json:"parent"`
	Signature string `json:"signature"`
	Doc       string `json:"doc"`
}

type tsEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
	At   tsPos  `json:"at"`
}

type tsImplementation struct {
	Impl     string `json:"impl"`
	Contract string `json:"contract"`
}

type tsBinding struct {
	Contract string `json:"contract"`
	GoPkg    string `json:"goPkg"`
	GoType   string `json:"goType"`
}

type tsBindingCall struct {
	From   string `json:"from"`
	GoPkg  string `json:"goPkg"`
	GoType string `json:"goType"`
	Method string `json:"method"`
	At     tsPos  `json:"at"`
}

type tsSQL struct {
	From string `json:"from"`
	Text string `json:"text"`
	At   tsPos  `json:"at"`
}

// tsSource says where the frontend lives and how to run the extractor.
type tsSource struct {
	// Script is frontend/scripts/codemap-ts.ts; it imports `typescript` from
	// the frontend's node_modules, which Node resolves from the script's folder.
	Script   string
	Tsconfig string
	Node     string
}

// errNoTS means the TypeScript half cannot be indexed on this machine (no
// Node, or no `npm ci` yet); the map is then Go-only, with a note.
var errNoTS = errors.New("TypeScript not indexed")

// loadTS runs the extractor and decodes its output.
func loadTS(ctx context.Context, root string, src tsSource) (*tsExtract, error) {
	if _, err := os.Stat(src.Tsconfig); err != nil {
		return nil, fmt.Errorf("%w: no %s", errNoTS, filepath.Base(src.Tsconfig))
	}
	node, err := exec.LookPath(src.Node)
	if err != nil {
		return nil, fmt.Errorf("%w: %s not found (install Node 24, see frontend/.nvmrc)", errNoTS, src.Node)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(src.Script), "..", "node_modules", "typescript")); err != nil {
		return nil, fmt.Errorf("%w: frontend/node_modules/typescript missing (run `npm ci` in frontend)", errNoTS)
	}
	cmd := exec.CommandContext(ctx, node, src.Script, "--codemap-emit", src.Tsconfig, "--root", root)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("running %s: %w: %s", filepath.Base(src.Script), err, strings.TrimSpace(stderr.String()))
	}
	var ex tsExtract
	if err := json.Unmarshal(stdout.Bytes(), &ex); err != nil {
		return nil, fmt.Errorf("decoding TypeScript index: %w", err)
	}
	if ex.Version != tsExtractVersion {
		return nil, fmt.Errorf("TypeScript index version %d, want %d (rebuild tools/codemap)", ex.Version, tsExtractVersion)
	}
	return &ex, nil
}

// tsFilesUnder reports whether path is a frontend file the TypeScript half depends on.
func tsFilesUnder(path string) bool {
	switch filepath.Ext(path) {
	case ".ts", ".tsx":
		return true
	}
	base := filepath.Base(path)
	return strings.HasPrefix(base, "tsconfig") || base == "package.json"
}
