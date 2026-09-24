// Web-build stand-in for '@/services/mailsync' (aliased by vite --mode web).
// Reading bank alerts needs an IMAP connection, which a browser cannot open,
// so the web build reports "not configured" and rejects every action; its
// views hide the feature (IS_WEB) and import statements from PDFs instead.
import type { AppError, MailStateResult, MailSyncServiceContract, OpResult, SyncEvent } from '@/services/contract'

export type { MailAccountInput, MailState, MailStateResult, SyncEvent, SyncSummary } from '@/services/contract'

const WEB_ONLY: AppError = {
  code: 'VALIDATION_ERROR',
  message: 'La lectura del correo sólo está disponible en la app de escritorio.',
}

export const MailSyncService: MailSyncServiceContract = {
  async GetMailState(): Promise<MailStateResult> {
    return {
      data: {
        configured: false,
        host: '',
        port: 0,
        username: '',
        folder: '',
        senderFilter: '',
        startDate: '',
        autoSync: false,
        syncing: false,
        lastSyncedAt: null,
        lastError: '',
        lastMessages: 0,
        lastRecognized: 0,
        lastAdded: 0,
        issuers: [],
      },
    }
  },
  async SaveMailAccount(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async TestMailConnection(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async SyncNow(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async ResyncMailFrom(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
  async DisconnectMail(): Promise<OpResult> {
    return { error: WEB_ONLY }
  },
}

// No syncs ever happen on the web build.
export function onMailSyncDone(_callback: (ev: SyncEvent) => void): () => void {
  return () => {}
}
