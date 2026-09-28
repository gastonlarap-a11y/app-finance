import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ColorPicker, IconPicker } from '../ui'

function Colors({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <ColorPicker value={value} onChange={setValue} auto="teal" />
      <output>{value === '' ? 'auto' : value}</output>
    </>
  )
}

function Icons() {
  const [value, setValue] = useState('')
  return (
    <>
      <IconPicker value={value} onChange={setValue} auto="shopping-cart" color="green" />
      <output>{value === '' ? 'auto' : value}</output>
    </>
  )
}

describe('ColorPicker', () => {
  it('is a named radio group that starts on Automático', async () => {
    await render(<Colors />)
    await expect.element(page.getByRole('group', { name: 'Color' })).toBeVisible()
    await expect.element(page.getByRole('radio', { name: 'Automático' })).toBeChecked()
    await expect.element(page.getByRole('radio', { name: 'Azul' })).not.toBeChecked()
  })

  it('selects by click and moves with the arrow keys', async () => {
    await render(<Colors />)
    await page.getByRole('radio', { name: 'Rojo' }).click()
    await expect.element(page.getByRole('status')).toHaveTextContent('red')
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('radio', { name: 'Naranjo' })).toHaveFocus()
    await expect.element(page.getByRole('status')).toHaveTextContent('orange')
  })

  it('shows a saved choice as checked', async () => {
    await render(<Colors initial="indigo" />)
    await expect.element(page.getByRole('radio', { name: 'Índigo' })).toBeChecked()
  })
})

describe('IconPicker', () => {
  it('previews what Automático resolves to', async () => {
    await render(<Icons />)
    await expect.element(page.getByRole('radio', { name: 'Automático (Carro de supermercado)' })).toBeChecked()
  })

  it('filters by the Spanish name, ignoring accents', async () => {
    await render(<Icons />)
    await page.getByRole('searchbox', { name: 'Buscar ícono' }).fill('avion')
    await expect.element(page.getByRole('radio', { name: 'Avión' })).toBeVisible()
    await expect.element(page.getByRole('radio', { name: 'Casa' })).not.toBeInTheDocument()
    await page.getByRole('radio', { name: 'Avión' }).click()
    await expect.element(page.getByRole('status')).toHaveTextContent('plane')
  })

  it('says so when nothing matches', async () => {
    await render(<Icons />)
    await page.getByRole('searchbox', { name: 'Buscar ícono' }).fill('zzz')
    await expect.element(page.getByText('Ningún ícono coincide.')).toBeVisible()
  })
})
