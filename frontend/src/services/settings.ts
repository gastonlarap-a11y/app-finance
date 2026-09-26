// Wrapper around the generated SettingsService bindings (DB folder, Google Drive,
// backups). The Go struct is `settings.Service`, so the binding namespace is `Service`.
//
// Typed as the hand-written contract (same scheme as services/finance.ts): the
// generated models type time.Time as `any`, and tsc proves the bindings match.
import { Service as Bound } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/settings'
import type { SettingsServiceContract } from '@/services/contract'

export const SettingsService: SettingsServiceContract = Bound

export type {
  ApplyFolderResult,
  BackupFile,
  BackupInfo,
  BackupResult,
  BackupSummary,
  ChooseFolderResult,
  OpResult,
  SettingsState,
  StateResult,
} from '@/services/contract'
