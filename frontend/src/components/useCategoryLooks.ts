import { useVersion } from '@/atoms/refresh'
import { FinanceService } from '@/services/finance'
import { categoryLooks, type CategoryLooks } from '@/lib/look'
import { useQuery } from '@/lib/useQuery'

// useCategoryLooks loads the profile's categories and resolves their looks,
// for views that do not list the categories already (those call
// categoryLooks() on their own data). Call it once per view, pass it to rows.
export function useCategoryLooks(): CategoryLooks {
  const version = useVersion('ledger')
  const query = useQuery(`category-looks:${version}`, () => FinanceService.ListCategories())
  return categoryLooks(query.data ?? [])
}
