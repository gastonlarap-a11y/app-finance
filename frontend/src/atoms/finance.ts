import { atom } from 'jotai'
import { currentPeriod } from '@/lib/format'

export type Tab = 'mes' | 'anio' | 'fijos' | 'tarjetas' | 'categorias' | 'ajustes'

export const tabAtom = atom<Tab>('mes')
export const periodAtom = atom<string>(currentPeriod())

// Bumping this forces data-loading components to refetch after a mutation.
export const refreshAtom = atom(0)
