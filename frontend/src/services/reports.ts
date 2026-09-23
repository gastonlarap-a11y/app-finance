// Desktop export: the Go ReportsService renders the .xlsx and asks where to save
// it with the native dialog (a blob download is unreliable inside the webview).
// The web build aliases this module to services/web/reports.ts (CSV + Share Sheet).
import { ReportsService } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/reports'
import type { ExportTable } from '@/services/contract'

export type ExportOutcome = { status: 'saved'; where: string } | { status: 'canceled' }

// saveTable exports `table` as `<basename>.xlsx`. Business errors (bad table)
// are thrown so callers surface them like any failed call.
export async function saveTable(table: ExportTable, basename: string): Promise<ExportOutcome> {
  const res = await ReportsService.SaveTable(table, `${basename}.xlsx`)
  if (res.error) throw new Error(res.error.message)
  if (res.canceled || !res.path) return { status: 'canceled' }
  return { status: 'saved', where: res.path }
}
