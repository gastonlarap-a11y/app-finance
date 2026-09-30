package db

import (
	"database/sql/driver"
	"fmt"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
	"modernc.org/sqlite"
)

// FoldSQL is the SQL function text search compares with, `fold(x)`: x in
// lowercase without accents ("Café Ñuñoa" → "cafe nunoa"), since SQLite's LIKE
// folds ASCII letters only. It lives on the connection, never in the schema
// (no index or view uses it), so the file stays readable by any SQLite. The web
// engine registers the same function (frontend/src/engine/db/sqlite.ts).
const FoldSQL = "fold"

// Fold lowercases s and strips its accents: decomposed (NFD), without the
// combining marks.
func Fold(s string) (string, error) {
	// A chain keeps state between calls: one per call.
	strip := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)))
	out, _, err := transform.String(strip, s)
	if err != nil {
		return "", fmt.Errorf("folding %q: %w", s, err)
	}
	return strings.ToLower(out), nil
}

var registerFold = sync.OnceValue(func() error {
	return sqlite.RegisterDeterministicScalarFunction(FoldSQL, 1,
		func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			switch v := args[0].(type) {
			case nil:
				return nil, nil
			case string:
				return Fold(v)
			case []byte:
				return Fold(string(v))
			default:
				return v, nil // a number has no case or accents
			}
		})
})
