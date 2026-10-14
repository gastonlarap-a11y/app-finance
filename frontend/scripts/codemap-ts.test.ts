import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { extract, type Extract } from './codemap-ts'

const ROOT = '/proj'

// A miniature of the app: a contract, its desktop wrapper over Wails
// bindings, the web engine implementing it, and a component calling it.
const FILES: Record<string, string> = {
  'src/services/contract.ts': `
export interface ItemResult { error?: string }
export interface ShopServiceContract {
  AddItem(name: string): Promise<ItemResult>
  RemoveCart(id: number): Promise<ItemResult>
}`,
  'src/services/shop.ts': `
import { ShopService as Bound } from '@/../bindings/example.com/app/backend/shop'
import type { ShopServiceContract } from '@/services/contract'
export const ShopService: ShopServiceContract = Bound`,
  'src/services/reports.ts': `
import { ReportsService } from '@/../bindings/example.com/app/backend/reports'
export function saveTable(name: string) {
  return ReportsService.SaveTable(name)
}`,
  'src/engine/service.ts': `
import type { ShopServiceContract } from '@/services/contract'
interface SqlDb { exec(sql: string, params?: unknown[]): void }
export function createShopService(db: SqlDb): ShopServiceContract {
  // insertItem writes one row. Never more.
  function insertItem(name: string): void {
    db.exec('INSERT INTO items (name) VALUES (?)', [name])
  }
  const service: ShopServiceContract = {
    async AddItem(name: string) { insertItem(name); return {} },
    RemoveCart: async (id: number) => {
      const table = 'carts'
      db.exec(\`UPDATE \${table} SET deleted = 1 WHERE id = ?\`, [id])
      return {}
    },
  }
  return service
}`,
  'src/components/CartForm.tsx': `
import { ShopService } from '@/services/shop'
export function useCart() { return 1 }
export function CartForm() {
  const count = useCart()
  async function submit(name: string) { await ShopService.AddItem(name) }
  const onReset = () => count
  return <button onClick={() => void submit('x')} onReset={onReset}>Add</button>
}
export function App() { return <CartForm /> }`,
  'src/engine/service.test.ts': `
import { createShopService } from '@/engine/service'
void createShopService({ exec() {} }).AddItem('x')`,
}

function buildProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noLib: true,
    types: [],
    baseUrl: ROOT,
    paths: { '@/*': ['src/*'] },
  }
  const sources = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]))
  const host = ts.createCompilerHost(options)
  host.fileExists = (f) => sources.has(f)
  host.readFile = (f) => sources.get(f)
  host.getSourceFile = (f, lang) => {
    const text = sources.get(f)
    return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true)
  }
  host.getCurrentDirectory = () => ROOT
  host.directoryExists = (d) => [...sources.keys()].some((k) => k.startsWith(d + '/'))
  host.getDirectories = () => []
  host.realpath = (p) => p
  return ts.createProgram([...sources.keys()], options, host)
}

const id = (file: string, name?: string) => (name ? `ts:${file}#${name}` : `ts:${file}`)
const CONTRACT_ADD = id('src/services/contract.ts', 'ShopServiceContract.AddItem')
const ENGINE = 'src/engine/service.ts'
const FORM = 'src/components/CartForm.tsx'

describe('codemap-ts extract', () => {
  const out: Extract = extract(buildProgram(FILES), ROOT)
  const kindOf = (symbolId: string) => out.symbols.find((s) => s.id === symbolId)?.kind
  const hasEdge = (from: string, to: string, kind: string) =>
    out.edges.some((e) => e.from === from && e.to === to && e.kind === kind)

  it('classifies symbols', () => {
    expect(kindOf(CONTRACT_ADD)).toBe('contractMethod')
    expect(kindOf(id(FORM, 'CartForm'))).toBe('component')
    expect(kindOf(id(FORM, 'useCart'))).toBe('hook')
    expect(kindOf(id(FORM, 'CartForm.submit'))).toBe('function')
    expect(kindOf(id(ENGINE, 'createShopService.service.AddItem'))).toBe('engineMethod')
    expect(kindOf(id(ENGINE, 'createShopService.service.RemoveCart'))).toBe('engineMethod')
    expect(kindOf(id('src/engine/service.test.ts'))).toBe('testFile')
  })

  it('keeps the first sentence of the comment above a declaration', () => {
    expect(out.symbols.find((s) => s.id === id(ENGINE, 'createShopService.insertItem'))?.doc).toBe('insertItem writes one row.')
  })

  it('resolves calls through the contract type, JSX renders and function references', () => {
    expect(hasEdge(id(FORM, 'CartForm.submit'), CONTRACT_ADD, 'call')).toBe(true)
    expect(hasEdge(id(FORM, 'CartForm'), id(FORM, 'CartForm.submit'), 'call')).toBe(true) // inside an anonymous callback
    expect(hasEdge(id(FORM, 'CartForm'), id(FORM, 'useCart'), 'call')).toBe(true)
    expect(hasEdge(id(FORM, 'CartForm'), id(FORM, 'CartForm.onReset'), 'ref')).toBe(true)
    expect(hasEdge(id(FORM, 'App'), id(FORM, 'CartForm'), 'render')).toBe(true)
    expect(hasEdge(id(ENGINE, 'createShopService.service.AddItem'), id(ENGINE, 'createShopService.insertItem'), 'call')).toBe(true)
    expect(hasEdge(id('src/engine/service.test.ts'), CONTRACT_ADD, 'call')).toBe(true)
  })

  it('links contract members to their web implementation and to the Go binding', () => {
    expect(out.implementations).toContainEqual({ impl: id(ENGINE, 'createShopService.service.AddItem'), contract: CONTRACT_ADD })
    expect(out.bindings).toEqual([
      { contract: id('src/services/contract.ts', 'ShopServiceContract'), goPkg: 'example.com/app/backend/shop', goType: 'ShopService' },
    ])
    expect(out.bindingCalls).toEqual([
      expect.objectContaining({ from: id('src/services/reports.ts', 'saveTable'), goPkg: 'example.com/app/backend/reports', goType: 'ReportsService', method: 'SaveTable' }),
    ])
  })

  it('hands SQL and table names to Go, with run-time names as placeholders', () => {
    const sqlOf = (from: string) => out.sql.filter((s) => s.from === from).map((s) => s.text)
    expect(sqlOf(id(ENGINE, 'createShopService.insertItem'))).toEqual(['INSERT INTO items (name) VALUES (?)'])
    expect(sqlOf(id(ENGINE, 'createShopService.service.RemoveCart'))).toEqual(['carts', 'UPDATE ? SET deleted = 1 WHERE id = ?'])
    expect(out.sql.some((s) => s.text.includes('bindings'))).toBe(false) // import specifiers are not SQL
  })
})
