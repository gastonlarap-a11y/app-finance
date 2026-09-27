import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatHash, type ConfigSection } from '@/lib/route'
import { AVAILABLE_SECTIONS, CONFIG_GROUPS } from './sections'

// ConfigView is the Configuración hub, laid out like the Settings app of
// macOS/iPadOS: a grouped list of sections and the chosen one beside it. On a
// narrow screen (container query) the list and the section take turns: the
// list at #/config, the section with a "‹ Configuración" link back.
export function ConfigView({ section }: { section: ConfigSection | null }) {
  const shown = AVAILABLE_SECTIONS.find((s) => s.id === section) ?? AVAILABLE_SECTIONS[0]
  if (!shown) return null

  return (
    <div className="@container">
      <div className="grid items-start gap-6 @3xl:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Secciones de configuración" className={`space-y-5 ${section ? 'hidden @3xl:block' : ''}`}>
          {CONFIG_GROUPS.map((group) => (
            <div key={group}>
              <h2 className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{group}</h2>
              <ul className="overflow-hidden rounded-xl bg-panel shadow-xs ring-1 ring-line @3xl:bg-transparent @3xl:shadow-none @3xl:ring-0">
                {AVAILABLE_SECTIONS.filter((s) => s.group === group).map((s) => {
                  const Icon = s.icon
                  const current = s.id === shown.id
                  return (
                    <li key={s.id} className="border-t border-line first:border-t-0 @3xl:border-0">
                      <a
                        href={formatHash({ page: 'config', section: s.id })}
                        aria-current={current ? 'page' : undefined}
                        className={`flex items-center gap-3 px-3 py-2.5 transition-colors @3xl:rounded-lg @3xl:py-2 ${
                          current ? '@3xl:bg-accent-soft @3xl:text-accent-fg' : 'text-fg hover:bg-sunken'
                        }`}
                      >
                        <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{s.label}</span>
                          <span className="block truncate text-xs text-fg-subtle @3xl:hidden">{s.description}</span>
                        </span>
                        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-subtle @3xl:hidden" />
                      </a>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className={`min-w-0 space-y-4 ${section ? '' : 'hidden @3xl:block'}`}>
          <a
            href={formatHash({ page: 'config', section: null })}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg @3xl:hidden"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Configuración
          </a>
          {shown.render()}
        </div>
      </div>
    </div>
  )
}
