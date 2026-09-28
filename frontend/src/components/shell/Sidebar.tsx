import type { ReactNode } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Command, PanelLeftClose, PanelLeftOpen, Settings, Wallet, type LucideIcon } from 'lucide-react'
import { paletteOpenAtom, sidebarCollapsedAtom } from '@/atoms/finance'
import { useVersion } from '@/atoms/refresh'
import { FinanceService } from '@/services/finance'
import { IS_APPLE, IS_WEB } from '@/lib/platform'
import { formatHash, type Route } from '@/lib/route'
import { useQuery } from '@/lib/useQuery'
import { useRoute } from '@/lib/useRoute'
import { IconButton } from '../ui'
import { NAV_GROUPS, PAGES, routeTo, shortcutOf } from './nav'
import { SidebarBackup } from './SidebarBackup'
import { SidebarProfile } from './SidebarProfile'

export type SidebarVariant = 'expanded' | 'rail'

// usePendingImports counts the inbox movements awaiting review (0 when the
// inbox is empty or cannot be read: the badge is a hint, never an error).
function usePendingImports(): number {
  const version = useVersion('imports')
  const query = useQuery(version, async () => (await FinanceService.ListImportItems('pendiente')).data?.length ?? 0)
  return query.data ?? 0
}

function NavLink({
  to,
  label,
  icon: Icon,
  active,
  rail,
  hint,
  badge,
  onNavigate,
}: {
  to: Route
  label: string
  icon: LucideIcon
  active: boolean
  rail: boolean
  hint?: string
  badge?: ReactNode
  onNavigate?: () => void
}) {
  return (
    <a
      href={formatHash(to)}
      aria-current={active ? 'page' : undefined}
      title={hint}
      onClick={onNavigate}
      className={`relative flex items-center rounded-lg font-medium transition-colors ${
        rail ? 'flex-col gap-1 px-1 py-2 text-center text-[11px] leading-tight hyphens-auto' : 'gap-3 px-3 py-2 text-sm'
      } ${active ? 'bg-accent-soft text-accent-fg' : 'text-fg-muted hover:bg-sunken hover:text-fg'}`}
    >
      <Icon aria-hidden="true" className={rail ? 'size-5' : 'size-4 shrink-0'} />
      {/* The rail wraps a long label to a second line instead of cutting it. */}
      <span className={rail ? 'max-w-full break-words' : 'flex-1 truncate'}>{label}</span>
      {badge}
    </a>
  )
}

function PendingBadge({ count, rail }: { count: number; rail: boolean }) {
  if (count === 0) return null
  return (
    <>
      <span
        aria-hidden="true"
        className={`rounded-full bg-caution-soft px-1.5 text-[11px] font-semibold tabular-nums text-caution-fg ${rail ? 'absolute right-1 top-1' : ''}`}
      >
        {count}
      </span>
      <span className="sr-only">, {count} por revisar</span>
    </>
  )
}

// Sidebar is the app's main navigation: the screens grouped by purpose, with
// Configuración, the profile and the backup status at the bottom. `rail` is the
// narrow icon version (labels stay visible under the icons: no tooltip needed,
// which matters on touch screens).
export function Sidebar({ variant, collapsible = false, onNavigate }: { variant: SidebarVariant; collapsible?: boolean; onNavigate?: () => void }) {
  const route = useRoute()
  const pending = usePendingImports()
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const setPalette = useSetAtom(paletteOpenAtom)
  const rail = variant === 'rail'
  const mod = IS_APPLE ? '⌘' : 'Ctrl+'

  return (
    <nav
      aria-label="Secciones"
      className={`flex h-full flex-col gap-5 overflow-y-auto border-r border-line bg-sidebar pb-3 pt-safe ${rail ? 'w-24 px-1' : 'w-60 px-3'}`}
    >
      {/* Drag handle of the desktop window. On macOS the traffic lights sit at
          its top left: the brand moves right of them, or below them in the rail. */}
      <div
        className={`flex h-14 shrink-0 items-center gap-2 [--wails-draggable:drag] ${
          rail ? 'justify-center mac:h-auto mac:pt-11' : 'px-2 mac:pl-[76px]'
        }`}
      >
        {/* Beside the traffic lights (expanded, macOS) the name alone fits on one line. */}
        <span
          aria-hidden="true"
          className={`flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent shadow-xs ${rail ? '' : 'mac:hidden'}`}
        >
          <Wallet className="size-4" />
        </span>
        {!rail && <span className="font-semibold tracking-tight text-fg">App Finance</span>}
      </div>

      {NAV_GROUPS.map((group, i) => (
        <div key={group.label ?? i} className="space-y-1">
          {group.label &&
            (rail ? (
              <hr className="mx-3 mb-2 border-line" />
            ) : (
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{group.label}</p>
            ))}
          <ul className="space-y-0.5">
            {group.pages.map((page) => {
              const meta = PAGES[page]
              return (
                <li key={page}>
                  <NavLink
                    to={routeTo(page)}
                    label={meta.label}
                    icon={meta.icon}
                    active={route.page === page}
                    rail={rail}
                    hint={`${meta.label} (${mod}${shortcutOf(page)})`}
                    badge={page === 'importar' ? <PendingBadge count={pending} rail={rail} /> : undefined}
                    onNavigate={onNavigate}
                  />
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <div className="mt-auto space-y-2">
        <button
          type="button"
          onClick={() => {
            onNavigate?.() // the drawer closes first: one dialog at a time
            setPalette(true)
          }}
          className={`flex w-full items-center rounded-lg font-medium text-fg-muted transition-colors hover:bg-sunken hover:text-fg ${
            rail ? 'flex-col gap-1 px-1 py-2 text-center text-[11px] leading-tight' : 'gap-3 px-3 py-2 text-sm'
          }`}
        >
          <Command aria-hidden="true" className={rail ? 'size-5' : 'size-4 shrink-0'} />
          <span className={rail ? '' : 'flex-1 text-left'}>Ir a…</span>
          {!rail && (
            <kbd aria-hidden="true" className="rounded bg-sunken px-1.5 py-0.5 font-sans text-[11px] text-fg-subtle ring-1 ring-inset ring-line pointer-coarse:hidden">
              {mod}K
            </kbd>
          )}
        </button>
        <NavLink
          to={{ page: 'config', section: null }}
          label="Configuración"
          icon={Settings}
          active={route.page === 'config'}
          rail={rail}
          hint={`Configuración (${mod},)`}
          onNavigate={onNavigate}
        />
        <div className="space-y-1 border-t border-line pt-2">
          <SidebarProfile rail={rail} />
          <SidebarBackup rail={rail} />
        </div>
        {IS_WEB && (
          // The web build is the app's public home page: Google's OAuth policy asks it to link the privacy policy.
          <a
            href={`${import.meta.env.BASE_URL}privacy.html`}
            className={`block text-fg-subtle underline-offset-2 hover:text-fg hover:underline ${rail ? 'text-center text-[10px]' : 'px-3 text-xs'}`}
          >
            {rail ? 'Privacidad' : 'Política de privacidad'}
          </a>
        )}
        {collapsible && (
          <div className={rail ? 'flex justify-center' : 'px-1'}>
            <IconButton
              label={collapsed ? 'Expandir la barra lateral' : 'Contraer la barra lateral'}
              icon={collapsed ? PanelLeftOpen : PanelLeftClose}
              onClick={() => setCollapsed(!collapsed)}
            />
          </div>
        )}
      </div>
    </nav>
  )
}
