import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Menu, Toggletip } from '../ui'

function renderMenu() {
  const edit = vi.fn()
  const remove = vi.fn()
  const items = [
    { label: 'Editar', onSelect: edit },
    { label: 'Duplicar', onSelect: () => {} },
    { label: 'Eliminar', onSelect: remove, tone: 'danger' as const },
  ]
  return { edit, remove, screen: render(<Menu label="Acciones de Arriendo" items={items} />) }
}

const trigger = () => page.getByRole('button', { name: 'Acciones de Arriendo' })
const item = (name: string) => page.getByRole('menuitem', { name })

describe('Menu', () => {
  it('opens from its trigger and focuses the first action', async () => {
    await renderMenu().screen
    await expect.element(trigger()).toHaveAttribute('aria-expanded', 'false')
    await trigger().click()
    await expect.element(page.getByRole('menu', { name: 'Acciones de Arriendo' })).toBeVisible()
    await expect.element(item('Editar')).toHaveFocus()
    await expect.element(trigger()).toHaveAttribute('aria-expanded', 'true')
  })

  it('moves with the arrow keys, wrapping at the ends', async () => {
    await renderMenu().screen
    await trigger().click()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(item('Duplicar')).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect.element(item('Eliminar')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(item('Editar')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    await expect.element(item('Eliminar')).toHaveFocus()
  })

  it('runs the chosen action and closes', async () => {
    const { remove, screen } = renderMenu()
    await screen
    await trigger().click()
    await item('Eliminar').click()
    expect(remove).toHaveBeenCalledOnce()
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape and gives focus back to the trigger', async () => {
    await renderMenu().screen
    await trigger().click()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
    await expect.element(trigger()).toHaveFocus()
  })

  it('opens from the keyboard with ArrowUp on the last action', async () => {
    await renderMenu().screen
    await userEvent.tab()
    await expect.element(trigger()).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    await expect.element(item('Eliminar')).toHaveFocus()
  })
})

describe('Toggletip', () => {
  it('shows its explanation on click, which a title tooltip cannot do on touch', async () => {
    await render(<Toggletip label="¿Qué es el cupo?">Lo que queda disponible de la tarjeta.</Toggletip>)
    const button = page.getByRole('button', { name: '¿Qué es el cupo?' })
    await expect.element(page.getByText('Lo que queda disponible de la tarjeta.')).not.toBeVisible()
    await button.click()
    await expect.element(page.getByText('Lo que queda disponible de la tarjeta.')).toBeVisible()
    await expect.element(button).toHaveAttribute('aria-expanded', 'true')
  })
})
