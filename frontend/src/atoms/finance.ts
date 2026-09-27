import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { currentPeriod } from '@/lib/format'

// UI state only (server data stays in useQuery). The current screen is not
// here: it lives in the URL hash (lib/route.ts, lib/useRoute.ts).

export const periodAtom = atom<string>(currentPeriod())

// The global "new expense" dialog (QuickAddHost): opened from any screen by
// the header button, the N key or the command palette.
export const quickAddAtom = atom(false)

// Wide screens: the sidebar shows as a narrow icon rail when collapsed.
// Per device, remembered across launches.
export const sidebarCollapsedAtom = atomWithStorage('app-finance:sidebar-collapsed', false, undefined, { getOnInit: true })
