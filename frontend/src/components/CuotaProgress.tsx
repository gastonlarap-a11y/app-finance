import type { Movimiento } from '@/services/contract'
import { formatCLP } from '@/lib/format'

// CuotaProgress says where a plan stands in the month shown: what its cuotas
// billed up to this month add up to and what is left. Nothing for one-payment
// expenses, fixed charges and refunds.
export function CuotaProgress({ m }: { m: Movimiento }) {
  if (m.soFar === null || m.remaining === null) return null
  return (
    <span className="block text-[11px] text-fg-subtle">
      Cuota {m.number} de {m.total} · llevas <span className="tabular-nums">{formatCLP(m.soFar)}</span>
      {m.remainingCount > 0 ? (
        <>
          {' '}
          · faltan <span className="tabular-nums">{formatCLP(m.remaining)}</span> ({m.remainingCount}{' '}
          {m.remainingCount === 1 ? 'cuota' : 'cuotas'})
        </>
      ) : (
        ' · última cuota'
      )}
    </span>
  )
}
