package archify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// InstallHint tells how to get the renderer.
const InstallHint = "instala Archify una vez con `npx skills add tt-a1i/archify -g` (o define ARCHIFY_BIN con la ruta de archify/bin/archify.mjs)"

// Supported Archify releases: the schema_version 1 architecture and sequence
// documents this package writes are those of 3.x from 3.1 on.
const (
	supportedMajor    = 3
	minSupportedMinor = 1
)

// ErrNotInstalled means no Archify CLI was found.
var ErrNotInstalled = errors.New("archify no está instalado")

// CLI is an installed Archify command line.
type CLI struct {
	Script  string // .../archify/bin/archify.mjs
	Version string
	Node    string
}

// FindCLI looks for archify.mjs in $ARCHIFY_BIN, then in the skill folders
// `npx skills add` writes (user, then project), and checks its version.
func FindCLI(root string, getenv func(string) string) (*CLI, error) {
	var candidates []string
	if bin := getenv("ARCHIFY_BIN"); bin != "" {
		candidates = append(candidates, bin)
	}
	if home := getenv("HOME"); home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".claude", "skills", "archify", "bin", "archify.mjs"),
			filepath.Join(home, ".agents", "skills", "archify", "bin", "archify.mjs"))
	}
	candidates = append(candidates,
		filepath.Join(root, ".claude", "skills", "archify", "bin", "archify.mjs"),
		filepath.Join(root, ".agents", "skills", "archify", "bin", "archify.mjs"))
	for _, script := range candidates {
		if _, err := os.Stat(script); err != nil {
			continue
		}
		version, err := readVersion(filepath.Join(filepath.Dir(script), "..", "package.json"))
		if err != nil {
			return nil, err
		}
		if err := checkVersion(version); err != nil {
			return nil, fmt.Errorf("%s: %w", script, err)
		}
		node, err := exec.LookPath("node")
		if err != nil {
			return nil, fmt.Errorf("archify needs Node.js: %w", err)
		}
		return &CLI{Script: script, Version: version, Node: node}, nil
	}
	return nil, ErrNotInstalled
}

func readVersion(packageJSON string) (string, error) {
	raw, err := os.ReadFile(packageJSON)
	if err != nil {
		return "", fmt.Errorf("reading archify version: %w", err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return "", fmt.Errorf("decoding %s: %w", packageJSON, err)
	}
	return pkg.Version, nil
}

// checkVersion accepts 3.1.x and later 3.x releases.
func checkVersion(v string) error {
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 2 {
		return fmt.Errorf("unrecognized archify version %q", v)
	}
	major, errMajor := strconv.Atoi(parts[0])
	minor, errMinor := strconv.Atoi(parts[1])
	if errMajor != nil || errMinor != nil {
		return fmt.Errorf("unrecognized archify version %q", v)
	}
	if major != supportedMajor || minor < minSupportedMinor {
		return fmt.Errorf("archify %s is not supported (need %d.%d or a later %d.x)", v, supportedMajor, minSupportedMinor, supportedMajor)
	}
	return nil
}

// Command is how far Archify goes: deliver validates and renders; finalize
// also checks the page in a real browser (Chrome/Chromium, ARCHIFY_CHROME).
type Command string

const (
	Deliver  Command = "deliver"
	Finalize Command = "finalize"
)

// Render runs Archify on candidate (a diagram JSON) to write html, verifying
// citations against root. Paths are relative to root, where Archify runs.
// The returned text is Archify's own report.
func (c *CLI) Render(ctx context.Context, cmd Command, diagramType, root, candidate, html string) (string, error) {
	args := []string{c.Script, string(cmd), diagramType, candidate, html, "--quality", "standard", "--json"}
	if _, err := os.Stat(filepath.Join(root, ".git")); err == nil {
		args = append(args, "--repo-root", root)
	}
	run := exec.CommandContext(ctx, c.Node, args...)
	run.Dir = root
	// No network from a code map: skip Archify's daily update check.
	run.Env = append(os.Environ(), "ARCHIFY_UPDATE_CHECK_DISABLED=1")
	var out, errOut bytes.Buffer
	run.Stdout, run.Stderr = &out, &errOut
	err := run.Run()
	report := strings.TrimSpace(out.String() + "\n" + errOut.String())
	if err != nil {
		return report, fmt.Errorf("archify %s failed: %w", cmd, err)
	}
	return report, nil
}
