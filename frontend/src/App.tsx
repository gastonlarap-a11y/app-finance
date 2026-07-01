import { useAtom } from 'jotai'
import { periodAtom, tabAtom, type Tab } from '@/atoms/finance'
import { periodLabel, shiftPeriod, yearOf } from '@/lib/format'
import { MonthView } from '@/components/MonthView'
import { YearView } from '@/components/YearView'
import { CardsView } from '@/components/CardsView'
import { CategoriesView } from '@/components/CategoriesView'
import { FixedExpensesView } from '@/components/FixedExpensesView'
import { TrashView } from '@/components/TrashView'
import { SettingsView } from '@/components/SettingsView'
import { BackupControl } from '@/components/BackupControl'
import { UserSwitcher } from '@/components/UserSwitcher'

const TABS: { id: Tab; label: string }[] = [
  { id: 'mes', label: 'Mes' },
  { id: 'anio', label: 'Año' },
  { id: 'fijos', label: 'Fijos' },
  { id: 'tarjetas', label: 'Tarjetas' },
  { id: 'categorias', label: 'Categorías' },
  { id: 'papelera', label: 'Papelera' },
  { id: 'ajustes', label: 'Ajustes' },
]

function App() {
  const [tab, setTab] = useAtom(tabAtom)
  const [period, setPeriod] = useAtom(periodAtom)

  return (
    <div className="min-h-screen bg-surface text-slate-100">
      <header className="border-b border-slate-800 bg-surface-alt/50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-2xl font-bold text-primary">App Finance</h1>
            <p className="text-sm text-slate-400">Tus cuentas mes a mes · ¿alcanza?</p>
          </div>
          <div className="flex items-center gap-3">
            <UserSwitcher />
            <BackupControl />
          </div>
        </div>

        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 pb-4">
          <nav className="flex gap-1 rounded-base bg-surface p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded px-4 py-1.5 text-sm font-medium transition ${
                  tab === t.id ? 'bg-primary text-white' : 'text-slate-300 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {(tab === 'mes' || tab === 'fijos') && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPeriod(shiftPeriod(period, -1))}
                className="rounded bg-surface px-3 py-1.5 ring-1 ring-slate-700 hover:ring-slate-500"
                aria-label="Mes anterior"
              >
                ←
              </button>
              <span className="min-w-40 text-center font-medium">{periodLabel(period)}</span>
              <button
                onClick={() => setPeriod(shiftPeriod(period, 1))}
                className="rounded bg-surface px-3 py-1.5 ring-1 ring-slate-700 hover:ring-slate-500"
                aria-label="Mes siguiente"
              >
                →
              </button>
            </div>
          )}

          {tab === 'anio' && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPeriod(shiftPeriod(period, -12))}
                className="rounded bg-surface px-3 py-1.5 ring-1 ring-slate-700 hover:ring-slate-500"
                aria-label="Año anterior"
              >
                ←
              </button>
              <span className="min-w-40 text-center font-medium">{yearOf(period)}</span>
              <button
                onClick={() => setPeriod(shiftPeriod(period, 12))}
                className="rounded bg-surface px-3 py-1.5 ring-1 ring-slate-700 hover:ring-slate-500"
                aria-label="Año siguiente"
              >
                →
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {tab === 'mes' && <MonthView />}
        {tab === 'anio' && <YearView />}
        {tab === 'fijos' && <FixedExpensesView />}
        {tab === 'tarjetas' && <CardsView />}
        {tab === 'categorias' && <CategoriesView />}
        {tab === 'papelera' && <TrashView />}
        {tab === 'ajustes' && <SettingsView />}
      </main>
    </div>
  )
}

export default App
