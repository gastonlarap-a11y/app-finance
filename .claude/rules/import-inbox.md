---
paths:
  - "backend/finance/{import,cardstatement,statement,cutoff,descriptor,fixedmatch,merge,reference,refund}*.go"
  - "frontend/src/engine/finance/{service,cutoff,descriptor,fixedmatch}.ts"
  - "frontend/src/engine/finance/{imports,importrules,cardstatements,merge}*.test.ts"
  - "frontend/src/lib/statements/**"
  - "frontend/src/components/{ImportInboxView,StatementImport,CardStatements,CsvImport}.tsx"
  - "frontend/scripts/**"
---

# Import inbox (invariant)

Detail: `ARCHITECTURE.md` §18.

- Bank movements (card statements, cartolas: PDF or CSV) only enter through
  `finance.StageCandidates`/`stageItems` into `import_items` and become expenses (or, for bank
  credits, extra incomes) only when the user confirms them (`ConfirmImportItem`/`LinkImportItem`/
  `ConfirmImportItemAsIncome`), or mark a fixed expense's month paid (`LinkImportItemToFixed`).
  Never create expenses straight from a parser.
- An item's `kind` (gasto | abono) is fixed when staged — `lineCandidate` turns negative charge
  lines into abono — and every confirm path checks it (`requireKind`; an abono may also become the
  refund of an expense: `ConfirmImportItemAsRefund`); items in another currency need a whole-peso
  amount (`requirePesos`).
- Credit-card statements are stored whole (`ImportCardStatement` → `card_statements` + lines +
  schedule) and feed the inbox from the same path. A purchase seen again in a later statement is
  matched by its stable operation number (`operationNumber`, last 8 digits), never by its key or
  wording. The bank's reference code is kept on the item and on the lines, and never discarded: it
  is the user's proof in a dispute.
- Card expenses are placed by the statements' real cutoff windows (`cardCutoff`); the card's
  billing day is only the fallback.
- A bank movement that matches an expense entered by hand merges into it (`mergeIntoExpense`): the
  bank wins on date, amount and month, the user's words stay, the bank's descriptor goes to
  `bank_description`, and paid cuotas never move.
- A movement that is a leg of a transfer between own accounts is confirmed with
  `LinkImportItemToTransfer` (no expense, no income); a repeat from another format is only
  flagged (`DuplicateItem*`, `inboxmatch.go`) — never delete or merge inbox items automatically.
- Statement parsers live in the frontend (`frontend/src/lib/statements/`, shared by desktop and
  web); the user uploads every statement by hand (the IMAP mail sync was removed; its migrations
  stay under `backend/mailsync/migrations`, desktop only). Parser fixtures must be anonymized
  (public repo) — `frontend/scripts/pdf-runs.mjs` dumps a PDF's positioned text runs.
