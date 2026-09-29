---
paths:
  - "backend/finance/**"
  - "backend/users/**"
  - "frontend/src/engine/**"
---

# Finance domain invariants

Each rule holds in Go and in the web engine alike (Go⇄TS parity: `AGENTS.md`).

- **`finance`** (`backend/finance/`) is the core domain — one file per entity plus `period.go`
  (YYYY-MM math), `result.go` (view models) and `service.go` (bound methods + summaries).
  Per-month values resolve by lexical `period` string comparison; fixed expenses use
  effective-dated overrides + sparse payments (`backend/finance/fixedexpense.go`).
- **`users`** (`backend/users/`) = multi-user profiles, no login: one shared SQLite DB, every
  finance row carries `user_id`, active id in the in-memory `users.Session`.
- **Savings contributions are a monthly outflow**: they lower `Disponible`/`Balance` and the carried
  balance (`cumulativeBalanceBefore`) but are reported as `Ahorro`, apart from `Gastos`, and never
  count against category budgets. Contributions of a trashed goal are excluded everywhere
  (`liveGoalContributions`), like installments of a deleted expense. A withdrawal is a negative
  contribution (`WithdrawSavings`); a goal's balance never goes below zero.
- **Carried balance restarts at a reconciliation**: `cumulativeBalanceBefore` = latest
  `reconciliations` row before the month (real closing balance; the opening balance is one on the
  month before the first) + `flowsBetween` it and the month. Any new monthly flow must be added to
  `flowsBetween` (Go and TS) and to the year/forecast loops, which reset at a reconciled close.
- **Fixed-expense charges go through `fixedCharge`** (Go `uf.go`, TS `engine/finance/fixedexpense.ts`):
  a fixed expense bills only where `billsIn` (its `interval_months` schedule) and converts UF amounts
  with that month's `uf_values` row. Never read `resolveAsOf` of a fixed expense as a peso charge.
  UF values are downloaded by the frontend (`lib/uf.ts`, mindicador.cl), never by the backend.
- **Effective-dated values** (fixed-expense amounts, category budgets): rows apply from
  `effective_from` onward; resolve with `latestAsOf`/`resolveAsOf`, sum ranges with `sumAsOf`
  (`backend/finance/fixedexpense.go`, mirrored in `frontend/src/engine/finance/fixedexpense.ts`).
- **Soft delete** (bun `soft_delete`) on cards/categories/incomes/expenses/fixed_expenses/users;
  deleted rows surface in the frontend "Papelera" (`TrashView.tsx`) with restore. Children of a
  trashed parent are frozen (no paying its cuotas, no deleting its contributions); an edit may keep
  a trashed card a row already has (`billingDayFor(…, allowTrashed)`), nothing new may use it.
  Deleting for good happens only from the trash (`PurgeTrashItem`/`EmptyTrash`, `users.PurgeUser`,
  which finds every `user_id` table at run time); children go by `ON DELETE CASCADE`.
- **Views over the ledger, never a second ledger**: accounts (`account.go`) and due dates
  (`dues.go`) only attribute or read existing flows; transfers between own accounts
  (`transfer.go`, fixed or `salary_rest`) only move account balances, and an account
  reconciliation (`accountreconciliation.go`) only restarts one account's balance. A receivable
  settles as a refund (`insertRefund`), a foreign-currency purchase keeps its pesos in
  `installment_amount`. None of them adds a monthly flow to `flowsBetween`.
- **Paid cuotas are immutable (invariant)**: `UpdateExpense` never regenerates installments —
  `replanInstallments` adapts them by number (stable ids: statement lines link to them), applies a
  new amount to pending cuotas only, keeps the cuota-1 month while the date/card lead to the same
  billing month (it may come from a card statement), and refuses dropping or moving paid cuotas.
  Input ranges: years 2000–2099 (`minYear`/`maxYear`), up to 120 cuotas (`maxInstallments`).
