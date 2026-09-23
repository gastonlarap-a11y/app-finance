// Wrapper around the generated UsersService bindings (finance profiles). Switching
// user only changes the active id on the backend; the SQLite connection is shared,
// so the UI just refetches (bump refreshAtom) after a switch.
//
// Typed as the hand-written contract so tsc proves the generated bindings still
// match it (same scheme as services/finance.ts).
import { UsersService as Bound } from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/users'
import type { UsersServiceContract } from '@/services/contract'

export const UsersService: UsersServiceContract = Bound

export type { User, UserResult } from '@/services/contract'
