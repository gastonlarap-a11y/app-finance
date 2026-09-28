import { lazy, Suspense, useState } from 'react'
import { CloudOff, CloudUpload, FolderOpen } from 'lucide-react'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { SettingsService } from '@/services/settings'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { Button, Callout, ConfirmAction, Field, QueryError, Section, SkeletonRows, Switch, inputCls } from './ui'
import { RestoreBackup } from './RestoreBackup'

// On the web build the whole desktop surface (DB folder, Google Drive) is
// native-only; the backup section becomes the export/import view instead.
// Loaded lazily behind the compile-time IS_WEB flag so the desktop bundle never
// pulls in the web engine (worker + sqlite-wasm).
// import.meta.env.VITE_TARGET is inlined by `define` at transform time, so the
// bundler sees a literal condition and drops the import() on desktop.
const WebSettingsView =
  import.meta.env.VITE_TARGET === 'web'
    ? lazy(() => import('./WebBackup').then((m) => ({ default: m.WebSettingsView })))
    : null

// BackupSettings is Configuración › Respaldo (y Google Drive on desktop).
export function BackupSettings() {
  if (WebSettingsView) {
    return (
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <WebSettingsView />
      </Suspense>
    )
  }
  return <DesktopBackupSettings />
}

function DesktopBackupSettings() {
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [backingUp, setBackingUp] = useState(false)

  const version = useVersion('settings')
  const invalidate = useInvalidate()
  const reload = () => invalidate('settings')

  const query = useQuery(version, async () => {
    const res = await SettingsService.GetState()
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'configuración no disponible')
    return res.data
  })

  if (query.status === 'error') return <QueryError message={query.error} onRetry={reload} />
  const state = query.data
  if (!state) return <SkeletonRows rows={5} />
  const folderName = folderDraft ?? state.driveFolderName

  async function changeDBFolder() {
    const chosen = await SettingsService.ChooseDBFolder()
    if (failed(chosen) || chosen.canceled || !chosen.path) return
    const res = await SettingsService.ApplyDBFolder(chosen.path)
    if (failed(res)) return
    notify(
      res.needsRestart
        ? `Carpeta guardada: ${res.path}. Reinicia la app para usar la nueva ubicación.`
        : `La base de datos ya estaba en: ${res.path}`,
      'success',
    )
    reload()
  }

  async function connectDrive() {
    setConnecting(true)
    try {
      const res = await SettingsService.ConnectDrive()
      if (failed(res)) return
      notify('Conectado a Google Drive.', 'success')
      reload()
    } finally {
      setConnecting(false)
    }
  }

  async function disconnectDrive() {
    const res = await SettingsService.DisconnectDrive()
    if (!failed(res)) reload()
  }

  async function saveFolderName() {
    const res = await SettingsService.SetDriveFolderName(folderName)
    if (!failed(res)) {
      setFolderDraft(null)
      reload()
    }
  }

  async function saveClient() {
    const res = await SettingsService.SetOAuthClient(clientId, clientSecret)
    if (!failed(res)) {
      setClientId('')
      setClientSecret('')
      reload()
    }
  }

  async function toggleOnClose(enabled: boolean) {
    const res = await SettingsService.SetBackupOnClose(enabled)
    if (!failed(res)) reload()
  }

  async function backupNow() {
    setBackingUp(true)
    try {
      const res = await SettingsService.BackupNow()
      if (res.error) {
        notify('Error en respaldo: ' + res.error.message)
      } else if (res.data) {
        notify(res.data.uploaded ? 'Respaldo subido a Google Drive.' : 'Respaldo local creado.', 'success')
      }
      reload()
    } finally {
      setBackingUp(false)
    }
  }

  const lastBackup = state.lastBackup
    ? new Date(state.lastBackup).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
    : 'nunca'

  return (
    <div className="space-y-5">
      <Section title="Respaldo">
        <div className="space-y-4">
          <Switch
            label="Respaldar automáticamente al cerrar la app"
            description={state.driveConnected ? 'Se sube a tu Google Drive y queda una copia local.' : 'Queda una copia local; conecta Drive para subirla.'}
            checked={state.backupOnClose}
            onChange={(on) => void toggleOnClose(on)}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-fg-subtle">
              Último respaldo: <span className="text-fg-muted">{lastBackup}</span> · Copia local en <code className="font-mono">{state.backupLocalDir}</code>
            </p>
            <Button icon={CloudUpload} onClick={() => void backupNow()} loading={backingUp}>
              Respaldar ahora
            </Button>
          </div>
        </div>
        <div className="mt-6 border-t border-line pt-5">
          <RestoreBackup driveConnected={state.driveConnected} />
        </div>
      </Section>

      <Section title="Google Drive">
        <p className="mb-4 text-sm text-fg-muted">
          Inicia sesión con tu cuenta de Google para respaldar tus datos. Tus finanzas se guardan solo en tu PC y en tu propio Drive.
        </p>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-fg">
            <span aria-hidden="true" className={`inline-block size-2.5 rounded-full ${state.driveConnected ? 'bg-positive-fg' : 'bg-line-strong'}`} />
            {state.driveConnected ? (state.driveEmail ? `Conectado como ${state.driveEmail}` : 'Conectado') : 'Sin conectar'}
          </div>
          {state.driveConnected ? (
            <ConfirmAction label="Desconectar" icon={CloudOff} question="¿Desconectar Google Drive?" confirmLabel="Desconectar" onConfirm={disconnectDrive} />
          ) : (
            <Button onClick={() => void connectDrive()} loading={connecting} disabled={!state.clientIdConfigured}>
              {connecting ? 'Conectando… (revisa tu navegador)' : 'Conectar con Google Drive'}
            </Button>
          )}
        </div>

        {state.driveConnected && !state.clientIdConfigured && (
          <Callout tone="caution" role="alert" className="mt-4">
            Tu sesión de Google sigue guardada, pero esta copia de la app no trae la credencial de Google necesaria para renovarla,
            así que los respaldos a Drive fallarán. Actualiza a la próxima versión o pega la credencial en «Opciones avanzadas» y
            vuelve a conectar.
          </Callout>
        )}

        {state.driveConnected && (
          <div className="mt-4">
            <Field label="Carpeta en Drive para los respaldos">
              <div className="flex gap-2">
                <input className={inputCls} value={folderName} onChange={(e) => setFolderDraft(e.target.value)} />
                <Button variant="secondary" onClick={() => void saveFolderName()} disabled={folderName === state.driveFolderName}>
                  Guardar
                </Button>
              </div>
            </Field>
          </div>
        )}

        {!state.clientIdConfigured && (
          <details className="mt-4 rounded-lg bg-sunken p-4 ring-1 ring-inset ring-line">
            <summary className="cursor-pointer text-sm font-medium text-fg-muted hover:text-fg">Opciones avanzadas</summary>
            <p className="mb-3 mt-3 text-sm text-fg-muted">
              Esta copia de la app no trae credencial de Google incorporada. Pega un <b className="text-fg">Client ID</b> de Google
              (tipo "app de escritorio") una vez:
            </p>
            <div className="space-y-2">
              <input className={inputCls} aria-label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" />
              <input
                className={inputCls}
                type="password"
                autoComplete="off"
                aria-label="Client Secret"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client Secret"
              />
              <Button onClick={() => void saveClient()} disabled={!clientId}>
                Guardar credencial
              </Button>
            </div>
          </details>
        )}
      </Section>

      <Section title="Base de datos">
        <p className="mb-2 text-sm text-fg-muted">Carpeta donde se guarda tu base de datos:</p>
        <div className="flex flex-wrap items-center gap-3">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-sunken px-3 py-2 font-mono text-sm text-fg ring-1 ring-inset ring-line">
            {state.dbFolder}
          </code>
          <Button variant="secondary" icon={FolderOpen} onClick={() => void changeDBFolder()}>
            Cambiar carpeta
          </Button>
        </div>
      </Section>
    </div>
  )
}
