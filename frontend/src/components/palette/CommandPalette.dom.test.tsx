import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Provider, createStore } from 'jotai'
import { CreditCard, Palette } from 'lucide-react'
import { paletteOpenAtom } from '@/atoms/finance'
import { CommandPaletteHost } from './CommandPalette'

const switchTo = vi.fn(() => Promise.resolve())

vi.mock('../config/sections', () => ({
  AVAILABLE_SECTIONS: [
    { id: 'tarjetas', label: 'Tarjetas', icon: CreditCard },
    { id: 'apariencia', label: 'Apariencia', icon: Palette },
  ],
}))
vi.mock('../shell/profiles', () => ({
  useProfiles: () => ({
    users: [
      { id: 1, name: 'Gastón' },
      { id: 2, name: 'Camila' },
    ],
    active: { id: 1, name: 'Gastón' },
  }),
  useProfileActions: () => ({ switchTo }),
}))
vi.mock('../shell/backupNow', () => ({ requestBackup: () => Promise.resolve() }))

async function openPalette() {
  const store = createStore()
  store.set(paletteOpenAtom, true)
  await render(
    <Provider store={store}>
      <CommandPaletteHost />
    </Provider>,
  )
  return store
}

const combobox = () => page.getByRole('combobox', { name: 'Buscar pantallas, acciones o gastos' })

beforeEach(() => {
  history.replaceState(null, '', '#/resumen')
  localStorage.removeItem('app-finance:palette-recent')
})

describe('CommandPalette', () => {
  it('opens with focus in the combobox and the first option active', async () => {
    await openPalette()
    await expect.element(combobox()).toHaveFocus()
    const activeId = combobox().element().getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    expect(document.getElementById(activeId!)?.getAttribute('aria-selected')).toBe('true')
    await expect.element(page.getByRole('option', { name: /Nuevo gasto/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('filters as you type and runs the active command with Enter', async () => {
    const store = await openPalette()
    await userEvent.keyboard('proy')
    await expect.element(combobox()).toHaveValue('proy')
    const texts = page.getByRole('option').elements().map((e) => e.textContent)
    expect(texts[0]).toContain('Proyección')
    await userEvent.keyboard('{Enter}')
    expect(window.location.hash).toBe('#/proyeccion')
    expect(store.get(paletteOpenAtom)).toBe(false)
  })

  it('moves the active option with the arrows, wrapping at the ends', async () => {
    await openPalette()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    await expect.element(page.getByRole('option').last()).toHaveAttribute('aria-selected', 'true')
  })

  it('offers to search expenses for any text', async () => {
    await openPalette()
    await userEvent.keyboard('jumbo')
    await expect.element(page.getByRole('option', { name: 'Buscar gastos: «jumbo»' })).toBeVisible()
    await page.getByRole('option', { name: 'Buscar gastos: «jumbo»' }).click()
    expect(window.location.hash).toBe('#/buscar?q=jumbo')
  })

  it('switches profile, and remembers the command as recent', async () => {
    await openPalette()
    await userEvent.keyboard('camila{Enter}')
    expect(switchTo).toHaveBeenCalledWith(2)
    expect(JSON.parse(localStorage.getItem('app-finance:palette-recent') ?? '[]')).toEqual(['profile:2'])
  })

  it('closes with Escape', async () => {
    const store = await openPalette()
    await userEvent.keyboard('{Escape}')
    expect(store.get(paletteOpenAtom)).toBe(false)
  })
})
