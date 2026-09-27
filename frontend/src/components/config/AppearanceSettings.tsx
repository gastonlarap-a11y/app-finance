import { useAtom } from 'jotai'
import { Monitor, Moon, Sun } from 'lucide-react'
import { sidebarCollapsedAtom } from '@/atoms/finance'
import { THEME_LIGHT_ENABLED, setThemeMode, useThemeMode, type ThemeMode } from '@/lib/theme'
import { Section, SegmentedControl, Switch } from '../ui'

const THEMES = [
  { value: 'system', label: 'Sistema', icon: Monitor },
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Oscuro', icon: Moon },
] as const satisfies readonly { value: ThemeMode; label: string; icon: typeof Sun }[]

// AppearanceSettings: per-device look preferences (never in the DB).
export function AppearanceSettings() {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const mode = useThemeMode()
  return (
    <Section title="Apariencia">
      <div className="space-y-6">
        {THEME_LIGHT_ENABLED && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">Tema</p>
            <SegmentedControl label="Tema" value={mode} options={THEMES} onChange={setThemeMode} />
            <p className="text-xs text-fg-subtle">«Sistema» sigue el modo claro u oscuro de tu dispositivo.</p>
          </div>
        )}
        <Switch
          label="Barra lateral compacta"
          description="En pantallas anchas, muestra solo los íconos de las secciones. En pantallas angostas siempre es compacta."
          checked={collapsed}
          onChange={setCollapsed}
        />
      </div>
    </Section>
  )
}
