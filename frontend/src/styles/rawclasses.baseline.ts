// Raw palette / legacy token classes each file may still use while the views
// migrate to the semantic tokens (see rawclasses.ts). A ratchet: counts only go
// down — rawclasses.test.ts fails on a new raw class, and asks to lower the
// number here when a file improves. The migration is done when this is empty.
export const RAW_CLASS_BASELINE: Readonly<Record<string, number>> = {
  '../components/Accounts.tsx': 7,
  '../components/CardStatements.tsx': 27,
  '../components/CardsView.tsx': 6,
  '../components/CategoriesView.tsx': 7,
  '../components/CsvImport.tsx': 9,
  '../components/ErrorBoundary.tsx': 5,
  '../components/FixedExpensesView.tsx': 12,
  '../components/ForecastView.tsx': 28,
  '../components/ImportInboxView.tsx': 38,
  '../components/MailSettings.tsx': 11,
  '../components/MerchantsView.tsx': 5,
  '../components/RecurringSuggestions.tsx': 5,
  '../components/RestoreBackup.tsx': 16,
  '../components/SavingsView.tsx': 19,
  '../components/SearchView.tsx': 13,
  '../components/SettingsView.tsx': 17,
  '../components/StatementImport.tsx': 9,
  '../components/SyncNoticeBox.tsx': 9,
  '../components/TagsSection.tsx': 5,
  '../components/TrashView.tsx': 12,
  '../components/UpdateNotice.tsx': 13,
  '../components/WebBackup.tsx': 16,
  '../components/WebUpdateBanner.tsx': 2,
  '../components/YearView.tsx': 22,
  '../main.tsx': 5,
}
