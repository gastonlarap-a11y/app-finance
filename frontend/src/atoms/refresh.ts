import { atom, useAtomValue, useSetAtom } from 'jotai'

// Selective refetch, the model of TanStack Query's invalidateQueries: every
// query folds the versions of the topics it reads into its useQuery key, and a
// mutation bumps only the topics it changed — so saving an expense refetches
// the finance views but not the backup state, the profile list or the mail
// status mounted in the header.
//
// Topics are coarse on purpose: nearly every finance read (summaries, trend,
// forecast, search, budgets, the inbox's duplicate hints) derives from the
// whole ledger, and a missed invalidation shows stale money. Finer topics
// would trade a few cheap refetches for that risk.
export type Topic =
  | 'ledger' // expenses, cuotas, incomes, fixed expenses, cards, categories, merchants, savings, trash
  | 'imports' // import inbox, card statements, import rules
  | 'profiles' // the profile list (switching profile invalidates everything)
  | 'settings' // DB folder, Google Drive, backups
  | 'mail' // mailbox configuration and sync status

export const ALL_TOPICS: readonly Topic[] = ['ledger', 'imports', 'profiles', 'settings', 'mail']

export type Versions = Readonly<Record<Topic, number>>

const initialVersions: Versions = { ledger: 0, imports: 0, profiles: 0, settings: 0, mail: 0 }

const versionsAtom = atom<Versions>(initialVersions)

// versionKey is the useQuery key fragment for `topics`: it changes only when
// one of them is invalidated.
export function versionKey(versions: Versions, topics: readonly Topic[]): string {
  return topics.map((t) => `${t}${versions[t]}`).join('.')
}

// bumped returns versions with each of `topics` (every topic when empty) moved on.
export function bumped(versions: Versions, topics: readonly Topic[]): Versions {
  const next = { ...versions }
  for (const t of topics.length === 0 ? ALL_TOPICS : topics) next[t] += 1
  return next
}

// useVersion returns the key fragment of the topics a query reads.
export function useVersion(...topics: Topic[]): string {
  return versionKey(useAtomValue(versionsAtom), topics)
}

// useInvalidate returns a function that refetches every mounted query reading
// any of the given topics; called with none, it invalidates everything.
export function useInvalidate(): (...topics: Topic[]) => void {
  const set = useSetAtom(versionsAtom)
  return (...topics) => set((v) => bumped(v, topics))
}
