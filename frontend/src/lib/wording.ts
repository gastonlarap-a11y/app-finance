// Spanish wording for results the UI reports, kept pure so it is tested apart
// from the screens that show it.
import { periodLabel } from './format'

type Span = { startPeriod: string; endPeriod: string }
type CatalogCounts = { categories: number; merchants: number; rules: number }

// transferSpan says when a transfer moves money: once, every month, or a range.
export function transferSpan(t: Span): string {
  if (t.endPeriod === t.startPeriod) return `una vez, ${periodLabel(t.startPeriod)}`
  if (t.endPeriod === '') return `cada mes desde ${periodLabel(t.startPeriod)}`
  return `cada mes, de ${periodLabel(t.startPeriod)} a ${periodLabel(t.endPeriod)}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// catalogMessage says what applying the suggested catalog added.
export function catalogMessage(s: CatalogCounts): string {
  const parts = [
    s.categories > 0 && plural(s.categories, 'categoría', 'categorías'),
    s.merchants > 0 && plural(s.merchants, 'comercio', 'comercios'),
    s.rules > 0 && plural(s.rules, 'regla de importación', 'reglas de importación'),
  ].filter((p): p is string => typeof p === 'string')
  if (parts.length === 0) return 'Ya tienes todo el catálogo sugerido.'
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0]
  return `Se agregaron ${list}.`
}
