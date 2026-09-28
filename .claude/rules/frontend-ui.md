---
paths:
  - "frontend/src/components/**"
  - "frontend/src/lib/route.ts"
  - "frontend/src/App.tsx"
  - "frontend/src/main.tsx"
  - "frontend/src/index.css"
---

# Frontend UI rules

- **Colors**: only the semantic tokens of `src/index.css` (`bg-panel`, `text-fg-muted`,
  `ring-line`, `text-negative-fg`, `bg-caution-soft`…). Never raw palette colors, black/white or the
  legacy names (`surface`, `primary`, `danger`…): `src/styles/rawclasses.test.ts` fails on them.
  Check every screen in both themes (Configuración › Apariencia). A new token needs a light value in `@theme`, a dark one in `:root[data-theme='dark']`, and its
  text/background pairs in `src/styles/tokens.test.ts`.
- **Primitives first** (`src/components/ui/`): `Button`/`IconButton` (never a bare styled
  `<button>`), `Callout` for inline messages, `Badge` for statuses, `EmptyState` with an action for
  empty lists, `Skeleton`/`SkeletonRows` for loading (not "Cargando…"), `ConfirmAction` for
  destructive actions, `Menu` for row actions, `SegmentedControl`/`Tabs` for choices, `Field` +
  `Input`/`Select`/`MoneyInput`, `Switch` for immediate on/off settings, `tbl` for tables.
- **Personalization**: a category/card/goal shows its look through `lib/look.ts`
  (`categoryLook`, `cardColor`, `goalLook`, `categoryLooks()` for names) and `LookIcon`/`ColorDot`;
  color only via `data-look` + `text-(--look)`/`bg-(--look-soft)`, never a class built from a key.
- **Icons**: `lucide-react` static named imports, `aria-hidden="true"` next to visible text;
  icon-only controls go through `IconButton` or `Menu` (mandatory label). No emoji/Unicode glyphs
  as icons, and no ✓/⚠ inside `notify()` text (the toast's icon states the tone).
- **Touch**: nothing only in `title=` — use visible text or `Toggletip`. Targets ≥ 24px with a
  mouse and 44px on `pointer: coarse` (the primitives already do it).
- **Every async view** ships loading (skeleton), empty (reason + action), error (`QueryError`
  with retry) and stale (dimmed, `aria-busy`) states.
- **Navigation**: link screens with `<Link to={route}>` / `navigate(route)` (`lib/route.ts`,
  `lib/useRoute.ts`), never "la pestaña X" in copy. A new Configuración section = a
  `ConfigSection` in `lib/route.ts` + its entry in `components/config/sections.tsx`. Each screen's
  title comes from `components/shell/nav.ts` (the shell renders the `PageHeader`).
- **Tests**: interactive behavior (focus, keyboard, dialogs, popovers) in `*.dom.test.tsx`
  (vitest browser project, real Chromium; mock `@/services/*` with `vi.mock`); pure logic in
  `*.test.ts` (Node).
