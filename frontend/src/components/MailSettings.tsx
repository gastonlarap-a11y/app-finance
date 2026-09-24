import { useState, type SubmitEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { refreshAtom } from '@/atoms/finance'
import { MailSyncService, type MailState } from '@/services/mailsync'
import type { OpResult } from '@/services/contract'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { useQuery } from '@/lib/useQuery'
import { Button, Field, QueryError, Section, Spinner, inputCls } from './ui'

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// syncStatusText summarizes the last sync for humans ("Revisado el … · 12
// correos del banco · 10 leídos · 3 nuevos").
export function syncStatusText(st: MailState): string {
  if (!st.lastSyncedAt) return 'Aún no se ha revisado.'
  const when = new Date(st.lastSyncedAt).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })
  return `Revisado el ${when} · ${st.lastMessages} correos del banco · ${st.lastRecognized} leídos · ${st.lastAdded} movimientos nuevos`
}

// MailSettings configures the IMAP mailbox the bank alerts are read from
// (desktop only). The password is sent once and kept in the OS keychain.
export function MailSettings() {
  const refresh = useAtomValue(refreshAtom)
  const bump = useSetAtom(refreshAtom)
  const reload = () => bump((n) => n + 1)
  const query = useQuery(String(refresh), async () => {
    const res = await MailSyncService.GetMailState()
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'estado del correo no disponible')
    return res.data
  })

  return (
    <Section title="Correo de alertas del banco">
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={reload} />
      ) : !query.data ? (
        <Spinner />
      ) : (
        // Keyed by the saved values so the form re-initializes after a save.
        <MailForm key={`${query.data.username}|${query.data.host}|${query.data.startDate}`} state={query.data} onChanged={reload} />
      )}
    </Section>
  )
}

function MailForm({ state, onChanged }: { state: MailState; onChanged: () => void }) {
  const [host, setHost] = useState(state.configured ? state.host : 'imap.gmail.com')
  const [port, setPort] = useState(String(state.configured ? state.port : 993))
  const [username, setUsername] = useState(state.username)
  const [password, setPassword] = useState('')
  const [folder, setFolder] = useState(state.configured ? state.folder : 'INBOX')
  const [senderFilter, setSenderFilter] = useState(state.configured ? state.senderFilter : 'itau.cl')
  const [startDate, setStartDate] = useState(state.configured ? state.startDate : isoDaysAgo(30))
  const [autoSync, setAutoSync] = useState(state.configured ? state.autoSync : true)
  const [busy, setBusy] = useState<'save' | 'test' | 'sync' | 'disconnect' | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  // run performs one action with its pending state; true when it succeeded.
  async function run(kind: NonNullable<typeof busy>, op: () => Promise<OpResult>, ok: string): Promise<boolean> {
    setBusy(kind)
    try {
      if (failed(await op())) return false
      notify(ok, 'success')
      onChanged()
      return true
    } finally {
      setBusy(null)
    }
  }

  function save(e: SubmitEvent) {
    e.preventDefault()
    void run(
      'save',
      () =>
        MailSyncService.SaveMailAccount({
          host,
          port: Number(port) || 0,
          username,
          password,
          folder,
          senderFilter,
          startDate,
          autoSync,
        }),
      '✓ Correo guardado',
    ).then((saved) => {
      if (saved) setPassword('') // stored in the keychain: do not keep it in the form
    })
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-sm text-slate-400">
        La app lee las alertas de compra que tu banco te envía por correo y las deja en <strong>Importar</strong> para
        revisarlas. Sólo busca correos del remitente indicado y desde la última revisión; nunca los marca como leídos.
      </p>
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <Field label="Servidor IMAP">
          <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} required />
        </Field>
        <Field label="Puerto">
          <input className={inputCls} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <Field label="Correo (usuario)">
        <input className={inputCls} type="email" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </Field>
      <Field label="Contraseña de aplicación">
        <input
          className={inputCls}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={state.configured ? 'Guardada en el llavero · escribe otra para cambiarla' : ''}
          required={!state.configured}
          aria-describedby="mail-password-help"
        />
        <p id="mail-password-help" className="mt-1 text-xs text-slate-500">
          En Gmail usa una contraseña de aplicación (Cuenta de Google → Seguridad → Verificación en 2 pasos →
          Contraseñas de aplicaciones), no tu clave normal. Se guarda en el llavero del sistema, no en la app.
        </p>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Remitente del banco">
          <input className={inputCls} value={senderFilter} onChange={(e) => setSenderFilter(e.target.value)} required placeholder="itau.cl" />
        </Field>
        <Field label="Carpeta">
          <input className={inputCls} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="INBOX" />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-slate-500">
        Si un filtro archiva las alertas, usa la carpeta «[Gmail]/Todos» (o «[Gmail]/All Mail»).
      </p>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field label="Revisar desde">
          <input className={inputCls} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </Field>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} className="h-4 w-4" />
          Revisar solo cada 15 min mientras la app está abierta
        </label>
      </div>

      {state.configured && (
        <div className="space-y-1 rounded bg-surface p-3 text-xs ring-1 ring-slate-800">
          <p className="text-slate-400">{syncStatusText(state)}</p>
          {state.lastError && <p className="text-red-300">Último error: {state.lastError}</p>}
          {state.issuers.length === 0 && (
            <p className="text-amber-200">
              Aún no hay un lector para el formato de alertas de ningún banco: los correos encontrados se informan como
              «no reconocidos» hasta que se agregue.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {state.configured && (
          <>
            {confirmDisconnect ? (
              <>
                <span className="self-center text-sm text-danger">¿Quitar el correo?</span>
                <Button
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void run('disconnect', () => MailSyncService.DisconnectMail(), 'Correo desconectado')}
                >
                  Sí, quitar
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                  No
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                Desconectar
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run('test', () => MailSyncService.TestMailConnection(), '✓ Conexión correcta')}
            >
              {busy === 'test' ? 'Probando…' : 'Probar conexión'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy !== null || state.syncing}
              onClick={() => void run('sync', () => MailSyncService.SyncNow(), 'Revisando el correo…')}
            >
              {state.syncing ? 'Revisando…' : 'Revisar ahora'}
            </Button>
          </>
        )}
        <Button type="submit" disabled={busy !== null}>
          {busy === 'save' ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </form>
  )
}
