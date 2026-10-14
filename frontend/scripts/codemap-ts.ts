// codemap-ts: the TypeScript half of tools/codemap's index (see
// tools/codemap/internal/index/ts.go, which runs this file and decodes its JSON).
//
// It builds one program from the frontend tsconfig and lets the type checker
// resolve every call, JSX tag and function reference to its declaration, so
// `FinanceService.CreateExpense(…)` in a component lands on the contract member
// in services/contract.ts — the hub codemap links to the Go bound method
// (desktop) and to the web engine's implementation.
//
//   node frontend/scripts/codemap-ts.ts --codemap-emit <tsconfig.json> --root <repo root>
//
// Node runs this file directly (type stripping): keep to erasable syntax (no
// enums, namespaces or parameter properties) and to the `ts.sys` API, so it
// needs neither a build step nor @types/node.
import ts from 'typescript'

export const EXTRACT_VERSION = 1

export type SymbolKind =
  | 'module'
  | 'testFile'
  | 'function'
  | 'component'
  | 'hook'
  | 'method'
  | 'class'
  | 'interface'
  | 'contractMethod'
  | 'engineMethod'

export interface Pos {
  file: string
  line: number
  endLine: number
}

export interface TsSymbol {
  id: string
  name: string
  kind: SymbolKind
  pos: Pos
  parent?: string
  signature?: string
  doc?: string
}

export interface TsEdge {
  from: string
  to: string
  kind: 'call' | 'ref' | 'render'
  at: Pos
}

// TsImplementation: an object-literal method that implements a contract member
// (the web engine, or a web stand-in such as services/web/settings.ts).
export interface TsImplementation {
  impl: string
  contract: string
}

// TsBinding: a contract interface that a desktop wrapper satisfies with the
// Wails binding of one Go type (`export const X: XContract = Bound`).
export interface TsBinding {
  contract: string
  goPkg: string
  goType: string
}

// TsBindingCall: a direct call into Wails bindings (services without a contract).
export interface TsBindingCall {
  from: string
  goPkg: string
  goType: string
  method: string
  at: Pos
}

// TsSql: a string a symbol uses that may be SQL or a table name; Go classifies it.
export interface TsSql {
  from: string
  text: string
  at: Pos
}

export interface Extract {
  version: number
  symbols: TsSymbol[]
  edges: TsEdge[]
  implementations: TsImplementation[]
  bindings: TsBinding[]
  bindingCalls: TsBindingCall[]
  sql: TsSql[]
}

const CONTRACT_SUFFIX = 'ServiceContract'
const BINDINGS_RE = /(?:^|\/)bindings\/(.+)$/
const TEST_FILE_RE = /\.test\.tsx?$/
const SQL_HINT_RE = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|INTO|CREATE)\b/
const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/
const FUNCTION_KINDS = new Set<SymbolKind>(['function', 'component', 'hook', 'method', 'engineMethod'])

interface Scope {
  id: string
  qual: string
}

interface BindingImport {
  goPkg: string
  goType: string
}

