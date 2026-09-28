import { SettingsService } from '@/services/settings'
import { notify } from '@/lib/notify'

// requestBackup runs a desktop "back up now" (to Drive when connected, else a
// local copy) and reports the outcome as a toast. Callers refresh 'settings'.
export async function requestBackup(): Promise<void> {
  try {
    const res = await SettingsService.BackupNow()
    if (res.error) {
      notify('Respaldo: ' + res.error.message)
    } else if (res.data) {
      notify(
        res.data.uploaded
          ? 'Respaldo subido a Google Drive.'
          : 'Respaldo local creado. Conecta Google Drive en Configuración › Respaldo para subirlo.',
        'success',
      )
    }
  } catch (err) {
    notify('Respaldo: ' + (err instanceof Error ? err.message : String(err)))
  }
}
