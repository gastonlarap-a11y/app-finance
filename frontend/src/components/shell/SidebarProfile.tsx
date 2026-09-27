import { ChevronsUpDown, UserRound, Users } from 'lucide-react'
import { navigate } from '@/lib/useRoute'
import { Menu, type MenuAction } from '../ui'
import { initial, useProfileActions, useProfiles } from './profiles'

// SidebarProfile shows who is using the app and switches profile in one step.
// Creating or deleting profiles lives in Configuración › Perfiles.
export function SidebarProfile({ rail }: { rail: boolean }) {
  const { active, users } = useProfiles()
  const { switchTo } = useProfileActions()
  const name = active?.name ?? '…'

  const items: MenuAction[] = [
    ...users
      .filter((u) => u.id !== active?.id)
      .map((u) => ({ label: `Cambiar a ${u.name}`, icon: UserRound, onSelect: () => void switchTo(u.id) })),
    { label: 'Administrar perfiles…', icon: Users, onSelect: () => navigate({ page: 'config', section: 'perfiles' }) },
  ]

  return (
    <Menu
      label={`Perfil: ${name}. Cambiar de perfil`}
      items={items}
      align="start"
      triggerClassName={`w-full rounded-lg text-fg hover:bg-sunken ${rail ? 'justify-center py-2' : 'py-1.5'}`}
      trigger={
        <>
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent-fg">
            {initial(active?.name)}
          </span>
          {!rail && (
            <>
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{name}</span>
              <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
            </>
          )}
        </>
      }
    />
  )
}
