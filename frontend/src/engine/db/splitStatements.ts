// Replicates bun/migrate's SQL file parsing (newSQLMigrationFunc): statements
// are separated by lines that are exactly `--bun:split`; any other `--bun:`
// directive is an error. Sharing the parser is what lets the web engine run the
// exact .sql files embedded by the Go backend.

const PREFIX = '--bun:'

export function splitStatements(content: string): string[] {
  const queries: string[] = []
  let query = ''
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(PREFIX)) {
      const directive = line.slice(PREFIX.length)
      if (directive === 'split') {
        queries.push(query)
        query = ''
        continue
      }
      throw new Error(`unknown bun directive: ${directive}`)
    }
    query += line + '\n'
  }
  if (query.length > 0) {
    queries.push(query)
  }
  return queries.filter((q) => q.trim() !== '')
}