interface Pending {
  from: string
  decl: ts.Node
  kind: TsEdge['kind']
  at: Pos
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

function isFunctionLike(node: ts.Node | undefined): node is FunctionLike {
  return (
    node !== undefined &&
    (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
  )
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

// extract walks every source file of program under root (minus dependencies
// and generated bindings) and returns its symbols and relations.
export function extract(program: ts.Program, root: string): Extract {
  const checker = program.getTypeChecker()
  const rootDir = root.endsWith('/') ? root : root + '/'
  const out: Extract = {
    version: EXTRACT_VERSION,
    symbols: [],
    edges: [],
    implementations: [],
    bindings: [],
    bindingCalls: [],
    sql: [],
  }
  // Declaration node → symbol id; filled while walking, read at the end, so
  // an edge may point at a file not walked yet.
  const ids = new Map<ts.Node, string>()
  const kinds = new Map<string, SymbolKind>()
  const pending: Pending[] = []
  const pendingImpls: { impl: string; decl: ts.Node }[] = []
  const pendingBindings: { decl: ts.Node; goPkg: string; goType: string }[] = []

  const relative = (fileName: string) => fileName.slice(rootDir.length)
  const files = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && sf.fileName.startsWith(rootDir))
    .filter((sf) => !/(^|\/)(node_modules|bindings)\//.test(relative(sf.fileName)))

  for (const sf of files) walkFile(sf)

  const seen = new Set<string>()
  for (const p of pending) {
    const to = ids.get(p.decl)
    if (!to || to === p.from) continue
    if (p.kind === 'ref' && !FUNCTION_KINDS.has(kinds.get(to) ?? 'module')) continue
    const key = `${p.from}|${to}|${p.kind}|${p.at.file}:${p.at.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.edges.push({ from: p.from, to, kind: p.kind, at: p.at })
  }
  for (const p of pendingImpls) {
    const contract = ids.get(p.decl)
    if (contract) out.implementations.push({ impl: p.impl, contract })
  }
  for (const p of pendingBindings) {
    const contract = ids.get(p.decl)
    if (contract) out.bindings.push({ contract, goPkg: p.goPkg, goType: p.goType })
  }
  return out

  function walkFile(sf: ts.SourceFile): void {
    const rel = relative(sf.fileName)
    const isTest = TEST_FILE_RE.test(rel)
    const isTsx = rel.endsWith('.tsx')
    const moduleScope: Scope = { id: `ts:${rel}`, qual: '' }
    addSymbol({ id: moduleScope.id, name: rel, kind: isTest ? 'testFile' : 'module', pos: posOf(sf) })
    const bindingImports = new Map<string, BindingImport>()
    const handled = new Set<ts.Node>()

    visit(sf, moduleScope)

    function posOf(node: ts.Node): Pos {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line
      return { file: rel, line: start + 1, endLine: end + 1 }
    }

    function addSymbol(s: TsSymbol): void {
      if (kinds.has(s.id)) return // a redeclaration (overload, same name in another block): keep the first
      kinds.set(s.id, s.kind)
      out.symbols.push(s)
    }

    // declare registers a named symbol for decl (and its function node, so a
    // reference to either resolves) and returns the scope of its body.
    function declare(decl: ts.Node, name: string, kind: SymbolKind, scope: Scope, signature?: string): Scope {
      const qual = scope.qual ? `${scope.qual}.${name}` : name
      const id = `ts:${rel}#${qual}`
      addSymbol({
        id,
        name: qual,
        kind,
        pos: posOf(decl),
        parent: scope.qual ? scope.id : undefined,
        signature,
        doc: docOf(decl),
      })
      ids.set(decl, id)
      return { id, qual }
    }

    function functionKind(name: string): SymbolKind {
      if (/^use[A-Z0-9]/.test(name)) return 'hook'
      if (isTsx && /^[A-Z]/.test(name)) return 'component'
      return 'function'
    }

    function signatureOf(name: string, fn: FunctionLike): string {
      const params = fn.parameters.map((p) => p.getText(sf)).join(', ')
      const ret = fn.type ? `: ${fn.type.getText(sf)}` : ''
      return oneLine(`${name}(${params})${ret}`)
    }

    // docOf is the comment block right above a declaration, first sentence only.
    function docOf(decl: ts.Node): string | undefined {
      const anchor = ts.isVariableDeclaration(decl) && ts.isVariableStatement(decl.parent.parent) ? decl.parent.parent : decl
      const start = anchor.getStart(sf)
      const ranges = ts.getLeadingCommentRanges(sf.text, anchor.getFullStart()) ?? []
      const block: string[] = []
      let next = start
      for (let i = ranges.length - 1; i >= 0; i--) {
        const r = ranges[i]
        if (!r || (sf.text.slice(r.end, next).match(/\n/g) ?? []).length > 1) break
        block.unshift(sf.text.slice(r.pos, r.end))
        next = r.pos
      }
      if (block.length === 0) return undefined
      const text = oneLine(block.join(' ').replace(/^\s*(\/\/+|\/\*+|\*\/|\*)/gm, ' ').replace(/\/\/|\/\*+|\*\//g, ' '), 400)
      const dot = text.indexOf('. ')
      return oneLine(dot >= 0 ? text.slice(0, dot + 1) : text, 240)
    }

    function resolveDecls(node: ts.Node): ts.Node[] {
      let sym =
        ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node)
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
      return sym?.declarations ?? []
    }

    function link(from: Scope, target: ts.Node, kind: TsEdge['kind'], at: ts.Node): void {
      for (const decl of resolveDecls(target)) pending.push({ from: from.id, decl, kind, at: posOf(at) })
    }

    function contractOf(obj: ts.ObjectLiteralExpression): ts.Type | undefined {
      if (isTest) return undefined
      const t = checker.getContextualType(obj)
      const sym = t?.aliasSymbol ?? t?.getSymbol()
      return sym?.name.endsWith(CONTRACT_SUFFIX) ? t : undefined
    }

    // visitObject declares the methods of an object literal under prefix; one
    // typed as a *ServiceContract is an implementation of that contract.
    function visitObject(obj: ts.ObjectLiteralExpression, scope: Scope, prefix: string): void {
      const contract = contractOf(obj)
      for (const prop of obj.properties) {
        const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : undefined
        const fn = ts.isMethodDeclaration(prop) ? prop : ts.isPropertyAssignment(prop) ? prop.initializer : undefined
        if (!name || !isFunctionLike(fn)) {
          visit(prop, scope)
          continue
        }
        const kind: SymbolKind = contract ? 'engineMethod' : 'method'
        const inner = declare(prop, name, kind, { id: scope.id, qual: prefix }, signatureOf(name, fn))
        if (fn !== prop) ids.set(fn, inner.id)
        if (contract) {
          const member = contract.getProperty(name)?.declarations?.[0]
          if (member) pendingImpls.push({ impl: inner.id, decl: member })
        }
        if (fn.body) visit(fn.body, inner)
      }
    }

    function visitVariable(decl: ts.VariableDeclaration, scope: Scope): boolean {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) return false
      const name = decl.name.text
      const init = decl.initializer
      if (isFunctionLike(init)) {
        const inner = declare(decl, name, functionKind(name), scope, signatureOf(name, init))
        ids.set(init, inner.id)
        visit(init.body, inner)
        return true
      }
      // memo(…), forwardRef(…), useCallback(…), atom(async (get) => …):
      // the variable names the function it wraps.
      if (ts.isCallExpression(init) && init.arguments.some(isFunctionLike)) {
        const inner = declare(decl, name, functionKind(name), scope, oneLine(`${name} = ${init.expression.getText(sf)}(…)`))
        visit(init, inner)
        return true
      }
      if (ts.isObjectLiteralExpression(init)) {
        visitObject(init, scope, scope.qual ? `${scope.qual}.${name}` : name)
        return true
      }
      return false
    }

    function visit(node: ts.Node, scope: Scope): void {
      if (ts.isImportDeclaration(node)) {
        recordBindingImport(node)
        return
      }
      if (ts.isExportDeclaration(node)) return
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text
        const inner = declare(node, name, functionKind(name), scope, signatureOf(name, node))
        if (node.body) visit(node.body, inner)
        return
      }
      if (ts.isVariableDeclaration(node)) {
        recordBinding(node)
        if (visitVariable(node, scope)) return
      }
      if (ts.isObjectLiteralExpression(node)) {
        visitObject(node, scope, scope.qual)
        return
      }
      if (ts.isClassDeclaration(node) && node.name) {
        visitClass(node, scope)
        return
      }
      if (ts.isInterfaceDeclaration(node)) {
        visitInterface(node, scope)
        return
      }
      if (ts.isCallExpression(node)) recordCall(node, scope)
      else if (ts.isNewExpression(node)) link(scope, node.expression, 'call', node)
      else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = ts.isPropertyAccessExpression(node.tagName) ? node.tagName.name : node.tagName
        handled.add(tag)
        // Lower-case tags are DOM elements, not components.
        if (/^[A-Z]/.test(tag.getText(sf))) link(scope, tag, 'render', node)
      } else if (ts.isIdentifier(node)) recordRef(node, scope)
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) recordString(node, node.text, scope)
      else if (ts.isTemplateExpression(node)) {
        // `${table}` becomes "?": Go reads a placeholder in a table slot as a
        // table name only known at run time.
        recordString(node, node.head.text + node.templateSpans.map((s) => '?' + s.literal.text).join(''), scope)
      }
      ts.forEachChild(node, (child) => visit(child, scope))
    }

