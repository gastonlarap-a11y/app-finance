import { atom } from 'jotai'
import { currentPeriod } from '@/lib/format'
import type { User } from '@/services/users'

export type Tab = 'mes' | 'anio' | 'fijos' | 'tarjetas' | 'categorias' | 'papelera' | 'ajustes'

export const tabAtom = atom<Tab>('mes')
export const periodAtom = atom<string>(currentPeriod())

// Bumping this forces data-loading components to refetch after a mutation.
export const refreshAtom = atom(0)

// The active finance profile (shown in the header; null until loaded).
export const activeUserAtom = atom<User | null>(null)
