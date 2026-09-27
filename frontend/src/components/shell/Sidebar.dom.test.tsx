import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Sidebar } from './Sidebar'

vi.mock('@/services/finance', () => ({
  FinanceService: { ListImportItems: () => Promise.resolve({ data: [{ id: 1 }, { id: 2 }] }) },
}))
vi.mock('@/services/users', () => ({
  UsersService: {
    ActiveUser: () => Promise.resolve({ data: { id: 1, name: 'Gastón' } }),
    ListUsers: () =>
      Promise.resolve([
        { id: 1, name: 'Gastón' },
        { id: 2, name: 'Camila' },
      ]),
    SwitchUser: () => Promise.resolve({}),
  },
}))
// The web export control pulls the local database engine; not under test here.
vi.mock('../WebBackup', () => ({ WebExportControl: () => null }))

beforeEach(() => {
  history.replaceState(null, '', '#/resumen')
})

describe('Sidebar', () => {
  it('groups the screens and marks the current one', async () => {
    history.replaceState(null, '', '#/anio')
    await render(<Sidebar variant="expanded" />)
    await expect.element(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible()
    await expect.element(page.getByText('Análisis')).toBeVisible()
    await expect.element(page.getByRole('link', { name: 'Año' })).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByRole('link', { name: 'Resumen' })).not.toHaveAttribute('aria-current')
  })

  it('says how many movements wait in Importar', async () => {
    await render(<Sidebar variant="expanded" />)
    // The visible count is aria-hidden; screen readers get it in words.
    await expect.element(page.getByRole('link', { name: /^Importar\s*,\s*2 por revisar$/ })).toBeVisible()
    await expect.element(page.getByText('2', { exact: true })).toBeVisible()
  })

  it('navigates through the URL hash', async () => {
    await render(<Sidebar variant="expanded" />)
    await page.getByRole('link', { name: 'Proyección' }).click()
    expect(window.location.hash).toBe('#/proyeccion')
    await expect.element(page.getByRole('link', { name: 'Proyección' })).toHaveAttribute('aria-current', 'page')
    await page.getByRole('link', { name: 'Configuración' }).click()
    expect(window.location.hash).toBe('#/config')
  })

  it('keeps the labels visible in the icon rail (no tooltip needed on touch)', async () => {
    await render(<Sidebar variant="rail" />)
    await expect.element(page.getByText('Gastos fijos')).toBeVisible()
    await expect.element(page.getByText('Configuración')).toBeVisible()
  })

  it('switches profile from the profile menu', async () => {
    await render(<Sidebar variant="expanded" />)
    await page.getByRole('button', { name: 'Perfil: Gastón. Cambiar de perfil' }).click()
    await expect.element(page.getByRole('menuitem', { name: 'Cambiar a Camila' })).toBeVisible()
    await expect.element(page.getByRole('menuitem', { name: 'Administrar perfiles…' })).toBeVisible()
  })

  it('closes the drawer when a destination is chosen', async () => {
    const onNavigate = vi.fn()
    await render(<Sidebar variant="expanded" onNavigate={onNavigate} />)
    await page.getByRole('link', { name: 'Ahorro' }).click()
    expect(onNavigate).toHaveBeenCalledOnce()
  })
})
