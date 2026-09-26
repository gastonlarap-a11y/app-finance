import { useId, useRef, useState } from 'react'
import { FinanceService, type CardStatementImport, type StageSummary } from '@/services/finance'
import type { DetectedStatement } from '@/lib/statements/detect'
import { errorText } from '@/lib/useQuery'
import { Button } from './ui'
import { CsvImportDialog } from './CsvImport'

// Outcome of one "Importar PDF" run, shown until dismissed or replaced.
type Outcome =
  | { kind: 'done'; file: string; format: string; results: string[]; notes: string[]; warnings: string[] }
  | { kind: 'error'; file: string; message: string }

// readStatement loads pdf.js and the parsers on demand (they are large and only
// needed here) and recognizes the document.
async function readStatement(data: ArrayBuffer): Promise<DetectedStatement> {
  const [{ extractRuns }, { parseStatement }] = await Promise.all([
    import('@/lib/statements/pdfText'),
    import('@/lib/statements/detect'),
  ])
  return parseStatement(await extractRuns(data))
}

// fileHash fingerprints the PDF (SHA-256, hex) so a statement records which
// file it came from; '' where Web Crypto is unavailable (insecure context).
async function fileHash(data: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return ''
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function stagedText(s: StageSummary, reconciledWith: string): string {
  return (
    `${plural(s.added, 'movimiento nuevo', 'movimientos nuevos')} por revisar` +
    (s.duplicates > 0 ? `, ${plural(s.duplicates, 'ya estaba', 'ya estaban')}` : '') +
    (s.reconciled > 0 ? `, ${plural(s.reconciled, 'conciliado', 'conciliados')} con ${reconciledWith}` : '')
  )
}

function cardStatementText(label: string, r: CardStatementImport): string {
  if (r.alreadyImported) return `${label}: ya estaba importado.`
  return (
    `${label}: ${stagedText(r, 'otras fuentes')}` +
    (r.linkedInstallments > 0 ? `, ${plural(r.linkedInstallments, 'cuota enlazada', 'cuotas enlazadas')} a gastos que ya tenías` : '') +
    (r.paymentsMatched > 0 ? `, ${plural(r.paymentsMatched, 'pago conciliado', 'pagos conciliados')} con la cartola` : '') +
    '.'
  )
}

// importParsed sends what was read to the backend: a cartola's movements to
// the inbox, each card statement whole. Returns one line per result, or the
// first business error.
async function importParsed(parsed: DetectedStatement, data: ArrayBuffer): Promise<{ results: string[] } | { error: string }> {
  if (parsed.kind === 'batch') {
    const res = await FinanceService.StageImport(parsed.batch)
    if (res.error || !res.data) return { error: res.error?.message ?? 'No se pudo importar.' }
    return { results: [`${parsed.format}: ${stagedText(res.data, 'alertas de correo')}.`] }
  }
  const hash = await fileHash(data)
  const results: string[] = []
  for (const st of parsed.statements) {
    const res = await FinanceService.ImportCardStatement({ ...st, fileHash: hash })
    const label = `Estado ${st.kind} ••${st.cardLastDigits}`
    if (res.error || !res.data) return { error: `${label}: ${res.error?.message ?? 'no se pudo importar.'}` }
    results.push(cardStatementText(label, res.data))
  }
  return { results }
}

// isCsv tells a CSV export (any bank, columns mapped by the user) from a PDF.
function isCsv(file: File): boolean {
  return file.type === 'text/csv' || /\.(csv|txt)$/i.test(file.name)
}

// StatementImport reads a bank statement (a PDF we have a parser for, or a
// CSV export of any bank) and stages its movements in the inbox, then reports
// exactly what happened: what was added, what was already there, what was
// skipped on purpose and any check that failed.
export function StatementImport({ onImported }: { onImported: () => void }) {
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [csv, setCsv] = useState<{ file: string; rows: string[][] } | null>(null)

  async function openCsv(file: File) {
    const { decodeText, parseCsv } = await import('@/lib/statements/csv')
    const rows = parseCsv(decodeText(new Uint8Array(await file.arrayBuffer())))
    if (rows.length < 2) {
      setOutcome({ kind: 'error', file: file.name, message: 'El archivo no tiene filas que leer.' })
      return
    }
    setCsv({ file: file.name, rows })
  }

  async function importFile(file: File) {
    setBusy(true)
    try {
      if (isCsv(file)) {
        await openCsv(file)
        return
      }
      const data = await file.arrayBuffer()
      // pdf.js may transfer (detach) the buffer it reads: hand it a copy.
      const parsed = await readStatement(data.slice(0))
      const res = await importParsed(parsed, data)
      if ('error' in res) {
        setOutcome({ kind: 'error', file: file.name, message: res.error })
        return
      }
      setOutcome({ kind: 'done', file: file.name, format: parsed.format, results: res.results, notes: parsed.notes, warnings: parsed.warnings })
      onImported()
    } catch (err) {
      setOutcome({ kind: 'error', file: file.name, message: errorText(err) })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = '' // allow picking the same file again
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          id={inputId}
          type="file"
          accept="application/pdf,.pdf,text/csv,.csv"
          className="sr-only"
          // Opened by the button below: keep it out of the tab order and the a11y tree.
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importFile(file) // errors are caught inside importFile
          }}
        />
        <Button onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Leyendo archivo…' : 'Importar cartola (PDF o CSV)'}
        </Button>
        <span className="text-xs text-slate-500">
          PDF: cartola o estado de cuenta de tarjeta Itaú. CSV: la cartola exportada por cualquier banco (eliges qué columna
          es cada dato). Reimportar el mismo archivo no duplica movimientos.
        </span>
      </div>

      {csv && (
        <CsvImportDialog
          fileName={csv.file}
          rows={csv.rows}
          onClose={() => setCsv(null)}
          onImported={(summary, skipped) => {
            setCsv(null)
            setOutcome({
              kind: 'done',
              file: csv.file,
              format: 'CSV',
              results: [`CSV: ${stagedText(summary, 'alertas de correo')}.`],
              notes: skipped > 0 ? [`${skipped} filas omitidas (títulos, totales o saldos).`] : [],
              warnings: [],
            })
            onImported()
          }}
        />
      )}

      {outcome && (
        <div
          role="status"
          className={`rounded-base p-3 text-sm ring-1 ${outcome.kind === 'error' ? 'bg-danger/10 ring-danger/40' : 'bg-surface ring-slate-800'}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="font-medium">{outcome.file}</div>
              {outcome.kind === 'error' ? (
                <p className="text-red-200">{outcome.message}</p>
              ) : (
                <>
                  {outcome.results.map((r) => (
                    <p key={r} className="text-slate-300">
                      {r}
                    </p>
                  ))}
                  {outcome.warnings.map((w) => (
                    <p key={w} className="text-amber-200">
                      ⚠ {w}
                    </p>
                  ))}
                  {outcome.notes.map((n) => (
                    <p key={n} className="text-xs text-slate-500">
                      {n}
                    </p>
                  ))}
                </>
              )}
            </div>
            <Button variant="ghost" onClick={() => setOutcome(null)}>
              Cerrar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
