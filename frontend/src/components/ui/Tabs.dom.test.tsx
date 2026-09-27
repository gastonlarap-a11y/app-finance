import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { SegmentedControl, Switch, TabPanel, Tabs } from '../ui'

type Horizon = '6' | '12' | '24'
const HORIZONS = [
  { value: '6', label: '6 meses' },
  { value: '12', label: '12 meses' },
  { value: '24', label: '24 meses' },
] as const

function Horizon() {
  const [value, setValue] = useState<Horizon>('12')
  return (
    <>
      <SegmentedControl label="Horizonte" value={value} options={HORIZONS} onChange={setValue} />
      <output>{value}</output>
    </>
  )
}

describe('SegmentedControl', () => {
  it('is a single tab stop on the selected option', async () => {
    await render(<Horizon />)
    await expect.element(page.getByRole('radio', { name: '12 meses' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.tab()
    await expect.element(page.getByRole('radio', { name: '12 meses' })).toHaveFocus()
  })

  it('selects with the arrow keys and wraps around', async () => {
    await render(<Horizon />)
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('radio', { name: '24 meses' })).toHaveFocus()
    await expect.element(page.getByRole('status')).toHaveTextContent('24')
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('radio', { name: '6 meses' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{End}')
    await expect.element(page.getByRole('status')).toHaveTextContent('24')
  })
})

type Seg = 'bandeja' | 'estados'

function Importar() {
  const [tab, setTab] = useState<Seg>('bandeja')
  const tabs = [
    { value: 'bandeja', label: 'Bandeja' },
    { value: 'estados', label: 'Estados de cuenta' },
  ] as const
  return (
    <>
      <Tabs label="Importar" idBase="imp" value={tab} tabs={tabs} onChange={setTab} />
      <TabPanel idBase="imp" value={tab}>
        {tab === 'bandeja' ? 'Movimientos por revisar' : 'Tus estados de cuenta'}
      </TabPanel>
    </>
  )
}

describe('Tabs', () => {
  it('labels the panel with the selected tab and switches with arrows', async () => {
    await render(<Importar />)
    await expect.element(page.getByRole('tabpanel', { name: 'Bandeja' })).toHaveTextContent('Movimientos por revisar')
    await page.getByRole('tab', { name: 'Bandeja' }).click()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('tab', { name: 'Estados de cuenta' })).toHaveAttribute('aria-selected', 'true')
    await expect.element(page.getByRole('tabpanel', { name: 'Estados de cuenta' })).toHaveTextContent('Tus estados de cuenta')
  })
})

function BackupOnClose() {
  const [on, setOn] = useState(false)
  return <Switch label="Respaldar al cerrar" description="Sube una copia cada vez que cierras la app" checked={on} onChange={setOn} />
}

describe('Switch', () => {
  it('toggles and exposes its state by name', async () => {
    await render(<BackupOnClose />)
    const toggle = page.getByRole('switch', { name: 'Respaldar al cerrar' })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.element(toggle).toHaveAccessibleDescription('Sube una copia cada vez que cierras la app')
  })
})
