import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Modal } from '../ui'

describe('Modal', () => {
  it('opens as a modal dialog and focuses its first field', async () => {
    await render(
      <Modal title="Nueva tarjeta" onClose={() => {}}>
        <label>
          Nombre <input />
        </label>
      </Modal>,
    )
    await expect.element(page.getByRole('dialog', { name: 'Nueva tarjeta' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: 'Nombre' })).toHaveFocus()
  })

  it('calls onClose on Escape instead of closing itself', async () => {
    const onClose = vi.fn()
    await render(
      <Modal title="Editar" onClose={onClose}>
        <input aria-label="Monto" />
      </Modal>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    // React owns the lifecycle: the dialog stays until the parent unmounts it.
    await expect.element(page.getByRole('dialog', { name: 'Editar' })).toBeVisible()
  })

  it('closes from its labelled close button', async () => {
    const onClose = vi.fn()
    await render(
      <Modal title="Editar" onClose={onClose}>
        <p>contenido</p>
      </Modal>,
    )
    await page.getByRole('button', { name: 'Cerrar' }).click()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
