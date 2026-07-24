// Web-build stand-in for '@/services/settings' (aliased by vite --mode web).
// The desktop SettingsService surface (DB folder, Google Drive, backup-on-close)
// is native-only: those methods answer with a business error so any code path
// that still reaches them fails visibly instead of silently. The web-only
// backup story is export/import of the SQLite file (see exportDb/importDb).
import type { AppError } from '@/services/contract'
import { exportDbBytes, importDbBytes } from '@/services/web/worker-client'

export interface SettingsState {
  dbFolder: string
  driveConnected: boolean
  driveEmail: string
  driveFolderName: string
  clientIdConfigured: boolean
  backupOnClose: boolean
  lastBackup: string | null
  backupLocalDir: string
}

export interface StateResult {
  data?: SettingsState | null
  error?: AppError | null
}

export interface ChooseFolderResult {
  canceled?: boolean
  path?: string
  error?: AppError | null
}

export interface ApplyFolderResult {
  needsRestart?: boolean
  path?: string
  error?: AppError | null
}

export interface BackupInfo {
  uploaded: boolean
}

export interface BackupResult {
  data?: BackupInfo | null
  error?: AppError | null
}

export interface OpResult {
  error?: AppError | null
}

const WEB_ONLY: AppError = {
  code: 'VALIDATION_ERROR',
  message: 'No disponible en la versión web. Usa Exportar/Importar en Ajustes.',
}

export const SettingsService = {
  async GetState(): Promise<StateResult> {
    return {
      data: {
        dbFolder: 'Almacenamiento local del navegador (OPFS)',
        driveConnected: false,
        driveEmail: '',
        driveFolderName: '',
        clientIdConfigured: false,
        backupOnClose: false,
        lastBackup: null,
        backupLocalDir: '',
      },
    }
  },
  async ChooseDBFolder(): Promise<ChooseFolderResult> {
    return { canceled: true, error: WEB_ONLY }
  },
  async ApplyDBFolder(_path: string): Promise<ApplyFolderResult> {
    return { error: WEB_ONLY }
  },
  async ConnectDrive(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async DisconnectDrive(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async SetDriveFolderName(_name: string): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async SetOAuthClient(_id: string, _secret: string): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async SetBackupOnClose(_enabled: boolean): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async BackupNow(): Promise<BackupResult> {
    return { error: WEB_ONLY }
  },
}

// ---------- web-only backup surface ----------

// exportDb returns the SQLite file as a Blob ready for the Share Sheet or a
// download link. The file is byte-compatible with the desktop app's database.
export async function exportDb(): Promise<Blob> {
  const bytes = await exportDbBytes()
  // Copy into a plain ArrayBuffer so the Blob constructor accepts it regardless
  // of the buffer's origin (worker transfer may yield a SharedArrayBuffer-typed view).
  const copy = new Uint8Array(bytes)
  return new Blob([copy], { type: 'application/x-sqlite3' })
}

// importDb replaces the local database with the given file's contents. The
// caller must reload the page right after so every view refetches clean state.
export async function importDb(bytes: ArrayBuffer): Promise<void> {
  await importDbBytes(bytes)
}
