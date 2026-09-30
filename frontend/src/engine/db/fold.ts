// Port of backend/shared/db/fold.go: the SQL function text search compares
// with, `fold(x)` — x in lowercase without accents ("Café Ñuñoa" → "cafe nunoa"),
// since SQLite's LIKE folds ASCII letters only. Registered on every connection
// (wrapOo1Db), never used in the schema, so the file stays readable anywhere.

export const FOLD_SQL = 'fold'

// foldText decomposes the text (NFD), drops the combining marks and lowercases it.
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()
}
