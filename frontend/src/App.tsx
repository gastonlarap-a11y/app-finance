import { useEffect } from 'react'
import { useInvalidate } from '@/atoms/refresh'
import { onMailSyncDone } from '@/services/mailsync'
import { UsersService } from '@/services/users'
import { notify } from '@/lib/notify'
import { useUFSync } from '@/lib/useUFSync'
import type { Route } from '@/lib/route'
import { useRoute } from '@/lib/useRoute'
import { AppShell } from '@/components/shell/AppShell'
import { ConfigView } from '@/components/config/ConfigView'
import { MonthView } from '@/components/MonthView'
import { ImportInboxView } from '@/components/ImportInboxView'
import { YearView } from '@/components/YearView'
import { ForecastView } from '@/components/ForecastView'
import { SearchView } from '@/components/SearchView'
import { SavingsView } from '@/components/SavingsView'
import { FixedExpensesView } from '@/components/FixedExpensesView'

// useMailSyncNotices refreshes the inbox and mail status after every background
// mail sync (it only stages import items) and tells the active profile what it
// brought (other profiles' syncs stay quiet).
function useMailSyncNotices() {
  const invalidate = useInvalidate()
  useEffect(
    () =>
      onMailSyncDone((ev) => {
        invalidate('imports', 'mail')
        void UsersService.ActiveUser().then((active) => {
          if (active.data?.id !== ev.userId) return
          if (ev.error) notify('No se pudo revisar el correo: ' + ev.error)
          else if (ev.summary && ev.summary.added > 0) {
            notify(`${ev.summary.added} movimiento(s) nuevo(s) desde tu correo para revisar en Importar.`, 'success')
          }
        })
      }),
    [invalidate],
  )
}

// Screen renders the view of a route (lib/route.ts).
function Screen({ route }: { route: Route }) {
  switch (route.page) {
    case 'resumen':
      return <MonthView />
    case 'importar':
      return <ImportInboxView tab={route.tab} />
    case 'buscar':
      // Keyed by the query: a search opened with other text starts fresh.
      return <SearchView key={route.q} initialText={route.q} />
    case 'anio':
      return <YearView />
    case 'proyeccion':
      return <ForecastView />
    case 'fijos':
      return <FixedExpensesView />
    case 'ahorro':
      return <SavingsView />
    case 'config':
      return <ConfigView section={route.section} />
  }
}

function App() {
  const route = useRoute()
  useMailSyncNotices()
  useUFSync()
  return (
    <AppShell>
      <Screen route={route} />
    </AppShell>
  )
}

export default App
