import { useAtom } from 'jotai'
import { quickAddAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { FinanceService } from '@/services/finance'
import { useQuery } from '@/lib/useQuery'
import { ExpenseForm } from '../ExpenseForm'
import { Modal, QueryError } from '../ui'

// QuickAddHost owns the "new expense" dialog for the whole app, so an expense
// can be added from any screen (header button, N key, command palette).
// Editing an expense stays in the Resumen table that shows it.
export function QuickAddHost() {
  const [open, setOpen] = useAtom(quickAddAtom)
  if (!open) return null
  return <QuickAddForm onClose={() => setOpen(false)} />
}

function QuickAddForm({ onClose }: { onClose: () => void }) {
  const version = useVersion('ledger')
  const invalidate = useInvalidate()
  const query = useQuery(`quick-add:${version}`, async () => {
    const [cards, categories, merchants] = await Promise.all([
      FinanceService.ListCards(),
      FinanceService.ListCategories(),
      FinanceService.ListMerchants(),
    ])
    return { cards, categories: categories.map((c) => c.name), merchants: merchants.map((m) => m.name) }
  })

  if (query.status === 'error') {
    return (
      <Modal title="Agregar gasto" onClose={onClose}>
        <QueryError message={query.error} onRetry={() => invalidate('ledger')} />
      </Modal>
    )
  }
  // The catalogs load in a few milliseconds: the dialog opens with them.
  if (!query.data) return null
  const { cards, categories, merchants } = query.data
  return (
    <ExpenseForm
      cards={cards}
      categories={categories}
      merchants={merchants}
      target={{ mode: 'create' }}
      onClose={onClose}
      onSaved={() => invalidate('ledger')}
    />
  )
}
