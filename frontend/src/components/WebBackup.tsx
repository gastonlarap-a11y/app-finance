// Web-only backup UI: on the PWA the database lives in the browser's OPFS, so
// the backup story is exporting/importing the SQLite file itself (the file is
// byte-compatible with the desktop app's database). Imported directly from
// '@/services/web/settings' (not the aliased wrapper) so the desktop typecheck
// also covers this file; the desktop bundle drops it via the IS_WEB constant.
//
// No window.confirm/alert anywhere below, on purpose: Safari only shows native
// dialogs while a user activation is live, and the one that starts this flow is
// spent in the system file picker. A suppressed confirm() returns false, which
// used to abort the import without a single word on screen.
import { useRef, useState } from 'react'
import { Download, RotateCw, ShieldCheck, Upload } from 'lucide-react'
import { exportDb, importDb, inspectDb, type ImportSummary } from '@/services/web/settings'
import { SyncNoticeBox } from './SyncNoticeBox'
import { validateSqliteFile } from '@/engine/db/dbfile'
import { backupFilename, shareOrDownload } from '@/lib/exportFile'
import { useQuery } from '@/lib/useQuery'
import { Button, Callout, IconButton, Modal, Section } from './ui'

type ExportState =
  | { kind: 'idle' }
  | { kind: 'running' }
  // The file is ready but Safari refused the Share Sheet (the tap was spent
  // while the worker exported); the next tap shares this blob right away.
  | { kind: 'ready'; blob: Blob }
  | { kind: 'failed'; message: string }

type ImportState =
  | { kind: 'idle' }
  | { kind: 'inspecting' }
  // Checked and compared with the data here (summary.sync); waits for the user.
  | { kind: 'confirming'; file: File; bytes: Uint8Array; summary: ImportSummary }
  | { kind: 'running' }
  | { kind: 'done'; summary: ImportSummary }
  | { kind: 'failed'; message: string }

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// LAST_EXPORT_KEY remembers, per device, when a backup last left the app: the
// data lives only here, so "never" or "months ago" deserves a nudge.
const LAST_EXPORT_KEY = 'app-finance:last-export'

function lastExport(): Date | null {
  try {
    const v = localStorage.getItem(LAST_EXPORT_KEY)
    return v ? new Date(v) : null
  } catch {
    return null // storage blocked: the reminder is a convenience only
  }
}

function rememberExport(): void {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString())
  } catch {
    // storage blocked: the reminder is a convenience only
  }
}

async function handOff(blob: Blob, setState: (s: ExportState) => void) {
  const outcome = await shareOrDownload(blob, backupFilename())
  if (outcome === 'needs-tap') {
    setState({ kind: 'ready', blob })
    return
  }
  if (outcome !== 'canceled') rememberExport()
  setState({ kind: 'idle' })
}

async function runExport(state: ExportState, setState: (s: ExportState) => void) {
  try {
    if (state.kind === 'ready') {
      await handOff(state.blob, setState) // this tap is live: share at once
      return
    }
    setState({ kind: 'running' })
    await handOff(await exportDb(), setState)
  } catch (err) {
    setState({ kind: 'failed', message: message(err) })
  }
}

function exportLabel(state: ExportState): string {
  if (state.kind === 'running') return 'Exportando…'
  if (state.kind === 'ready') return 'Compartir respaldo'
  return 'Exportar datos'
}

