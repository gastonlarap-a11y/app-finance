import { useAtom } from 'jotai'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { periodAtom } from '@/atoms/finance'
import { currentPeriod, periodLabel, shiftPeriod, yearOf } from '@/lib/format'
import { Button, IconButton } from '../ui'

// PeriodNav moves the month (or year) the screen shows. The ← / → keys do the
// same (lib/shortcuts.ts); the label is announced when it changes.
export function PeriodNav({ unit }: { unit: 'month' | 'year' }) {
  const [period, setPeriod] = useAtom(periodAtom)
  const year = unit === 'year'
  const step = year ? 12 : 1
  const now = currentPeriod()
  const atNow = year ? yearOf(period) === yearOf(now) : period === now
  return (
    <div role="group" aria-label={year ? 'Año' : 'Mes'} className="flex items-center gap-1">
      <IconButton label={year ? 'Año anterior (←)' : 'Mes anterior (←)'} icon={ChevronLeft} onClick={() => setPeriod(shiftPeriod(period, -step))} />
      <span aria-live="polite" className="min-w-36 text-center text-sm font-semibold tabular-nums text-fg">
        {year ? yearOf(period) : periodLabel(period)}
      </span>
      <IconButton label={year ? 'Año siguiente (→)' : 'Mes siguiente (→)'} icon={ChevronRight} onClick={() => setPeriod(shiftPeriod(period, step))} />
      {!atNow && (
        <Button variant="secondary" size="sm" onClick={() => setPeriod(now)}>
          {year ? 'Este año' : 'Mes actual'}
        </Button>
      )}
    </div>
  )
}
