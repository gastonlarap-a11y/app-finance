// Checks run on a user-picked file before it reaches OPFS. sqlite-wasm already
// rejects malformed input, but only with English library messages thrown from a
// worker — on an iPad there is no console to read them, so validate here and
// speak Spanish. Pure byte math: no OPFS, no worker, testable under vitest.

// https://sqlite.org/fileformat.html#the_database_header
const HEADER = 'SQLite format 3\0'
const PAGE_ALIGNMENT = 512

// validateSqliteFile mirrors the two guards inside sqlite-wasm's SAHPool
// importDb (size and header) so the user gets a sentence instead of a stack
// trace. Returns null when the file is usable.
export function validateSqliteFile(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) {
    return 'El archivo está vacío. Si lo bajaste de Drive, asegúrate de que terminó de descargarse antes de elegirlo.'
  }
  // Header first: it tells apart "you picked the wrong file" (the common
  // mistake) from "the right file arrived truncated".
  for (let i = 0; i < HEADER.length; i++) {
    if (bytes[i] !== HEADER.charCodeAt(i)) {
      return 'Ese archivo no es una base de datos de App Finance. Elige el respaldo «app-finance.db» (o el .db que exportaste desde la app).'
    }
  }
  if (bytes.byteLength < PAGE_ALIGNMENT || bytes.byteLength % PAGE_ALIGNMENT !== 0) {
    return 'El archivo está incompleto o dañado: no tiene el tamaño de una base de datos SQLite.'
  }
  return null
}
