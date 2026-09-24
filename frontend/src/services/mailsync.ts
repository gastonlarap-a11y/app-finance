// Wrapper around the generated MailSyncService bindings (bank alert emails over
// IMAP). The Go struct is `mailsync.Service`, so the binding namespace is
// `Service`. Typed as the hand-written contract, so tsc proves the bindings match.
import { Events } from '@wailsio/runtime'
import { Service as Bound } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/mailsync'
import type { MailSyncServiceContract, SyncEvent } from '@/services/contract'

export const MailSyncService: MailSyncServiceContract = Bound

// Name of the event the backend emits after every sync (mailsync.EventSyncDone).
const EVENT_SYNC_DONE = 'mailsync:done'

// onMailSyncDone subscribes to sync outcomes; returns the unsubscribe function.
export function onMailSyncDone(callback: (ev: SyncEvent) => void): () => void {
  // The Go side always emits a mailsync.SyncEvent, which serializes to SyncEvent.
  return Events.On(EVENT_SYNC_DONE, (ev) => callback(ev.data as SyncEvent))
}

export type { MailAccountInput, MailState, MailStateResult, SyncEvent, SyncSummary } from '@/services/contract'
