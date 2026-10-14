package archify

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gastonlarap-a11y/app-finance/tools/codemap/internal/graph"
)

// Repo is what Archify needs to verify citations: the pinned commit, where it
// links to, and which files differ from that commit (citing those would fail,
// because Archify reads committed blobs, not the working tree).
type Repo struct {
	Meta  *Repository // nil outside a Git checkout with an origin remote
	Dirty map[string]bool
}

// ReadRepo inspects the Git checkout at root. A directory that is not a Git
// checkout, or has no origin, yields a Repo without Meta: diagrams then carry
// no citations, which Archify accepts.
func ReadRepo(ctx context.Context, root string) (Repo, error) {
	repo := Repo{Dirty: map[string]bool{}}
	// Not the top of a Git checkout, or no origin: Archify cannot pin
	// citations (they are relative to root, and Archify resolves them from the
	// checkout's top), so the diagrams simply carry none — not an error.
	top, topErr := git(ctx, root, "rev-parse", "--show-toplevel")
	rev, revErr := git(ctx, root, "rev-parse", "HEAD")
	origin, originErr := git(ctx, root, "remote", "get-url", "origin")
	if topErr != nil || revErr != nil || originErr != nil || !sameDir(top, root) {
		return repo, nil
	}
	// -z: raw NUL-separated "XY path" entries (no quoting, and the leading
	// status column is significant, so the output must not be trimmed).
	status, err := gitRaw(ctx, root, "status", "--porcelain", "-z", "--untracked-files=all")
	if err != nil {
		return repo, fmt.Errorf("git status: %w", err)
	}
	entries := strings.Split(status, "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		repo.Dirty[entry[3:]] = true
		if entry[0] == 'R' || entry[0] == 'C' {
			i++ // the next entry is the rename's or copy's source path
		}
	}
	url, provider := canonicalRemote(origin)
	linkMode := "web"
	remoteBranches, err := git(ctx, root, "branch", "-r", "--contains", rev)
	if err != nil || remoteBranches == "" || provider == "" {
		// Links to a commit the host has never seen would 404.
		linkMode = "local-only"
	}
	repo.Meta = &Repository{URL: url, Provider: provider, LinkMode: linkMode, Revision: rev}
	return repo, nil
}

var (
	sshRemote   = regexp.MustCompile(`^git@([^:]+):(.+?)(?:\.git)?$`)
	httpsRemote = regexp.MustCompile(`^https://(?:[^@/]+@)?([^/]+)/(.+?)(?:\.git)?/?$`)
	providers   = map[string]string{"github.com": "github", "gitee.com": "gitee", "gitlab.com": "gitlab"}
)

// canonicalRemote turns an origin into the credential-free HTTPS address
// Archify links to, with its provider ("" for a host Archify cannot link).
func canonicalRemote(origin string) (url, provider string) {
	var host, path string
	if m := sshRemote.FindStringSubmatch(origin); m != nil {
		host, path = m[1], m[2]
	} else if m := httpsRemote.FindStringSubmatch(origin); m != nil {
		host, path = m[1], m[2]
	} else {
		return origin, ""
	}
	return "https://" + host + "/" + path, providers[host]
}

// Cite returns up to three citations of positions, skipping files that are
// not committed as they are (and every position when there is no repository).
func (r Repo) Cite(positions ...graph.Pos) []Source {
	if r.Meta == nil {
		return nil
	}
	var out []Source
	seen := map[graph.Pos]bool{}
	for _, p := range positions {
		if p.IsZero() || r.Dirty[p.File] || seen[p] || len(out) == 3 {
			continue
		}
		seen[p] = true
		s := Source{Path: p.File, Line: p.Line}
		if p.EndLine > p.Line {
			s.EndLine = p.EndLine
		}
		out = append(out, s)
	}
	return out
}

// pinned returns the repository metadata only when at least one citation uses
// it: Archify rejects a pinned repository with no sources.
func (r Repo) pinned(cited bool) *Repository {
	if !cited {
		return nil
	}
	return r.Meta
}

// sameDir compares two directories after resolving symlinks (macOS /tmp is /private/tmp).
func sameDir(a, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}

// git runs a Git command in dir and returns its trimmed output.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := gitRaw(ctx, dir, args...)
	return strings.TrimSpace(out), err
}

// gitRaw returns the output exactly as Git wrote it.
func gitRaw(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errOut.String()))
	}
	return out.String(), nil
}
