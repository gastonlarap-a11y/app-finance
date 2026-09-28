import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus, Settings } from 'lucide-react'
import { paletteOpenAtom, periodAtom, quickAddAtom, sidebarCollapsedAtom } from '@/atoms/finance'
import { shiftPeriod } from '@/lib/format'
import { IS_APPLE, IS_WEB } from '@/lib/platform'
import { formatHash, type Route } from '@/lib/route'
import { isTyping, resolveShortcut } from '@/lib/shortcuts'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { navigate, useRoute } from '@/lib/useRoute'
import { UpdateBanner } from '../UpdateNotice'
import { WebUpdateBanner } from '../WebUpdateBanner'
import { Button, PageHeader, Toaster } from '../ui'
import { PAGES, type PageMeta } from './nav'
import { MobileTopBar, NavDrawer } from './MobileTopBar'
import { PeriodNav } from './PeriodNav'
import { QuickAddHost } from './QuickAddHost'
import { CommandPaletteHost } from '../palette/CommandPalette'
import { Sidebar } from './Sidebar'

const CONFIG_META: PageMeta = {
  label: 'Configuración',
  title: 'Configuración',
  subtitle: 'Tarjetas, categorías, respaldo y todo lo que se ajusta una vez.',
  icon: Settings,
}

function metaOf(route: Route): PageMeta {
  return route.page === 'config' ? CONFIG_META : PAGES[route.page]
}

// useAppShortcuts applies the keyboard shortcuts of lib/shortcuts.ts.
function useAppShortcuts(period: PageMeta['period']) {
  const setPeriod = useSetAtom(periodAtom)
  const setQuickAdd = useSetAtom(quickAddAtom)
  const setPalette = useSetAtom(paletteOpenAtom)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const action = resolveShortcut(e, {
        apple: IS_APPLE,
        typing: isTyping(e.target),
        dialogOpen: document.querySelector('dialog[open]') !== null,
        periodNav: period !== undefined,
      })
      if (!action) return
      e.preventDefault()
      if (action.kind === 'navigate') navigate(action.route)
      else if (action.kind === 'quick-add') setQuickAdd(true)
      else if (action.kind === 'palette') setPalette(true)
      else setPeriod((p) => shiftPeriod(p, action.step * (period === 'year' ? 12 : 1)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [period, setPeriod, setQuickAdd, setPalette])
}

// useFocusOnNavigate moves focus to the new screen's heading (announced by
// screen readers) and back to the top after every navigation — not on the
// first render, which would steal the initial focus.
function useFocusOnNavigate(key: string) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    document.querySelector<HTMLElement>('main h1')?.focus()
    window.scrollTo(0, 0)
  }, [key])
}

// AppShell is the frame of every screen: navigation (sidebar, icon rail or
// drawer by width), the screen's header with its period navigator and the
// quick "new expense" action, update banners, dialogs and toasts.
export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute()
  const meta = metaOf(route)
  const wide = useMediaQuery('(min-width: 64rem)')
  const medium = useMediaQuery('(min-width: 48rem)')
  const collapsed = useAtomValue(sidebarCollapsedAtom)
  const setQuickAdd = useSetAtom(quickAddAtom)
  const [drawerOpen, setDrawerOpen] = useState(false)
  useAppShortcuts(meta.period)
  useFocusOnNavigate(formatHash(route))

  return (
    <div className="flex min-h-dvh">
      {medium && (
        <div className="sticky top-0 h-dvh shrink-0">
          <Sidebar variant={wide && !collapsed ? 'expanded' : 'rail'} collapsible={wide} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {!medium && <MobileTopBar onOpenMenu={() => setDrawerOpen(true)} />}
        {IS_WEB ? <WebUpdateBanner /> : <UpdateBanner />}
        <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-6 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:px-8">
          {/* Window drag band on the desktop build (hidden title bar); its controls opt out. */}
          <div className="[--wails-draggable:drag]">
            <PageHeader
              title={meta.title}
              subtitle={meta.subtitle}
              actions={
                route.page !== 'config' && (
                  <div className="flex flex-wrap items-center gap-2 [--wails-draggable:no-drag]">
                    {meta.period && <PeriodNav unit={meta.period} />}
                    <Button icon={Plus} onClick={() => setQuickAdd(true)} title="Agregar gasto (N)">
                      Gasto
                    </Button>
                  </div>
                )
              }
            />
          </div>
          {children}
        </main>
      </div>
      {drawerOpen && <NavDrawer onClose={() => setDrawerOpen(false)} />}
      <QuickAddHost />
      <CommandPaletteHost />
      <Toaster />
    </div>
  )
}
