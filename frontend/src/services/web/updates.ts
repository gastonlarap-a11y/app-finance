// Web-build stand-in for '@/services/updates' (aliased by vite --mode web).
// The PWA updates itself through its service worker, so there is nothing to
// check or install here: the state is always "up to date".
import type {
  AppError,
  DownloadProgress,
  OpResult,
  UpdateStateResult,
  UpdatesServiceContract,
} from '@/services/contract'

export type { DownloadProgress, ReleaseInfo, UpdatePhase, UpdateState, UpdateStateResult } from '@/services/contract'

const WEB_ONLY: AppError = {
  code: 'VALIDATION_ERROR',
  message: 'La versión web se actualiza sola al abrirla.',
}

export const UpdatesService: UpdatesServiceContract = {
  async GetUpdateState(): Promise<UpdateStateResult> {
    return { data: { currentVersion: '', phase: 'idle', available: null, lastChecked: null, lastError: '', blocked: '' } }
  },
  async CheckForUpdate(): Promise<UpdateStateResult> {
    return { error: WEB_ONLY }
  },
  async InstallUpdate(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async RestartToUpdate(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
}

export function onUpdateStateChange(_callback: () => void): () => void {
  return () => {}
}

export function onDownloadProgress(_callback: (p: DownloadProgress) => void): () => void {
  return () => {}
}
