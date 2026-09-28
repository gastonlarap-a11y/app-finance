import { useState } from 'react'
import { LibraryBig } from 'lucide-react'
import { FinanceService } from '@/services/finance'
import { useInvalidate } from '@/atoms/refresh'
import { failed } from '@/lib/result'
import { notify } from '@/lib/notify'
import { catalogMessage } from '@/lib/wording'
import { Button } from './ui'

// CatalogButton adds the suggested Chilean catalog (categories with their
// icon, well-known merchants with their usual category, and the import rules
// that recognize them). It never duplicates or changes what the profile has.
export function CatalogButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const invalidate = useInvalidate()
  const [busy, setBusy] = useState(false)

  async function apply() {
    setBusy(true)
    try {
      const res = await FinanceService.ApplyCatalog()
      if (failed(res) || !res.data) return
      notify(catalogMessage(res.data), 'success')
      invalidate('ledger', 'imports')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant={variant} icon={LibraryBig} loading={busy} onClick={() => void apply()}>
      Agregar catálogo sugerido
    </Button>
  )
}
