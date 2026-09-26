import { describe, expect, it } from 'vitest'
import { fetchUFValues, parseSeries } from '@/lib/uf'

// Shape of https://mindicador.cl/api/uf/2026 (trimmed).
const year2026 = {
  version: '1.7.0',
  codigo: 'uf',
  serie: [
    { fecha: '2026-10-09T03:00:00.000Z', valor: 41130.94 },
    { fecha: '2026-10-01T03:00:00.000Z', valor: 41065.37 },
    { fecha: '2026-09-02T04:00:00.000Z', valor: 40883.28 },
    { fecha: '2026-09-01T04:00:00.000Z', valor: 40875.09 },
    { fecha: '2026-08-01T04:00:00.000Z', valor: 40600 },
  ],
}

describe('parseSeries', () => {
  it('keeps only day 1 of each month, with two decimals', () => {
    expect(parseSeries(year2026)).toEqual([
      { period: '2026-10', value: '41065.37' },
      { period: '2026-09', value: '40875.09' },
      { period: '2026-08', value: '40600.00' },
    ])
  })

  it('ignores malformed bodies and entries', () => {
    expect(parseSeries(null)).toEqual([])
    expect(parseSeries({ serie: 'x' })).toEqual([])
    expect(
      parseSeries({ serie: [{ fecha: '2026-09-01T04:00:00.000Z', valor: 'x' }, { fecha: 5, valor: 1 }, { valor: 1 }, { fecha: '2026-09-01T04:00:00.000Z', valor: -3 }] }),
    ).toEqual([])
  })
})

describe('fetchUFValues', () => {
  it('asks once per year and returns only the wanted months', async () => {
    const urls: string[] = []
    const fake = ((url: string) => {
      urls.push(url)
      return Promise.resolve(new Response(JSON.stringify(year2026), { status: 200 }))
    }) as unknown as typeof fetch // a stand-in for the network: only the URL is read
    const got = await fetchUFValues(['2026-09', '2026-10', '2026-11'], fake)
    expect(urls).toEqual(['https://mindicador.cl/api/uf/2026'])
    expect(got).toEqual([
      { period: '2026-10', value: '41065.37' },
      { period: '2026-09', value: '40875.09' },
    ])
  })

  it('fails on an HTTP error instead of storing nothing silently', async () => {
    const down = (() => Promise.resolve(new Response('busy', { status: 503 }))) as unknown as typeof fetch // stand-in
    await expect(fetchUFValues(['2026-09'], down)).rejects.toThrow('503')
  })
})
