// Web-build stand-in for '@/services/reports': no Go backend, so the table is
// written as CSV and handed to the Share Sheet (Save to Files, AirDrop…) — or a
// download link in a regular browser tab.
import type { ExportTable } from '@/services/contract'
import { toCsv } from '@/lib/exportTables'
import { shareOrDownload } from '@/lib/exportFile'

export type ExportOutcome = { status: 'saved'; where: string } | { status: 'canceled' }

export async function saveTable(table: ExportTable, basename: string): Promise<ExportOutcome> {
  const filename = `${basename}.csv`
  const blob = new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' })
  await shareOrDownload(blob, filename)
  return { status: 'saved', where: filename }
}
