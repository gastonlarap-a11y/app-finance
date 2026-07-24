// Web-only backup UI: on the PWA the database lives in the browser's OPFS, so
// the backup story is exporting/importing the SQLite file itself (the file is
// byte-compatible with the desktop app's database). Imported directly from
// '@/services/web/settings' (not the aliased wrapper) so the desktop typecheck
// also covers this file; the desktop bundle drops it via the IS_WEB constant.
import { useRef, useState } from 'react'
import { exportDb, importDb } from '@/services/web/settings'
import { backupFilename, shareOrDownload } from '@/lib/exportFile'
import { Button, Section } from './ui'

async function runExport(setBusy: (b: boolean) => void) {
  setBusy(true)
  try {
    await shareOrDownload(await exportDb(), backupFilename())
  } catch (err) {
    window.alert('No se pudo exportar: ' + (err instanceof Error ? err.message : String(err)))
  } finally {
    setBusy(false)
  }
}

// Compact header control (replaces the Drive BackupControl on web).
export function WebExportControl() {
  const [busy, setBusy] = useState(false)
  return (
    <Button variant="ghost" onClick={() => void runExport(setBusy)} disabled={busy}>
      {busy ? 'Exportando…' : '⬇ Exportar datos'}
    </Button>
  )
}

// Full settings tab for the web build.
export function WebSettingsView() {
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function onImportFile(file: File) {
    const ok = window.confirm(
      `Esto reemplazará TODOS los datos actuales de la app por los del archivo "${file.name}". ` +
        'Se recomienda exportar antes. ¿Continuar?',
    )
    if (!ok) return
    setImporting(true)
    try {
      await importDb(await file.arrayBuffer())
      window.location.reload()
    } catch (err) {
      window.alert('No se pudo importar: ' + (err instanceof Error ? err.message : String(err)))
      setImporting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Section title="Tus datos">
        <p className="text-sm text-slate-400">
          Tus finanzas se guardan únicamente en este dispositivo (almacenamiento local del
          navegador). Nadie más tiene acceso: no hay servidor ni cuenta.
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Para no perder nada si cambias de dispositivo o borras la app, exporta un respaldo cada
          cierto tiempo y guárdalo en Archivos, iCloud o donde prefieras.
        </p>
      </Section>

      <Section title="Respaldo">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void runExport(setBusy)} disabled={busy}>
            {busy ? 'Exportando…' : '⬇ Exportar datos'}
          </Button>
          <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? 'Importando…' : '⬆ Importar respaldo'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".sqlite,.sqlite3,.db"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void onImportFile(f)
            }}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          El archivo exportado es la base de datos completa (.sqlite) y también se puede abrir con
          la app de escritorio de macOS/Windows, y al revés.
        </p>
      </Section>
    </div>
  )
}
