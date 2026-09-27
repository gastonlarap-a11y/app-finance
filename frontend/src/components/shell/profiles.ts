import { useSetAtom } from 'jotai'
import { periodAtom } from '@/atoms/finance'
import { useInvalidate, useVersion } from '@/atoms/refresh'
import { UsersService, type User } from '@/services/users'
import { currentPeriod } from '@/lib/format'
import { failed } from '@/lib/result'
import { useQuery } from '@/lib/useQuery'

// Profiles (users) as the sidebar switcher and Configuración › Perfiles see
// them. Server state stays in the query; a switch invalidates every topic, so
// every screen refetches for the newly active profile.

export function useProfiles() {
  const version = useVersion('profiles')
  const query = useQuery(version, async () => {
    const [activeRes, users] = await Promise.all([UsersService.ActiveUser(), UsersService.ListUsers()])
    return { active: activeRes.data ?? null, users }
  })
  return {
    query,
    active: query.data?.active ?? null,
    users: query.data?.users ?? ([] as User[]),
  }
}

export function useProfileActions() {
  const invalidate = useInvalidate()
  const setPeriod = useSetAtom(periodAtom)

  // Reload every view for the freshly selected profile, on this month.
  function applySwitch() {
    setPeriod(currentPeriod())
    invalidate()
  }

  async function switchTo(id: number): Promise<void> {
    if (!failed(await UsersService.SwitchUser(id))) applySwitch()
  }

  // create makes a new (empty) profile and switches to it.
  async function create(name: string): Promise<boolean> {
    if (failed(await UsersService.CreateUser(name))) return false
    applySwitch()
    return true
  }

  // remove sends a profile to the trash. Deleting the active one switches to
  // whichever profile the backend reassigns; any other just refreshes the list.
  async function remove(id: number): Promise<void> {
    const res = await UsersService.DeleteUser(id)
    if (failed(res)) return
    if (res.data) applySwitch()
    else invalidate('profiles')
  }

  return { switchTo, create, remove }
}

// initial is the avatar letter of a profile name.
export function initial(name: string | undefined): string {
  return (name?.trim().charAt(0) || '?').toUpperCase()
}
