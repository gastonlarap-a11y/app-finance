import { useId, useRef, useState } from 'react'
import { FinanceService, type StageSummary } from '@/services/finance'
import { errorText } from '@/lib/useQuery'
import { Button } from './ui'

// Outcome of one "Importar PDF" run, shown until dismissed or replaced.
type Outcome =
  | { kind: 'done'; file: string; format: string; summary: StageSummary; notes: string[]; warnings: string[] }
  | { kind: 'error'; file: string; message: string }

// readStatement loads pdf.js and the parsers on demand (they are large and only
// needed here) and turns the file into a batch ready for StageImport.
async function readStatement(file: File) {
  const [{ extractRuns }, { parseStatement }] = await Promise.all([
    import('@/lib/statements/pdfText'),
    import('@/lib/statements/detect'),
  ])
  return parseStatement(await extractRuns(await file.arrayBuffer()))
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// StatementImport reads a bank statement PDF and stages its movements in the
// inbox, then reports exactly what happened: what was added, what was already
// there, what was skipped on purpose and any check that failed.
export function StatementImport({ onImported }: { onImported: () => void }) {
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function importFile(file: File) {
    setBusy(true)
    try {
      const parsed = await readStatement(file)
      const res = await FinanceService.StageImport(parsed.batch)
      if (res.error || !res.data) {
        setOutcome({ kind: 'error', file: file.name, message: res.error?.message ?? 'No se pudo importar.' })
        return
      }
      setOutcome({ kind: 'done', file: file.name, format: parsed.format, summary: res.data, notes: parsed.notes, warnings: parsed.warnings })
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
          accept="application/pdf,.pdf"
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
          {busy ? 'Leyendo PDF…' : 'Importar estado de cuenta (PDF)'}
        </Button>
        <span className="text-xs text-slate-500">Cartola de cuenta corriente Itaú. Reimportar el mismo PDF no duplica movimientos.</span>
      </div>

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
                  <p className="text-slate-300">
                    {outcome.format}: {plural(outcome.summary.added, 'movimiento nuevo', 'movimientos nuevos')} por revisar
                    {outcome.summary.duplicates > 0 && <>, {plural(outcome.summary.duplicates, 'ya estaba', 'ya estaban')}</>}
                    {outcome.summary.reconciled > 0 && <>, {plural(outcome.summary.reconciled, 'conciliado', 'conciliados')} con alertas de correo</>}.
                  </p>
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
