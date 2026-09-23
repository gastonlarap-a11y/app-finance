import { useEffect } from 'react'
import { useAtom } from 'jotai'
import { periodAtom, tabAtom, type Tab } from '@/atoms/finance'
import { currentPeriod, periodLabel, shiftPeriod, yearOf } from '@/lib/format'
import { MonthView } from '@/components/MonthView'
import { YearView } from '@/components/YearView'
import { ForecastView } from '@/components/ForecastView'
import { SearchView } from '@/components/SearchView'
import { SavingsView } from '@/components/SavingsView'
import { CardsView } from '@/components/CardsView'
import { CategoriesView } from '@/components/CategoriesView'
import { MerchantsView } from '@/components/MerchantsView'
import { FixedExpensesView } from '@/components/FixedExpensesView'
import { TrashView } from '@/components/TrashView'
import { SettingsView } from '@/components/SettingsView'
import { BackupControl } from '@/components/BackupControl'
import { UserSwitcher } from '@/components/UserSwitcher'
import { Toaster } from '@/components/ui'

const TABS: { id: Tab; label: string }[] = [
  { id: 'mes', label: 'Mes' },
  { id: 'anio', label: 'Año' },
  { id: 'proyeccion', label: 'Proyección' },
  { id: 'buscar', label: 'Buscar' },
  { id: 'ahorro', label: 'Ahorro' },
  { id: 'fijos', label: 'Fijos' },
  { id: 'tarjetas', label: 'Tarjetas' },
  { id: 'categorias', label: 'Categorías' },
  { id: 'comercios', label: 'Comercios' },
  { id: 'papelera', label: 'Papelera' },
  { id: 'ajustes', label: 'Ajustes' },
]

// Tabs whose content follows the selected month / year (and so show the navigator).
const MONTH_TABS: ReadonlySet<Tab> = new Set(['mes', 'fijos', 'proyeccion'])

// isTyping: keyboard shortcuts must never steal keys from a form field or dialog.
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !!target.closest('dialog')
}

const navBtn = 'rounded bg-surface px-3 py-1.5 ring-1 ring-slate-700 hover:ring-slate-500'

function App() {
  const [tab, setTab] = useAtom(tabAtom)
  const [period, setPeriod] = useAtom(periodAtom)
  const monthNav = MONTH_TABS.has(tab)
  const step = tab === 'anio' ? 12 : 1

  // ← / → move the month (or year on the Año tab), mirroring the header arrows.
  useEffect(() => {
    if (!monthNav && tab !== 'anio') return
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return
      if (e.key === 'ArrowLeft') setPeriod((p) => shiftPeriod(p, -step))
      else if (e.key === 'ArrowRight') setPeriod((p) => shiftPeriod(p, step))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [monthNav, tab, step, setPeriod])

  return (
    <div className="min-h-screen bg-surface text-slate-100">
      <header className="border-b border-slate-800 bg-surface-alt/50">
        <div className="mx-auto flex max-w-[1536px] flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-2xl font-bold text-primary">App Finance</h1>
            <p className="text-sm text-slate-400">Tus cuentas mes a mes · ¿alcanza?</p>
          </div>
          <div className="flex items-center gap-3">
            <UserSwitcher />
            <BackupControl />
          </div>
        </div>

        <div className="mx-auto flex max-w-[1536px] flex-wrap items-center justify-between gap-4 px-6 pb-4">
          <nav aria-label="Secciones" className="flex gap-1 overflow-x-auto rounded-base bg-surface p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`shrink-0 rounded px-4 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-primary ${
                  tab === t.id ? 'bg-primary text-white' : 'text-slate-300 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {monthNav && (
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setPeriod(shiftPeriod(period, -1))} className={navBtn} aria-label="Mes anterior" title="Mes anterior (←)">
                ←
              </button>
              <span className="min-w-40 text-center font-medium" aria-live="polite">
                {periodLabel(period)}
              </span>
              <button type="button" onClick={() => setPeriod(shiftPeriod(period, 1))} className={navBtn} aria-label="Mes siguiente" title="Mes siguiente (→)">
                →
              </button>
              {period !== currentPeriod() && (
                <button type="button" onClick={() => setPeriod(currentPeriod())} className={navBtn}>
                  Mes actual
                </button>
              )}
            </div>
          )}

          {tab === 'anio' && (
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setPeriod(shiftPeriod(period, -12))} className={navBtn} aria-label="Año anterior" title="Año anterior (←)">
                ←
              </button>
              <span className="min-w-40 text-center font-medium" aria-live="polite">
                {yearOf(period)}
              </span>
              <button type="button" onClick={() => setPeriod(shiftPeriod(period, 12))} className={navBtn} aria-label="Año siguiente" title="Año siguiente (→)">
                →
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1536px] px-6 py-6">
        {tab === 'mes' && <MonthView />}
        {tab === 'anio' && <YearView />}
        {tab === 'proyeccion' && <ForecastView />}
        {tab === 'buscar' && <SearchView />}
        {tab === 'ahorro' && <SavingsView />}
        {tab === 'fijos' && <FixedExpensesView />}
        {tab === 'tarjetas' && <CardsView />}
        {tab === 'categorias' && <CategoriesView />}
        {tab === 'comercios' && <MerchantsView />}
        {tab === 'papelera' && <TrashView />}
        {tab === 'ajustes' && <SettingsView />}
      </main>

      <Toaster />
    </div>
  )
}

export default App
