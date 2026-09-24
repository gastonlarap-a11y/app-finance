// Wrapper around the generated UpdatesService bindings (in-app updates from
// GitHub Releases). The Go struct is `updates.Service`, so the binding
// namespace is `Service`. Typed as the hand-written contract, so tsc proves
// the bindings match.
import { Events, Updater } from '@wailsio/runtime'
import { Service as Bound } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/updates'
import type { DownloadProgress, UpdatesServiceContract } from '@/services/contract'

export const UpdatesService: UpdatesServiceContract = Bound

// Emitted by the Go service after it records a check or download outcome
// (updates.EventStateChanged). Wails' own updater events fire before that, so
// re-reading the state on them could show a stale phase.
const EVENT_STATE_CHANGED = 'updates:changed'

// onUpdateStateChange calls back whenever the update state should be re-read
// (a check finished, a download became ready or failed). Returns the unsubscribe.
export function onUpdateStateChange(callback: () => void): () => void {
  return Events.On(EVENT_STATE_CHANGED, () => callback())
}

// onDownloadProgress streams byte counts while an update downloads (~10/s).
export function onDownloadProgress(callback: (p: DownloadProgress) => void): () => void {
  // The Go side emits updater.Progress, which serializes to DownloadProgress.
  return Events.On(Updater.Events.DownloadProgress, (ev) => callback(ev.data as DownloadProgress))
}

export type { DownloadProgress, ReleaseInfo, UpdatePhase, UpdateState, UpdateStateResult } from '@/services/contract'