// Sidebar control (replaces the Drive backup control on web); `compact` is the
// icon-only version for the narrow sidebar rail.
export function WebExportControl({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' })
  const run = () => void runExport(state, setState)
  const running = state.kind === 'running'
  return (
    <div className={compact ? 'flex flex-col items-center gap-1' : 'space-y-1 px-1'}>
      {compact ? (
        <IconButton label={exportLabel(state)} icon={Download} onClick={run} disabled={running} />
      ) : (
        <Button variant="secondary" size="sm" icon={Download} onClick={run} loading={running} className="w-full">
          {exportLabel(state)}
        </Button>
      )}
      {state.kind === 'failed' && (
        <p role="alert" className="text-xs text-negative-fg">
          No se pudo exportar: {state.message}
        </p>
      )}
    </div>
  )
}

// StorageStatus tells whether the browser promised to keep the data. WebKit
// grants persistence on its own heuristics (installing to the home screen is
// the documented signal) and may evict a plain tab's storage after 7 days
// without use, so the advice depends on it.
function StorageStatus() {
  const query = useQuery('storage-persisted', async () =>
    typeof navigator.storage?.persisted === 'function' ? navigator.storage.persisted() : false,
  )
  const last = lastExport()
  return (
    <div className="mt-3 space-y-2 text-sm text-fg-muted">
      {query.data === true && (
        <p className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-positive-fg" />
          El navegador guarda tus datos de forma persistente.
        </p>
      )}
      {query.data === false && (
        <Callout tone="caution">
          El navegador podría borrar tus datos si no usas la app por un tiempo. Instálala (Compartir →
          «Añadir a pantalla de inicio») y exporta respaldos seguido.
        </Callout>
      )}
      <p>
        {last
          ? `Último respaldo exportado desde este dispositivo: ${last.toLocaleDateString('es-CL')}.`
          : 'Aún no exportas un respaldo desde este dispositivo.'}
      </p>
    </div>
  )
}

function ImportResult({ summary }: { summary: ImportSummary }) {
  if (summary.users === 0 && summary.expenses === 0 && summary.incomes === 0) {
    return (
      <Callout tone="caution" className="mt-3">
        El archivo se abrió correctamente pero no tiene movimientos ni perfiles. ¿Seguro que es el
        respaldo que buscabas?
      </Callout>
    )
  }
  const range =
    summary.firstPeriod && summary.lastPeriod
      ? ` · datos de ${summary.firstPeriod} a ${summary.lastPeriod}`
      : ''
  return (
    <Callout tone="positive" role="status" className="mt-3">
      Importado: {summary.users} {summary.users === 1 ? 'perfil' : 'perfiles'}, {summary.expenses}{' '}
      {summary.expenses === 1 ? 'gasto' : 'gastos'} y {summary.incomes}{' '}
      {summary.incomes === 1 ? 'ingreso' : 'ingresos'}
      {range}. Recargando…
    </Callout>
  )
}

// Full settings tab for the web build.
export function WebSettingsView() {
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' })
  const [state, setState] = useState<ImportState>({ kind: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)

  // inspect reads and checks the picked file, then asks for confirmation with
  // what it holds and whether importing it would drop changes made here.
  async function inspect(file: File) {
    setState({ kind: 'inspecting' })
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const problem = validateSqliteFile(bytes)
      if (problem) {
        setState({ kind: 'failed', message: problem })
        return
      }
      setState({ kind: 'confirming', file, bytes, summary: await inspectDb(bytes) })
    } catch (err) {
      setState({ kind: 'failed', message: message(err) })
    }
  }

  async function runImport(bytes: Uint8Array) {
    setState({ kind: 'running' })
    try {
      const summary = await importDb(bytes)
      setState({ kind: 'done', summary })
      // Let the summary render before the reload wipes the page; the worker
      // still holds the handle of the database that was just replaced.
      setTimeout(() => window.location.reload(), 3000)
    } catch (err) {
      setState({ kind: 'failed', message: message(err) })
    }
  }

  const busy = state.kind === 'running' || state.kind === 'done' || state.kind === 'inspecting'

  return (
    <div className="space-y-5">
      <Section title="Tus datos">
        <p className="text-sm text-fg-muted">
          Tus finanzas se guardan únicamente en este dispositivo (almacenamiento local del
          navegador). Nadie más tiene acceso: no hay servidor ni cuenta.
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          Para no perder nada si cambias de dispositivo o borras la app, exporta un respaldo cada
          cierto tiempo y guárdalo en Archivos, iCloud o donde prefieras.
        </p>
        <StorageStatus />
      </Section>

      <Section title="Respaldo">
        <div className="flex flex-wrap items-center gap-3">
          <Button icon={Download} onClick={() => void runExport(exportState, setExportState)} loading={exportState.kind === 'running'}>
            {exportLabel(exportState)}
          </Button>
          <Button
            variant="secondary"
            icon={Upload}
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            loading={state.kind === 'running' || state.kind === 'inspecting'}
          >
            {state.kind === 'running' ? 'Importando…' : state.kind === 'inspecting' ? 'Revisando…' : 'Importar respaldo'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            // Sin accept: iPadOS filtra por UTI del sistema, y .db/.sqlite no
            // tienen uno — con accept el respaldo aparece en gris y no se puede
            // elegir. El archivo se valida por su contenido (validateSqliteFile).
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void inspect(f) // errors become the 'failed' state inside
            }}
          />
        </div>

        {exportState.kind === 'failed' && (
          <Callout tone="negative" role="alert" className="mt-3">
            No se pudo exportar: {exportState.message}
          </Callout>
        )}
        {exportState.kind === 'ready' && (
          <Callout tone="info" role="status" className="mt-3">
            El respaldo está listo: toca «Compartir respaldo» para guardarlo.
          </Callout>
        )}
        {state.kind === 'failed' && (
          <Callout
            tone="negative"
            role="alert"
            className="mt-3"
            action={
              <Button variant="secondary" size="sm" icon={RotateCw} onClick={() => window.location.reload()}>
                Recargar
              </Button>
            }
          >
            No se pudo importar: {state.message}
          </Callout>
        )}
        {state.kind === 'done' && <ImportResult summary={state.summary} />}

        <p className="mt-4 text-xs text-fg-subtle">
          El archivo exportado es la base de datos completa (.db) y también se puede abrir con la app
          de escritorio de macOS/Windows, y al revés.
        </p>
        <p className="mt-2 text-xs text-fg-subtle">
          Para restaurar en el iPad un respaldo que está en Google Drive: ábrelo en la app de Drive,
          toca ⋯ → «Abrir en» → «Guardar en Archivos», y luego elígelo aquí con «Importar respaldo».
          El respaldo de la app de escritorio se llama <code className="font-mono">app-finance.db</code>.
        </p>
      </Section>

      {state.kind === 'confirming' && (
        <Modal title="Reemplazar tus datos" onClose={() => setState({ kind: 'idle' })}>
          <p className="text-sm text-fg-muted">
            Se reemplazarán <strong className="text-fg">todos</strong> los datos actuales de la app por los del archivo
            «{state.file.name}»: {state.summary.users} {state.summary.users === 1 ? 'perfil' : 'perfiles'},{' '}
            {state.summary.expenses} {state.summary.expenses === 1 ? 'gasto' : 'gastos'} y {state.summary.incomes}{' '}
            {state.summary.incomes === 1 ? 'ingreso' : 'ingresos'}.
          </p>
          <SyncNoticeBox sync={state.summary.sync} />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setState({ kind: 'idle' })}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => void runImport(state.bytes)}>
              Reemplazar mis datos
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
