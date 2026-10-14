// Package archify turns codemap's graph into Archify diagrams
// (github.com/tt-a1i/archify, schema_version 1 of the architecture and
// sequence types) and renders them with the user's installed Archify CLI.
//
// The JSON is deterministic — positions, labels and source citations come
// from the graph, never from a model — and Archify validates it (including
// that every cited file and line exists at the pinned commit) before it
// writes the self-contained HTML viewer.
package archify

import (
	"regexp"
	"strconv"
	"strings"
)

// Diagram types this package writes.
const (
	TypeArchitecture = "architecture"
	TypeSequence     = "sequence"
)

// Meta is the shared meta block.
type Meta struct {
	Title          string      `json:"title"`
	Subtitle       string      `json:"subtitle,omitempty"`
	Output         string      `json:"output"`
	Locale         string      `json:"locale,omitempty"`
	QualityProfile string      `json:"quality_profile,omitempty"`
	Repository     *Repository `json:"repository,omitempty"`
	ViewBox        []float64   `json:"viewBox,omitempty"`
	ColumnFit      string      `json:"column_fit,omitempty"`
}

// Repository pins the commit every source citation is checked against.
type Repository struct {
	URL      string `json:"url"`
	Provider string `json:"provider,omitempty"`
	LinkMode string `json:"link_mode,omitempty"`
	Revision string `json:"revision"`
}

// Source cites a file (and optionally lines) at the pinned revision.
type Source struct {
	Path    string `json:"path"`
	Line    int    `json:"line,omitempty"`
	EndLine int    `json:"end_line,omitempty"`
	Label   string `json:"label,omitempty"`
}

// Card is a titled list shown beside the diagram.
type Card struct {
	Dot   string   `json:"dot"`
	Title string   `json:"title"`
	Items []string `json:"items"`
}

// ArchitectureDiagram is an Archify architecture diagram.
type ArchitectureDiagram struct {
	SchemaVersion int          `json:"schema_version"`
	DiagramType   string       `json:"diagram_type"`
	Meta          Meta         `json:"meta"`
	Components    []Component  `json:"components"`
	Boundaries    []Boundary   `json:"boundaries,omitempty"`
	Connections   []Connection `json:"connections,omitempty"`
	Cards         []Card       `json:"cards,omitempty"`
}

// Component is one box.
type Component struct {
	ID       string     `json:"id"`
	Type     string     `json:"type"` // frontend | backend | database | …
	Label    string     `json:"label"`
	Sublabel string     `json:"sublabel,omitempty"`
	Tag      string     `json:"tag,omitempty"`
	Sources  []Source   `json:"sources,omitempty"`
	Pos      [2]float64 `json:"pos"`
	Size     [2]float64 `json:"size"`
}

// Boundary groups components (a build, a process).
type Boundary struct {
	Kind  string   `json:"kind"` // region | security-group
	Label string   `json:"label"`
	Wraps []string `json:"wraps"`
}

// Connection is an arrow between two components.
type Connection struct {
	ID       string      `json:"id,omitempty"`
	From     string      `json:"from"`
	To       string      `json:"to"`
	Label    string      `json:"label,omitempty"`
	Variant  string      `json:"variant,omitempty"`
	FromSide string      `json:"fromSide,omitempty"`
	ToSide   string      `json:"toSide,omitempty"`
	LabelAt  *[2]float64 `json:"labelAt,omitempty"`
}

// SequenceDiagram is an Archify sequence diagram.
type SequenceDiagram struct {
	SchemaVersion int           `json:"schema_version"`
	DiagramType   string        `json:"diagram_type"`
	Meta          Meta          `json:"meta"`
	Participants  []Participant `json:"participants"`
	Segments      []Segment     `json:"segments,omitempty"`
	Messages      []Message     `json:"messages"`
	Cards         []Card        `json:"cards,omitempty"`
}

// Participant is one lifeline.
type Participant struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	Label    string   `json:"label"`
	Sublabel string   `json:"sublabel,omitempty"`
	Sources  []Source `json:"sources,omitempty"`
}

// Segment labels a vertical band of messages.
type Segment struct {
	From  float64 `json:"from"`
	To    float64 `json:"to"`
	Label string  `json:"label"`
}

// Message is one arrow at height Y.
type Message struct {
	ID      string  `json:"id,omitempty"`
	From    string  `json:"from"`
	To      string  `json:"to"`
	Y       float64 `json:"y"`
	Label   string  `json:"label"`
	Variant string  `json:"variant,omitempty"`
}

// ---------- shared helpers ----------

var nonIDChars = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

// ids hands out Archify IDs (^[a-zA-Z][a-zA-Z0-9_-]*$), unique per diagram.
type ids map[string]bool

func (seen ids) next(name string) string {
	id := strings.Trim(nonIDChars.ReplaceAllString(name, "-"), "-")
	if id == "" || !isLetter(id[0]) {
		id = "n-" + id
	}
	base := id
	for i := 2; seen[id]; i++ {
		id = base + "-" + strconv.Itoa(i)
	}
	seen[id] = true
	return id
}

func isLetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// clip shortens a label to n runes.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// count is "1 tabla" / "3 tablas".
func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// lastPart is the name after the last dot: "finance.FinanceService.CreateExpense" → "CreateExpense".
func lastPart(name string) string { return name[strings.LastIndexByte(name, '.')+1:] }
