// Geometry helpers that turn the loose text runs a PDF yields into table rows.
// PDF text extraction returns runs in content-stream order, which for bank
// statements is often column by column (every date, then every amount…), so
// rows must be rebuilt from coordinates, never from reading order.

// TextRun is one positioned piece of text, in PDF user space: x grows to the
// right, y grows upwards (the page's bottom-left corner is the origin).
export interface TextRun {
  page: number // 1-based
  str: string
  x: number // left edge
  y: number // baseline
  width: number
}

export interface Row {
  page: number
  y: number
  runs: TextRun[] // left to right
}

// Runs whose baselines differ by at most this many points share a row.
const ROW_TOLERANCE = 2.5

// groupRows buckets non-blank runs into visual rows, top of the page first and
// pages in order; runs inside a row are sorted left to right.
export function groupRows(runs: readonly TextRun[], tolerance = ROW_TOLERANCE): Row[] {
  const sorted = runs
    .filter((r) => r.str.trim() !== '')
    .toSorted((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const rows: Row[] = []
  for (const run of sorted) {
    const last = rows.at(-1)
    if (last && last.page === run.page && Math.abs(last.y - run.y) <= tolerance) {
      last.runs.push(run)
    } else {
      rows.push({ page: run.page, y: run.y, runs: [run] })
    }
  }
  for (const row of rows) row.runs.sort((a, b) => a.x - b.x)
  return rows
}

// rowText joins a row's runs with single spaces (for matching labels).
export function rowText(row: Row): string {
  return row.runs
    .map((r) => r.str.trim())
    .filter(Boolean)
    .join(' ')
}

export function center(run: TextRun): number {
  return run.x + run.width / 2
}

// Anchor is a column header's horizontal center.
export interface Anchor<K extends string> {
  key: K
  x: number
}

// nearestAnchor picks the column whose header center is closest to the run's
// center. It suits cells that sit under their header (codes, right-aligned
// amounts) — not wide left-aligned text, which callers identify by content.
export function nearestAnchor<K extends string>(run: TextRun, anchors: ReadonlyArray<Anchor<K>>): K | null {
  let best: Anchor<K> | null = null
  for (const a of anchors) {
    if (!best || Math.abs(center(run) - a.x) < Math.abs(center(run) - best.x)) best = a
  }
  return best?.key ?? null
}
