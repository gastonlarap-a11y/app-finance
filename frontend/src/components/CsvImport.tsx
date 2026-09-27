import { useState } from 'react'
import { FinanceService, type StageSummary } from '@/services/finance'
import { buildBatch, guessMapping, type AmountLayout, type CsvMapping } from '@/lib/statements/csv'
import { formatCLP, formatDate } from '@/lib/format'
import { Button, Callout, Field, Modal, Select, inputCls } from './ui'

// Remembered between imports (per device): the bank name last typed. A
// convenience only: storage may be unavailable (private mode) and that is fine.
const ISSUER_KEY = 'csv-import-issuer'

function loadIssuer(): string {
  try {
    return localStorage.getItem(ISSUER_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveIssuer(issuer: string): void {
  try {
    localStorage.setItem(ISSUER_KEY, issuer)
  } catch {
    // Not persisted: the user types the bank again next time.
  }
}

type LayoutKind = AmountLayout['kind']

const LAYOUTS: { kind: LayoutKind; label: string }[] = [
  { kind: 'split', label: 'Cargos y abonos en columnas separadas' },
  { kind: 'signed', label: 'Una columna: negativo = cargo' },
  { kind: 'charges', label: 'Una columna de cargos (tarjeta): negativo = abono' },
]

// CsvImportDialog maps the columns of a bank's CSV export and stages its
// movements in the inbox (they are confirmed there like any other source).
export function CsvImportDialog({
  fileName,
  rows,
  onClose,
  onImported,
}: {
  fileName: string
  rows: string[][]
  onClose: () => void
  onImported: (summary: StageSummary, skipped: number) => void
}) {
  const guess = guessMapping(rows)
  const [issuer, setIssuer] = useState(loadIssuer)
  const [headerRow, setHeaderRow] = useState(guess?.headerRow ?? 0)
  const [date, setDate] = useState(guess?.date ?? 0)
  const [description, setDescription] = useState(guess?.description ?? 1)
  const [layout, setLayout] = useState<LayoutKind>(guess?.amount.kind ?? 'signed')
  const [amountCol, setAmountCol] = useState(guess?.amount.kind === 'split' ? 2 : (guess?.amount.column ?? 2))
  const [chargeCol, setChargeCol] = useState(guess?.amount.kind === 'split' ? guess.amount.charge : 2)
  const [creditCol, setCreditCol] = useState(guess?.amount.kind === 'split' ? guess.amount.credit : 3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const header = rows[headerRow] ?? []
  const width = Math.max(...rows.map((r) => r.length))
  const columns = Array.from({ length: width }, (_, i) => ({ i, label: header[i] || `Columna ${i + 1}` }))
  const amount: AmountLayout =
    layout === 'split' ? { kind: 'split', charge: chargeCol, credit: creditCol } : { kind: layout, column: amountCol }
  const mapping: CsvMapping = { headerRow, date, description, amount }
  const { batch, skipped } = buildBatch(rows, mapping, issuer)

  async function submit() {
    if (issuer.trim() === '') {
      setError('Indica de qué banco es la cartola.')
      return
    }
    setBusy(true)
    try {
      const res = await FinanceService.StageImport(batch)
      if (res.error || !res.data) {
        setError(res.error?.message ?? 'No se pudo importar.')
        return
      }
      saveIssuer(issuer.trim())
      onImported(res.data, skipped)
    } finally {
      setBusy(false)
    }
  }

  const columnSelect = (value: number, set: (n: number) => void, label: string) => (
    <Field label={label}>
      <Select value={String(value)} onChange={(e) => set(Number(e.target.value))}>
        {columns.map((c) => (
          <option key={c.i} value={String(c.i)}>
            {c.label}
          </option>
        ))}
      </Select>
    </Field>
  )

  return (
    <Modal title={`Importar ${fileName}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          Indica qué columna es cada dato. Los movimientos llegan a la bandeja para que los confirmes; reimportar el mismo
          archivo no los duplica.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Banco">
            <input className={inputCls} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Banco de Chile" required />
          </Field>
          <Field label="Fila de encabezados">
            <Select value={String(headerRow)} onChange={(e) => setHeaderRow(Number(e.target.value))}>
              {rows.slice(0, 20).map((r, i) => (
                <option key={i} value={String(i)}>
                  {`${i + 1}: ${r.filter(Boolean).slice(0, 3).join(' · ')}`.slice(0, 60)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Montos">
            <Select value={layout} onChange={(e) => setLayout(LAYOUTS.find((l) => l.kind === e.target.value)?.kind ?? 'signed')}>
              {LAYOUTS.map((l) => (
                <option key={l.kind} value={l.kind}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          {columnSelect(date, setDate, 'Fecha')}
          {columnSelect(description, setDescription, 'Descripción')}
          {layout === 'split' ? (
            <div className="grid grid-cols-2 gap-2">
              {columnSelect(chargeCol, setChargeCol, 'Cargos')}
              {columnSelect(creditCol, setCreditCol, 'Abonos')}
            </div>
          ) : (
            columnSelect(amountCol, setAmountCol, 'Monto')
          )}
        </div>

        <div className="rounded-lg bg-sunken p-3 text-sm ring-1 ring-inset ring-line">
          <p className="mb-2 text-fg">
            {batch.items.length} movimientos
            {skipped > 0 && <span className="text-fg-subtle"> · {skipped} filas omitidas (títulos, totales o saldos)</span>}
          </p>
          {batch.items.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {batch.items.slice(0, 5).map((it, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1 pr-3 text-fg-muted">{formatDate(it.date)}</td>
                    <td className="py-1 text-fg">{it.description}</td>
                    <td className={`py-1 text-right tabular-nums ${it.kind === 'abono' ? 'text-positive-fg' : 'text-fg'}`}>
                      {it.kind === 'abono' ? '+' : '−'}
                      {formatCLP(it.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {error && (
          <Callout tone="negative" role="alert">
            {error}
          </Callout>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={batch.items.length === 0}>
            {`Enviar ${batch.items.length} a la bandeja`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
