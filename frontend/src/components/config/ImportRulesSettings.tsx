import { WandSparkles } from 'lucide-react'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { FinanceService } from '@/services/finance'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'
import { ConfirmAction, EmptyState, QueryError, Section, SkeletonRows } from '../ui'

// ImportRulesSettings lists the learned import rules: a bank descriptor prefix
// that fills in its merchant and category on the next matching movement.
export function ImportRulesSettings() {
  const version = useVersion('imports')
  const invalidate = useInvalidate()
  const query = useQuery(`rules:${version}`, () => FinanceService.ListMerchantRules())

  async function forget(id: number) {
    if (!failed(await FinanceService.DeleteMerchantRule(id))) invalidate('imports')
  }

  return (
    <Section title="Reglas de importación">
      <p className="mb-4 text-sm text-fg-muted">
        Al confirmar un movimiento importado puedes pedir que se recuerde su comercio y categoría: la próxima glosa igual llega
        completa.
      </p>
      {query.status === 'error' ? (
        <QueryError message={query.error} onRetry={() => invalidate('imports')} />
      ) : !query.data ? (
        <SkeletonRows rows={3} />
      ) : query.data.length === 0 ? (
        <EmptyState icon={WandSparkles} title="Aún no hay reglas">
          Aparecen cuando confirmas un movimiento en Importar con «recordar comercio y categoría».
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {query.data.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0 text-sm">
                <span className="font-mono text-fg">«{r.pattern}…»</span>{' '}
                <span className="text-fg-muted">
                  → {r.merchant || 'sin comercio'} · {r.category || 'Sin categoría'}
                </span>
              </div>
              <ConfirmAction label={`Olvidar la regla «${r.pattern}»`} iconOnly question="¿Olvidar?" confirmLabel="Olvidar" onConfirm={() => forget(r.id)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
