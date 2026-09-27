// Class recipes for data tables. Plain <table> markup keeps native semantics
// (headers, scope, screen-reader table navigation); the views' tables differ too
// much in structure for a shared component to pay off.
export const tbl = {
  // Wide tables scroll inside their card instead of the whole page.
  wrap: 'overflow-x-auto',
  table: 'w-full text-sm',
  thead: 'text-left text-xs font-medium uppercase tracking-wide text-fg-subtle',
  th: 'px-3 pb-2 font-medium first:pl-0 last:pr-0',
  row: 'border-t border-line',
  td: 'px-3 py-2.5 first:pl-0 last:pr-0',
  // Money and counts: right-aligned, tabular figures so digits line up.
  num: 'text-right tabular-nums whitespace-nowrap',
  foot: 'border-t border-line-strong font-semibold',
} as const
