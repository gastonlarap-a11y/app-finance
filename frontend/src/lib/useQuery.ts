import { useEffect, useEffectEvent, useState } from 'react'

// State of a keyed async load, as a discriminated union: `loading` keeps the
// previous key's data (if any) so views can dim stale content instead of
// flashing a spinner on every month change.
export type QueryState<T> =
  | { status: 'loading'; data: T | undefined }
  | { status: 'success'; data: T }
  | { status: 'error'; error: string; data: T | undefined }

type Settled<T> = { key: string } & ({ ok: true; data: T } | { ok: false; error: string })

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// useQuery runs `load` whenever `key` changes (encode every input — period,
// refresh counter… — into it). Responses for an outdated key are dropped, and a
// rejected promise becomes an `error` state instead of an unhandled rejection.
// `load` always sees the latest props (useEffectEvent), so it is not a dependency.
export function useQuery<T>(key: string, load: () => Promise<T>): QueryState<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const run = useEffectEvent(load)

  useEffect(() => {
    let active = true
    run().then(
      (data) => active && setSettled({ key, ok: true, data }),
      (err: unknown) => active && setSettled({ key, ok: false, error: errorText(err) }),
    )
    return () => {
      active = false
    }
  }, [key])

  const lastData = settled?.ok ? settled.data : undefined
  if (!settled || settled.key !== key) return { status: 'loading', data: lastData }
  if (!settled.ok) return { status: 'error', error: settled.error, data: undefined }
  return { status: 'success', data: settled.data }
}
