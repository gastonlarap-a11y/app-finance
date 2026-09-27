import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ConfirmAction, ConfirmDialog } from '../ui'

describe('ConfirmAction', () => {
  it('asks first, with focus on the safe choice', async () => {
    const onConfirm = vi.fn()
    await render(<ConfirmAction label="Eliminar Arriendo" iconOnly onConfirm={onConfirm} />)
    await page.getByRole('button', { name: 'Eliminar Arriendo' }).click()
    await expect.element(page.getByRole('group', { name: 'Eliminar Arriendo: ¿Eliminar?' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('runs the action once confirmed', async () => {
    const onConfirm = vi.fn()
    await render(<ConfirmAction label="Vaciar papelera" question="¿Vaciar todo?" confirmLabel="Vaciar" onConfirm={onConfirm} />)
    await page.getByRole('button', { name: 'Vaciar papelera' }).click()
    await page.getByRole('button', { name: 'Vaciar', exact: true }).click()
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancels on Escape and returns focus to the trigger', async () => {
    await render(<ConfirmAction label="Eliminar Arriendo" iconOnly onConfirm={() => {}} />)
    await page.getByRole('button', { name: 'Eliminar Arriendo' }).click()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('group')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Eliminar Arriendo' })).toHaveFocus()
  })

  it('cancels when focus leaves the question', async () => {
    await render(
      <>
        <ConfirmAction label="Eliminar Arriendo" iconOnly onConfirm={() => {}} />
        <button type="button">Otro</button>
      </>,
    )
    await page.getByRole('button', { name: 'Eliminar Arriendo' }).click()
    await page.getByRole('button', { name: 'Otro' }).click()
    await expect.element(page.getByRole('group')).not.toBeInTheDocument()
  })
})

describe('ConfirmDialog', () => {
  it('opens with focus on «Cancelar» and runs the action once confirmed', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await render(
      <ConfirmDialog title="Eliminar gasto" onConfirm={onConfirm} onClose={onClose}>
        ¿Eliminar «Parlante»?
      </ConfirmDialog>,
    )
    await expect.element(page.getByRole('dialog', { name: 'Eliminar gasto' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    await page.getByRole('button', { name: 'Eliminar', exact: true }).click()
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape without confirming', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await render(
      <ConfirmDialog title="Eliminar gasto" onConfirm={onConfirm} onClose={onClose}>
        ¿Eliminar?
      </ConfirmDialog>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