    function visitClass(node: ts.ClassDeclaration, scope: Scope): void {
      const className = node.name?.text ?? 'default'
      const inner = declare(node, className, 'class', scope, `class ${className}`)
      for (const member of node.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : ts.isConstructorDeclaration(member) ? 'constructor' : undefined
        const fn = ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)
          ? member
          : ts.isPropertyDeclaration(member) && isFunctionLike(member.initializer) ? member.initializer : undefined
        if (!name || !fn) {
          visit(member, inner)
          continue
        }
        const m = declare(member, name, 'method', inner, oneLine(`${name}(${fn.parameters.map((p) => p.getText(sf)).join(', ')})`))
        if (fn !== member) ids.set(fn, m.id)
        if (fn.body) visit(fn.body, m)
      }
    }

    function visitInterface(node: ts.InterfaceDeclaration, scope: Scope): void {
      const name = node.name.text
      const inner = declare(node, name, 'interface', scope, `interface ${name}`)
      if (!name.endsWith(CONTRACT_SUFFIX)) return
      for (const member of node.members) {
        if ((ts.isMethodSignature(member) || ts.isPropertySignature(member)) && ts.isIdentifier(member.name)) {
          declare(member, member.name.text, 'contractMethod', inner, oneLine(member.getText(sf)))
        }
      }
    }

    function recordBindingImport(node: ts.ImportDeclaration): void {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''
      const m = BINDINGS_RE.exec(spec)
      const named = node.importClause?.namedBindings
      if (!m?.[1] || !named || !ts.isNamedImports(named)) return
      for (const el of named.elements) {
        bindingImports.set(el.name.text, { goPkg: m[1], goType: (el.propertyName ?? el.name).text })
      }
    }

    // recordBinding: `export const FinanceService: FinanceServiceContract = Bound`.
    function recordBinding(decl: ts.VariableDeclaration): void {
      if (!decl.initializer || !ts.isIdentifier(decl.initializer) || !decl.type || !ts.isTypeReferenceNode(decl.type)) return
      const b = bindingImports.get(decl.initializer.text)
      const iface = resolveDecls(decl.type.typeName)[0]
      if (b && iface) pendingBindings.push({ decl: iface, goPkg: b.goPkg, goType: b.goType })
    }

    function recordCall(call: ts.CallExpression, scope: Scope): void {
      const callee = call.expression
      const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined
      if (!nameNode) return
      handled.add(nameNode)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const b = bindingImports.get(callee.expression.text)
        if (b) {
          out.bindingCalls.push({ from: scope.id, goPkg: b.goPkg, goType: b.goType, method: callee.name.text, at: posOf(call) })
          return
        }
      }
      link(scope, nameNode, 'call', call)
    }

    function recordRef(id: ts.Identifier, scope: Scope): void {
      if (handled.has(id)) return
      const parent = id.parent
      if (ts.isShorthandPropertyAssignment(parent)) {
        link(scope, id, 'ref', id) // `{ onSave }` passes the function onSave
        return
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === id) return // the object, not a function
      if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return
      // A declaration's own name is not a reference. Every named node keeps it
      // in `name` (ts.NamedDeclaration), so reading the field untyped covers the
      // ~20 declaration kinds at once.
      if ((parent as { name?: ts.Node }).name === id) return
      link(scope, id, 'ref', id)
    }

    function recordString(node: ts.Node, text: string, scope: Scope): void {
      const parent = node.parent
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isJsxAttribute(parent) || ts.isLiteralTypeNode(parent)) return
      if (!SQL_HINT_RE.test(text) && !TABLE_NAME_RE.test(text)) return
      out.sql.push({ from: scope.id, text, at: posOf(node) })
    }
  }
}

// main runs only with --codemap-emit, so importing this module (tests) is inert.
function main(args: readonly string[]): void {
  const at = args.indexOf('--codemap-emit')
  if (at < 0) return
  const tsconfig = args[at + 1]
  const rootAt = args.indexOf('--root')
  const root = rootAt >= 0 ? args[rootAt + 1] : undefined
  if (!tsconfig || !root) throw new Error('usage: codemap-ts.ts --codemap-emit <tsconfig.json> --root <dir>')
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    },
  })
  if (!parsed) throw new Error(`cannot read ${tsconfig}`)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } })
  ts.sys.write(JSON.stringify(extract(program, ts.sys.resolvePath(root))))
}

main(ts.sys.args)
