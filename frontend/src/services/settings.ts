// Wrapper around the generated SettingsService bindings (DB folder, Google Drive,
// backups). The Go struct is `settings.Service`, so the binding namespace is `Service`.
export {
  Service as SettingsService,
  State as SettingsState,
  StateResult,
  ApplyFolderResult,
  ChooseFolderResult,
  BackupResult,
  OpResult,
} from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/settings'

export { Info as BackupInfo } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/shared/backup'
