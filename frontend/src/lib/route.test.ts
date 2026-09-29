import { describe, expect, it } from 'vitest'
import { CONFIG_SECTIONS, formatHash, parseHash, type Route } from './route'

describe('parseHash', () => {
  it.each([
    ['', { page: 'resumen' }],
    ['#', { page: 'resumen' }],
    ['#/', { page: 'resumen' }],
    ['#/resumen', { page: 'resumen' }],
    ['#/anio', { page: 'anio' }],
    ['#/proyeccion', { page: 'proyeccion' }],
    ['#/fijos', { page: 'fijos' }],
    ['#/ahorro', { page: 'ahorro' }],
    ['#/importar', { page: 'importar', tab: 'bandeja' }],
    ['#/importar/estados', { page: 'importar', tab: 'estados' }],
    ['#/importar/otra', { page: 'importar', tab: 'bandeja' }],
    ['#/buscar', { page: 'buscar', q: '' }],
    ['#/buscar?q=caf%C3%A9%20jumbo', { page: 'buscar', q: 'café jumbo' }],
    ['#/config', { page: 'config', section: null }],
    ['#/config/tarjetas', { page: 'config', section: 'tarjetas' }],
    ['#/config/nada', { page: 'config', section: null }],
    // The bank-email section was removed: a saved link opens the list.
    ['#/config/correo', { page: 'config', section: null }],
    ['#/mes', { page: 'resumen' }],
    ['#/no-existe/x', { page: 'resumen' }],
  ] as const)('%s', (hash, want) => {
    expect(parseHash(hash, false)).toEqual(want)
  })

  it('sends desktop-only sections to the Configuración list on the web build', () => {
    expect(parseHash('#/config/actualizaciones', true)).toEqual({ page: 'config', section: null })
    expect(parseHash('#/config/actualizaciones', false)).toEqual({ page: 'config', section: 'actualizaciones' })
    expect(parseHash('#/config/respaldo', true)).toEqual({ page: 'config', section: 'respaldo' })
  })
})

describe('formatHash', () => {
  const routes: Route[] = [
    { page: 'resumen' },
    { page: 'importar', tab: 'bandeja' },
    { page: 'importar', tab: 'estados' },
    { page: 'buscar', q: '' },
    { page: 'buscar', q: 'café & jumbo' },
    { page: 'anio' },
    { page: 'proyeccion' },
    { page: 'fijos' },
    { page: 'ahorro' },
    { page: 'config', section: null },
    ...CONFIG_SECTIONS.map((section): Route => ({ page: 'config', section })),
  ]

  it.each(routes)('round-trips %o', (route) => {
    expect(parseHash(formatHash(route), false)).toEqual(route)
  })

  it('writes readable hashes', () => {
    expect(formatHash({ page: 'importar', tab: 'bandeja' })).toBe('#/importar')
    expect(formatHash({ page: 'config', section: 'tarjetas' })).toBe('#/config/tarjetas')
    expect(formatHash({ page: 'buscar', q: 'café' })).toBe('#/buscar?q=caf%C3%A9')
  })
})
