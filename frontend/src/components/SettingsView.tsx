import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { refreshAtom } from '@/atoms/finance'
import { lazy, Suspense } from 'react'
import { SettingsService, type SettingsState } from '@/services/settings'
import { failed } from '@/lib/result'
import { Button, Field, Section, Spinner, inputCls } from './ui'

// On the web build the whole desktop surface (DB folder, Google Drive) is
// native-only; settings become the export/import backup view instead. Loaded
// lazily behind the compile-time IS_WEB flag so the desktop bundle never pulls
// in the web engine (worker + sqlite-wasm).
// import.meta.env.VITE_TARGET is inlined by `define` at transform time, so the
// bundler sees a literal condition and drops the import() on desktop.
const WebSettingsView =
  import.meta.env.VITE_TARGET === 'web'
    ? lazy(() => import('./WebBackup').then((m) => ({ default: m.WebSettingsView })))
    : null

export function SettingsView() {
  if (WebSettingsView) {
    return (
      <Suspense fallback={<Spinner />}>
        <WebSettingsView />
      </Suspense>
    )
  }
  return <DesktopSettingsView />
}

function DesktopSettingsView() {
  const [state, setState] = useState<SettingsState | null>(null)
  const [folderName, setFolderName] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = useCallback(() => bump((n) => n + 1), [bump])

  function showNotice(type: 'success' | 'error', msg: string) {
    setNotice({ type, msg })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 4000)
  }

  const load = useCallback(() => {
    SettingsService.GetState().then((r) => {
      setState(r.data ?? null)
      if (r.data) setFolderName(r.data.driveFolderName)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, refresh])

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  if (!state) return <Spinner />

  async function changeDBFolder() {
    const chosen = await SettingsService.ChooseDBFolder()
    if (failed(chosen) || chosen.canceled || !chosen.path) return
    const res = await SettingsService.ApplyDBFolder(chosen.path)
    if (failed(res)) return
    showNotice(
      'success',
      res.needsRestart
        ? `✓ Carpeta guardada: ${res.path} — Reinicia la app para usar la nueva ubicación.`
        : `La base de datos ya estaba en: ${res.path}`,
    )
    reload()
  }

  async function connectDrive() {
    setConnecting(true)
    try {
      const res = await SettingsService.ConnectDrive()
      if (failed(res)) return
      showNotice('success', '✓ Conectado a Google Drive')
      reload()
    } finally {
      setConnecting(false)
    }
  }

  async function disconnectDrive() {
    const res = await SettingsService.DisconnectDrive()
    if (!failed(res)) {
      setConfirmDisconnect(false)
      reload()
    }
  }

  async function saveFolderName() {
    const res = await SettingsService.SetDriveFolderName(folderName)
    if (!failed(res)) reload()
  }

  async function saveClient() {
    const res = await SettingsService.SetOAuthClient(clientId, clientSecret)
    if (!failed(res)) {
      setClientId('')
      setClientSecret('')
      reload()
    }
  }

  async function toggleOnClose() {
    const res = await SettingsService.SetBackupOnClose(!state!.backupOnClose)
    if (!failed(res)) reload()
  }

  async function backupNow() {
    setBackingUp(true)
    try {
      const res = await SettingsService.BackupNow()
      if (res.error) {
        showNotice('error', 'Error en respaldo: ' + res.error.message)
      } else if (res.data) {
        showNotice('success', res.data.uploaded ? '✓ Respaldo subido a Google Drive' : '✓ Respaldo local creado')
      }
      reload()
    } finally {
      setBackingUp(false)
    }
  }

  const lastBackup = state.lastBackup
    ? new Date(String(state.lastBackup)).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
    : 'nunca'

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Section title="Base de datos">
        <p className="mb-2 text-sm text-slate-400">Carpeta donde se guarda tu base de datos:</p>
        <div className="flex items-center gap-3">
          <code className="flex-1 truncate rounded bg-surface px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-800">
            {state.dbFolder}
          </code>
          <Button variant="ghost" onClick={changeDBFolder}>
            Cambiar carpeta
          </Button>
        </div>
      </Section>

      <Section title="Google Drive">
        <p className="mb-3 text-sm text-slate-400">
          Inicia sesión con tu cuenta de Google para respaldar tus datos. Tus finanzas se guardan solo
          en tu PC y en tu propio Drive.
        </p>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${state.driveConnected ? 'bg-success' : 'bg-slate-500'}`} />
            <span className="text-sm">
              {state.driveConnected
                ? state.driveEmail
                  ? `Conectado como ${state.driveEmail}`
                  : 'Conectado'
                : 'Sin conectar'}
            </span>
          </div>
          {state.driveConnected ? (
            confirmDisconnect ? (
              <span className="flex items-center gap-2">
                <span className="text-sm text-slate-300">¿Desconectar?</span>
                <Button variant="danger" onClick={disconnectDrive}>Sí</Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>No</Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                Desconectar
              </Button>
            )
          ) : (
            <Button onClick={connectDrive} disabled={connecting || !state.clientIdConfigured}>
              {connecting ? 'Conectando… (revisa tu navegador)' : 'Conectar con Google Drive'}
            </Button>
          )}
        </div>

        {state.driveConnected && (
          <div className="mt-4">
            <Field label="Carpeta en Drive para los respaldos">
              <div className="flex gap-2">
                <input className={inputCls} value={folderName} onChange={(e) => setFolderName(e.target.value)} />
                <Button variant="ghost" onClick={saveFolderName} disabled={folderName === state.driveFolderName}>
                  Guardar
                </Button>
              </div>
            </Field>
          </div>
        )}

        {!state.clientIdConfigured && (
          <details className="mt-4 rounded-base bg-surface p-4 ring-1 ring-slate-800">
            <summary className="cursor-pointer text-sm text-slate-400">Opciones avanzadas</summary>
            <p className="mb-3 mt-3 text-sm text-slate-300">
              Esta copia de la app no trae credencial de Google incorporada. Pega un <b>Client ID</b> de
              Google (tipo "app de escritorio") una vez:
            </p>
            <div className="space-y-2">
              <input className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" />
              <input className={inputCls} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client Secret" />
              <Button onClick={saveClient} disabled={!clientId}>
                Guardar credencial
              </Button>
            </div>
          </details>
        )}
      </Section>

      <Section title="Respaldo">
        <div className="space-y-3">
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={state.backupOnClose} onChange={toggleOnClose} className="h-4 w-4" />
            Respaldar automáticamente al cerrar la app
          </label>
          <div className="text-xs text-slate-500">
            Último respaldo: {lastBackup} · Copia local en <code>{state.backupLocalDir}</code>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={backupNow} disabled={backingUp}>
              {backingUp ? 'Respaldando…' : '☁ Respaldar ahora'}
            </Button>
            {notice && (
              <p className={`text-sm ${notice.type === 'success' ? 'text-success' : 'text-danger'}`}>
                {notice.msg}
              </p>
            )}
          </div>
        </div>
      </Section>
    </div>
  )
}
