package finance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Card statement kinds (one PDF from Itaú carries both).
const (
	StatementNational      = "nacional"      // CLP
	StatementInternational = "internacional" // USD
)

// Card statement line sections.
const (
	LinePayment   = "pago"       // payments to the card: never staged, reconciled with the cartola
	LinePurchase  = "compra"     // purchases, with their cuota n/N
	LineVoluntary = "voluntario" // voluntarily contracted products or services
	LineCharge    = "cargo"      // commissions, interest, taxes
	LineCredit    = "abono"      // cashback, points redemptions: staged as income
)

// paymentWindowDays: a card payment may be posted a few days apart in the
// cartola and in the statement.
const paymentWindowDays = 5

// CardStatement is a credit-card statement exactly as the bank issued it:
// the figures the app compares against (period, total billed, due date) and
// the rest of the document (limits, rates, previous period) for reference.
type CardStatement struct {
	bun.BaseModel `bun:"table:card_statements,alias:cs"`

	ID                   int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID               int64         `bun:"user_id,notnull" json:"userId"`
	CardID               *int64        `bun:"card_id" json:"cardId"`
	Issuer               string        `bun:"issuer,notnull" json:"issuer"`
	Kind                 string        `bun:"kind,notnull" json:"kind"`
	Currency             string        `bun:"currency,notnull" json:"currency"`
	CardLastDigits       string        `bun:"card_last_digits,notnull" json:"cardLastDigits"`
	StatementDate        string        `bun:"statement_date,notnull" json:"statementDate"`
	Period               string        `bun:"period,notnull" json:"period"`
	PeriodFrom           string        `bun:"period_from,notnull" json:"periodFrom"`
	PeriodTo             string        `bun:"period_to,notnull" json:"periodTo"`
	DueDate              string        `bun:"due_date,notnull" json:"dueDate"`
	PreviousPeriodFrom   string        `bun:"previous_period_from,notnull" json:"previousPeriodFrom"`
	PreviousPeriodTo     string        `bun:"previous_period_to,notnull" json:"previousPeriodTo"`
	NextPeriodFrom       string        `bun:"next_period_from,notnull" json:"nextPeriodFrom"`
	NextPeriodTo         string        `bun:"next_period_to,notnull" json:"nextPeriodTo"`
	CreditLimit          types.Decimal `bun:"credit_limit,notnull" json:"creditLimit"`
	CreditUsed           types.Decimal `bun:"credit_used,notnull" json:"creditUsed"`
	CreditAvailable      types.Decimal `bun:"credit_available,notnull" json:"creditAvailable"`
	CashLimit            types.Decimal `bun:"cash_limit,notnull" json:"cashLimit"`
	CashUsed             types.Decimal `bun:"cash_used,notnull" json:"cashUsed"`
	CashAvailable        types.Decimal `bun:"cash_available,notnull" json:"cashAvailable"`
	PreviousBalanceStart types.Decimal `bun:"previous_balance_start,notnull" json:"previousBalanceStart"`
	PreviousBilled       types.Decimal `bun:"previous_billed,notnull" json:"previousBilled"`
	PreviousPaid         types.Decimal `bun:"previous_paid,notnull" json:"previousPaid"`
	PreviousBalanceEnd   types.Decimal `bun:"previous_balance_end,notnull" json:"previousBalanceEnd"`
	TransferFromNational types.Decimal `bun:"transfer_from_national,notnull" json:"transferFromNational"`
	TotalOperations      types.Decimal `bun:"total_operations,notnull" json:"totalOperations"`
	VoluntaryProducts    types.Decimal `bun:"voluntary_products,notnull" json:"voluntaryProducts"`
	ChargesNet           types.Decimal `bun:"charges_net,notnull" json:"chargesNet"`
	TotalBilled          types.Decimal `bun:"total_billed,notnull" json:"totalBilled"`
	MinimumPayment       types.Decimal `bun:"minimum_payment,notnull" json:"minimumPayment"`
	PrepaymentCost       types.Decimal `bun:"prepayment_cost,notnull" json:"prepaymentCost"`
	AutomaticCharge      types.Decimal `bun:"automatic_charge,notnull" json:"automaticCharge"`
	UnbilledBalance      types.Decimal `bun:"unbilled_balance,notnull" json:"unbilledBalance"`
	RateRevolving        string        `bun:"rate_revolving,notnull" json:"rateRevolving"`
	RateInstallments     string        `bun:"rate_installments,notnull" json:"rateInstallments"`
	RateCashAdvance      string        `bun:"rate_cash_advance,notnull" json:"rateCashAdvance"`
	CaeRevolving         string        `bun:"cae_revolving,notnull" json:"caeRevolving"`
	CaeInstallments      string        `bun:"cae_installments,notnull" json:"caeInstallments"`
	CaeCashAdvance       string        `bun:"cae_cash_advance,notnull" json:"caeCashAdvance"`
	CaePrepayment        string        `bun:"cae_prepayment,notnull" json:"caePrepayment"`
	LateInterestRate     string        `bun:"late_interest_rate,notnull" json:"lateInterestRate"`
	FxRate               string        `bun:"fx_rate,notnull" json:"fxRate"` // CLP per USD implied by the payment of this statement's debt
	FileHash             string        `bun:"file_hash,notnull" json:"fileHash"`
	ImportedAt           time.Time     `bun:"imported_at,notnull,default:current_timestamp" json:"importedAt"`
}

// CardStatementLine is one movement of a statement. Payments and credits are
// negative, as the bank prints them.
type CardStatementLine struct {
	bun.BaseModel `bun:"table:card_statement_lines,alias:csl"`

	ID                int64         `bun:"id,pk,autoincrement" json:"id"`
	UserID            int64         `bun:"user_id,notnull" json:"userId"`
	StatementID       int64         `bun:"statement_id,notnull" json:"statementId"`
	Position          int           `bun:"position,notnull" json:"position"`
	Section           string        `bun:"section,notnull" json:"section"`
	Place             string        `bun:"place,notnull" json:"place"`
	City              string        `bun:"city,notnull" json:"city"`
	Country           string        `bun:"country,notnull" json:"country"`
	OperationDate     string        `bun:"operation_date,notnull" json:"operationDate"`
	Reference         string        `bun:"reference,notnull" json:"reference"`
	Description       string        `bun:"description,notnull" json:"description"`
	InterestRate      string        `bun:"interest_rate,notnull" json:"interestRate"`
	OperationAmount   types.Decimal `bun:"operation_amount,notnull" json:"operationAmount"`
	TotalAmount       types.Decimal `bun:"total_amount,notnull" json:"totalAmount"`
	InstallmentNumber int           `bun:"installment_number,notnull" json:"installmentNumber"`
	InstallmentsTotal int           `bun:"installments_total,notnull" json:"installmentsTotal"`
	InstallmentAmount types.Decimal `bun:"installment_amount,notnull" json:"installmentAmount"` // charged this period
	OriginAmount      string        `bun:"origin_amount,notnull" json:"originAmount"`
	ImportItemID      *int64        `bun:"import_item_id" json:"importItemId"`
	InstallmentID     *int64        `bun:"installment_id" json:"installmentId"`
}

// CardStatementScheduleEntry is the bank's projection of a coming month.
type CardStatementScheduleEntry struct {
	bun.BaseModel `bun:"table:card_statement_schedule,alias:css"`

	ID          int64         `bun:"id,pk,autoincrement" json:"id"`
	StatementID int64         `bun:"statement_id,notnull" json:"statementId"`
	Period      string        `bun:"period,notnull" json:"period"`
	Amount      types.Decimal `bun:"amount,notnull" json:"amount"`
}

// ---------- input (what the frontend parser extracts) ----------

// CardStatementInput is a parsed statement. Money fields are decimal strings
// ("" = 0) and may be negative; rates are percentages ("2.56").
type CardStatementInput struct {
	Issuer               string                   `json:"issuer"`
	Kind                 string                   `json:"kind"`
	Currency             string                   `json:"currency"`
	CardLastDigits       string                   `json:"cardLastDigits"`
	StatementDate        string                   `json:"statementDate"`
	PeriodFrom           string                   `json:"periodFrom"`
	PeriodTo             string                   `json:"periodTo"`
	DueDate              string                   `json:"dueDate"`
	PreviousPeriodFrom   string                   `json:"previousPeriodFrom"`
	PreviousPeriodTo     string                   `json:"previousPeriodTo"`
	NextPeriodFrom       string                   `json:"nextPeriodFrom"`
	NextPeriodTo         string                   `json:"nextPeriodTo"`
	CreditLimit          string                   `json:"creditLimit"`
	CreditUsed           string                   `json:"creditUsed"`
	CreditAvailable      string                   `json:"creditAvailable"`
	CashLimit            string                   `json:"cashLimit"`
	CashUsed             string                   `json:"cashUsed"`
	CashAvailable        string                   `json:"cashAvailable"`
	PreviousBalanceStart string                   `json:"previousBalanceStart"`
	PreviousBilled       string                   `json:"previousBilled"`
	PreviousPaid         string                   `json:"previousPaid"`
	PreviousBalanceEnd   string                   `json:"previousBalanceEnd"`
	TransferFromNational string                   `json:"transferFromNational"`
	TotalOperations      string                   `json:"totalOperations"`
	VoluntaryProducts    string                   `json:"voluntaryProducts"`
	ChargesNet           string                   `json:"chargesNet"`
	TotalBilled          string                   `json:"totalBilled"`
	MinimumPayment       string                   `json:"minimumPayment"`
	PrepaymentCost       string                   `json:"prepaymentCost"`
	AutomaticCharge      string                   `json:"automaticCharge"`
	UnbilledBalance      string                   `json:"unbilledBalance"`
	RateRevolving        string                   `json:"rateRevolving"`
	RateInstallments     string                   `json:"rateInstallments"`
	RateCashAdvance      string                   `json:"rateCashAdvance"`
	CaeRevolving         string                   `json:"caeRevolving"`
	CaeInstallments      string                   `json:"caeInstallments"`
	CaeCashAdvance       string                   `json:"caeCashAdvance"`
	CaePrepayment        string                   `json:"caePrepayment"`
	LateInterestRate     string                   `json:"lateInterestRate"`
	FileHash             string                   `json:"fileHash"`
	Lines                []CardStatementLineInput `json:"lines"`
	Schedule             []ScheduleInput          `json:"schedule"`
}

type CardStatementLineInput struct {
	Section           string `json:"section"`
	Place             string `json:"place"`
	City              string `json:"city"`
	Country           string `json:"country"`
	OperationDate     string `json:"operationDate"` // YYYY-MM-DD
	Reference         string `json:"reference"`
	Description       string `json:"description"`
	InterestRate      string `json:"interestRate"`
	OperationAmount   string `json:"operationAmount"`
	TotalAmount       string `json:"totalAmount"`
	InstallmentNumber int    `json:"installmentNumber"` // < 1 = 1
	InstallmentsTotal int    `json:"installmentsTotal"` // < 1 = 1
	InstallmentAmount string `json:"installmentAmount"`
	OriginAmount      string `json:"originAmount"`
}

type ScheduleInput struct {
	Period string `json:"period"` // YYYY-MM
	Amount string `json:"amount"`
}

// ---------- validation ----------

// statementFields collects field errors so the first one is reported with
// its name (a parser bug must be easy to locate).
type statementFields struct{ err *shared.AppError }

func (f *statementFields) money(name, s string) types.Decimal {
	s = strings.TrimSpace(s)
	if s == "" || f.err != nil {
		return types.Zero()
	}
	d, err := types.New(s)
	if err != nil {
		f.err = shared.NewError(shared.ErrValidation, fmt.Sprintf("%s: monto inválido %q", name, s))
	}
	return d
}

func (f *statementFields) rate(name, s string) string {
	s = strings.TrimSpace(s)
	if s == "" || f.err != nil {
		return ""
	}
	d, err := types.New(s)
	if err != nil {
		f.err = shared.NewError(shared.ErrValidation, fmt.Sprintf("%s: tasa inválida %q", name, s))
		return ""
	}
	return d.String()
}

func (f *statementFields) date(name, s string, required bool) string {
	s = strings.TrimSpace(s)
	if f.err != nil || (s == "" && !required) {
		return s
	}
	if _, err := time.Parse(dateLayout, s); err != nil {
		f.err = shared.NewError(shared.ErrValidation, fmt.Sprintf("%s: fecha inválida (use YYYY-MM-DD) %q", name, s))
	}
	return s
}

func validSection(s string) bool {
	switch s {
	case LinePayment, LinePurchase, LineVoluntary, LineCharge, LineCredit:
		return true
	}
	return false
}

// validateStatement turns the parser's input into rows ready to insert.
func validateStatement(uid int64, in CardStatementInput) (*CardStatement, []CardStatementLine, []CardStatementScheduleEntry, *shared.AppError) {
	var f statementFields
	if in.Kind != StatementNational && in.Kind != StatementInternational {
		return nil, nil, nil, shared.NewError(shared.ErrValidation, "tipo de estado de cuenta inválido: "+in.Kind)
	}
	digits, aerr := validateLastDigits(in.CardLastDigits)
	if aerr != nil {
		return nil, nil, nil, aerr
	}
	if digits == "" {
		return nil, nil, nil, shared.NewError(shared.ErrValidation, "faltan los últimos 4 dígitos de la tarjeta")
	}
	issuer := strings.ToLower(strings.TrimSpace(in.Issuer))
	currency := strings.ToUpper(strings.TrimSpace(in.Currency))
	if issuer == "" || currency == "" {
		return nil, nil, nil, shared.NewError(shared.ErrValidation, "faltan el emisor o la moneda del estado de cuenta")
	}
	st := &CardStatement{
		UserID: uid, Issuer: issuer, Kind: in.Kind, Currency: currency, CardLastDigits: digits,
		StatementDate:        f.date("fecha del estado", in.StatementDate, true),
		PeriodFrom:           f.date("período desde", in.PeriodFrom, false),
		PeriodTo:             f.date("período hasta", in.PeriodTo, false),
		DueDate:              f.date("pagar hasta", in.DueDate, false),
		PreviousPeriodFrom:   f.date("período anterior desde", in.PreviousPeriodFrom, false),
		PreviousPeriodTo:     f.date("período anterior hasta", in.PreviousPeriodTo, false),
		NextPeriodFrom:       f.date("próximo período desde", in.NextPeriodFrom, false),
		NextPeriodTo:         f.date("próximo período hasta", in.NextPeriodTo, false),
		CreditLimit:          f.money("cupo total", in.CreditLimit),
		CreditUsed:           f.money("cupo utilizado", in.CreditUsed),
		CreditAvailable:      f.money("cupo disponible", in.CreditAvailable),
		CashLimit:            f.money("cupo avance", in.CashLimit),
		CashUsed:             f.money("avance utilizado", in.CashUsed),
		CashAvailable:        f.money("avance disponible", in.CashAvailable),
		PreviousBalanceStart: f.money("saldo inicio período anterior", in.PreviousBalanceStart),
		PreviousBilled:       f.money("facturado período anterior", in.PreviousBilled),
		PreviousPaid:         f.money("pagado período anterior", in.PreviousPaid),
		PreviousBalanceEnd:   f.money("saldo final período anterior", in.PreviousBalanceEnd),
		TransferFromNational: f.money("traspaso deuda nacional", in.TransferFromNational),
		TotalOperations:      f.money("total operaciones", in.TotalOperations),
		VoluntaryProducts:    f.money("productos voluntarios", in.VoluntaryProducts),
		ChargesNet:           f.money("cargos y abonos", in.ChargesNet),
		TotalBilled:          f.money("total facturado", in.TotalBilled),
		MinimumPayment:       f.money("monto mínimo", in.MinimumPayment),
		PrepaymentCost:       f.money("costo prepago", in.PrepaymentCost),
		AutomaticCharge:      f.money("cargo automático", in.AutomaticCharge),
		UnbilledBalance:      f.money("deuda no facturada", in.UnbilledBalance),
		RateRevolving:        f.rate("tasa rotativo", in.RateRevolving),
		RateInstallments:     f.rate("tasa compra en cuotas", in.RateInstallments),
		RateCashAdvance:      f.rate("tasa avance", in.RateCashAdvance),
		CaeRevolving:         f.rate("CAE rotativo", in.CaeRevolving),
		CaeInstallments:      f.rate("CAE compra en cuotas", in.CaeInstallments),
		CaeCashAdvance:       f.rate("CAE avance", in.CaeCashAdvance),
		CaePrepayment:        f.rate("CAE prepago", in.CaePrepayment),
		LateInterestRate:     f.rate("interés moratorio", in.LateInterestRate),
		FileHash:             strings.TrimSpace(in.FileHash),
	}
	// The billed period is the month the statement closes, the same month
	// periodOf assigns to purchases made before the card's cutoff.
	closing := st.PeriodTo
	if closing == "" {
		closing = st.StatementDate
	}
	if f.err == nil {
		st.Period = closing[:7]
	}

	lines := make([]CardStatementLine, 0, len(in.Lines))
	for i, l := range in.Lines {
		name := fmt.Sprintf("movimiento %d", i+1)
		if !validSection(l.Section) {
			return nil, nil, nil, shared.NewError(shared.ErrValidation, fmt.Sprintf("%s: sección inválida %q", name, l.Section))
		}
		desc := strings.TrimSpace(l.Description)
		if desc == "" {
			return nil, nil, nil, shared.NewError(shared.ErrValidation, name+": falta la descripción")
		}
		total := max(l.InstallmentsTotal, 1)
		number := max(l.InstallmentNumber, 1)
		if number > total {
			return nil, nil, nil, shared.NewError(shared.ErrValidation, fmt.Sprintf("%s: cuota %d de %d inválida", name, number, total))
		}
		origin := ""
		if strings.TrimSpace(l.OriginAmount) != "" {
			origin = f.money(name+" monto origen", l.OriginAmount).String()
		}
		lines = append(lines, CardStatementLine{
			UserID: uid, Position: i + 1, Section: l.Section,
			Place: strings.TrimSpace(l.Place), City: strings.TrimSpace(l.City), Country: strings.TrimSpace(l.Country),
			OperationDate:     f.date(name+" fecha", l.OperationDate, true),
			Reference:         strings.TrimSpace(l.Reference),
			Description:       desc,
			InterestRate:      f.rate(name+" tasa", l.InterestRate),
			OperationAmount:   f.money(name+" monto operación", l.OperationAmount),
			TotalAmount:       f.money(name+" monto total", l.TotalAmount),
			InstallmentNumber: number,
			InstallmentsTotal: total,
			InstallmentAmount: f.money(name+" cargo del mes", l.InstallmentAmount),
			OriginAmount:      origin,
		})
	}
	schedule := make([]CardStatementScheduleEntry, 0, len(in.Schedule))
	for _, e := range in.Schedule {
		if !validPeriod(e.Period) {
			return nil, nil, nil, shared.NewError(shared.ErrValidation, "calendario: período inválido "+e.Period)
		}
		schedule = append(schedule, CardStatementScheduleEntry{Period: e.Period, Amount: f.money("calendario "+e.Period, e.Amount)})
	}
	if f.err != nil {
		return nil, nil, nil, f.err
	}
	return st, lines, schedule, nil
}

// ---------- import ----------

// ImportCardStatement stores a parsed statement in full and feeds the inbox,
// in one transaction:
//   - a statement already imported (same card, kind and date) changes nothing;
//   - a purchase cuota that continues an expense already in the app is linked
//     to that expense's installment instead of being reviewed again;
//   - new purchases (with their cuota n/N and the bank's exact cuota), charges
//     and credits go to the inbox, deduplicated and reconciled like any batch;
//   - payments are not staged: they reconcile the cartola's card-payment lines.
func (s *FinanceService) ImportCardStatement(ctx context.Context, in CardStatementInput) CardStatementImportResult {
	uid := s.uid()
	st, lines, schedule, aerr := validateStatement(uid, in)
	if aerr != nil {
		return CardStatementImportResult{Error: aerr}
	}
	out := &CardStatementImport{}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		existing := new(CardStatement)
		err := tx.NewSelect().Model(existing).Column("id").
			Where("user_id = ? AND card_last_digits = ? AND kind = ? AND statement_date = ?", uid, st.CardLastDigits, st.Kind, st.StatementDate).
			Scan(ctx)
		if err == nil {
			out.StatementID, out.AlreadyImported = existing.ID, true
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("checking statement: %w", err)
		}
		card, err := cardByDigits(ctx, tx, uid, st.CardLastDigits)
		if err != nil {
			return err
		}
		if card != nil {
			st.CardID = &card.ID
		}
		if _, err := tx.NewInsert().Model(st).Returning("*").Exec(ctx); err != nil {
			return fmt.Errorf("inserting statement: %w", err)
		}
		out.StatementID = st.ID
		for i := range schedule {
			schedule[i].StatementID = st.ID
		}
		if len(schedule) > 0 {
			if _, err := tx.NewInsert().Model(&schedule).Exec(ctx); err != nil {
				return fmt.Errorf("inserting schedule: %w", err)
			}
		}
		for i := range lines {
			lines[i].StatementID = st.ID
		}
		if len(lines) > 0 {
			if _, err := tx.NewInsert().Model(&lines).Returning("*").Exec(ctx); err != nil {
				return fmt.Errorf("inserting lines: %w", err)
			}
		}
		return s.feedInbox(ctx, tx, uid, st, card, lines, out)
	})
	if err != nil {
		return CardStatementImportResult{Error: appErr(err)}
	}
	return CardStatementImportResult{Data: out}
}

// feedInbox links, reconciles and stages the statement's lines (see ImportCardStatement).
func (s *FinanceService) feedInbox(
	ctx context.Context, tx bun.Tx, uid int64, st *CardStatement, card *Card,
	lines []CardStatementLine, out *CardStatementImport,
) error {
	var candidates []ImportCandidate
	var staged []int // index into lines of each candidate
	for i := range lines {
		l := &lines[i]
		switch l.Section {
		case LinePayment:
			n, err := reconcilePaymentLine(ctx, tx, uid, st, l)
			if err != nil {
				return err
			}
			out.PaymentsMatched += n
			continue
		case LinePurchase, LineVoluntary:
			inst, err := continuedInstallment(ctx, tx, uid, card, l)
			if err != nil {
				return err
			}
			if inst != nil {
				l.InstallmentID = &inst.ID
				if _, err := tx.NewUpdate().Model(l).Column("installment_id").WherePK().Exec(ctx); err != nil {
					return fmt.Errorf("linking installment: %w", err)
				}
				out.LinkedInstallments++
				continue
			}
		}
		candidates = append(candidates, lineCandidate(st, l))
		staged = append(staged, i)
	}
	if len(candidates) == 0 {
		return nil
	}
	items, aerr := validateBatch(uid, ImportBatch{Source: ImportSourcePDFCard, Issuer: st.Issuer, Items: candidates})
	if aerr != nil {
		return aerr
	}
	for k := range items {
		lineID := lines[staged[k]].ID
		items[k].StatementLineID = &lineID
	}
	ids, sum, err := stageItems(ctx, tx, uid, items)
	if err != nil {
		return err
	}
	out.Added, out.Duplicates, out.Reconciled = sum.Added, sum.Duplicates, sum.Reconciled
	for k, id := range ids {
		if _, err := tx.NewUpdate().Model((*CardStatementLine)(nil)).
			Set("import_item_id = ?", id).Where("id = ?", lines[staged[k]].ID).Exec(ctx); err != nil {
			return fmt.Errorf("linking import item: %w", err)
		}
	}
	return nil
}

// lineCandidate is the inbox candidate for a staged line. Purchases keep the
// purchase total as amount and the bank's cuota apart; the key uses the
// reference and total (not the cuota number), so the same purchase seen in
// next month's statement is recognized as already in the inbox.
//
// The item's kind is decided here, not by the amount's sign downstream: a
// negative line in a charge section (a purchase reversal, a refunded fee) is
// money back, so it stages as a credit like the abono section. The statement
// also fixes the billing month of every purchase: cuota n/N started n-1 months
// before it, and a one-payment purchase is billed in the statement's month.
func lineCandidate(st *CardStatement, l *CardStatementLine) ImportCandidate {
	c := ImportCandidate{
		Date:              l.OperationDate,
		Description:       l.Description,
		Currency:          st.Currency,
		CardLastDigits:    st.CardLastDigits,
		Account:           st.Kind,
		Reference:         l.Reference,
		InstallmentsTotal: l.InstallmentsTotal,
		InstallmentNumber: l.InstallmentNumber,
	}
	charged := l.InstallmentAmount.Abs()
	reversal := l.Section != LineCredit && (l.InstallmentAmount.IsNegative() || l.OperationAmount.IsNegative())
	switch {
	case l.Section == LineCredit || reversal:
		c.Kind = ImportKindCredit
		c.Amount = charged.String()
		if charged.IsZero() {
			c.Amount = l.OperationAmount.Abs().String()
		}
	case l.Section == LinePurchase || l.Section == LineVoluntary:
		total := l.OperationAmount.Abs()
		if st.Kind == StatementInternational || total.IsZero() {
			total = charged // USD lines carry only the charged amount
		}
		c.Amount = total.String()
		if l.InstallmentsTotal > 1 {
			c.InstallmentAmount = charged.String()
		}
		c.FirstPeriod = addMonths(st.Period, -(l.InstallmentNumber - 1))
	default: // cargo: a fee or tax billed in the statement's month
		c.Amount = charged.String()
		c.FirstPeriod = st.Period
	}
	return c
}

// cardByDigits returns uid's one live card with those last digits, or nil.
func cardByDigits(ctx context.Context, db bun.IDB, uid int64, digits string) (*Card, error) {
	var cards []Card
	if err := db.NewSelect().Model(&cards).Where("user_id = ? AND last_digits = ?", uid, digits).Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding card: %w", err)
	}
	if len(cards) != 1 {
		return nil, nil
	}
	return &cards[0], nil
}

// continuedInstallment finds the app installment a statement cuota bills: the
// cuota number n of a live expense on the same card (when known) with the same
// cuota count and amount, bought within reconcileWindowDays of the line.
func continuedInstallment(ctx context.Context, db bun.IDB, uid int64, card *Card, l *CardStatementLine) (*Installment, error) {
	var expenses []Expense
	q := db.NewSelect().Model(&expenses).
		Where("user_id = ? AND installments_total = ? AND installment_amount = ?", uid, l.InstallmentsTotal, l.InstallmentAmount.Abs().String()).
		Where("ABS(julianday(substr(date, 1, 10)) - julianday(?)) <= ?", l.OperationDate, reconcileWindowDays).
		OrderExpr("ABS(julianday(substr(date, 1, 10)) - julianday(?)) ASC, id ASC", l.OperationDate)
	if card != nil {
		q = q.Where("card_id = ?", card.ID)
	}
	if err := q.Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding continued expense: %w", err)
	}
	for _, ex := range expenses {
		inst := new(Installment)
		err := db.NewSelect().Model(inst).
			Where("expense_id = ? AND user_id = ? AND number = ?", ex.ID, uid, l.InstallmentNumber).
			Where("id NOT IN (SELECT installment_id FROM card_statement_lines WHERE user_id = ? AND installment_id IS NOT NULL)", uid).
			Scan(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("finding installment: %w", err)
		}
		return inst, nil
	}
	return nil, nil
}

// isInternationalPayment tells a cartola's payment of the USD card debt
// ("PAGO DEUDA INTER. TC CTA CLP") from the national one.
func isInternationalPayment(description string) bool {
	return strings.Contains(strings.ToUpper(description), "INTER")
}

// reconcilePaymentLine marks as conciliado the cartola card-payment items
// that a statement payment line accounts for, and learns the USD rate from
// an international one. Returns how many items it matched. A payment the user
// already discarded (it is not an expense) still counts: it is the same bank
// fact, and the only source of the USD rate.
func reconcilePaymentLine(ctx context.Context, tx bun.Tx, uid int64, st *CardStatement, l *CardStatementLine) (int, error) {
	var items []ImportItem
	q := tx.NewSelect().Model(&items).
		Where("user_id = ? AND status IN (?) AND hint = ? AND statement_line_id IS NULL",
			uid, bun.List([]string{ImportPendiente, ImportDescartado}), HintCardPayment).
		Where("ABS(julianday(date) - julianday(?)) <= ?", l.OperationDate, paymentWindowDays).
		OrderExpr("ABS(julianday(date) - julianday(?)) ASC, id ASC", l.OperationDate)
	paid := l.InstallmentAmount.Abs()
	if st.Kind == StatementInternational {
		q = q.Where("description LIKE ?", "%INTER%")
	} else {
		q = q.Where("amount = ?", paid.String())
	}
	if err := q.Scan(ctx); err != nil {
		return 0, fmt.Errorf("finding cartola payments: %w", err)
	}
	for _, it := range items {
		if st.Kind == StatementNational && isInternationalPayment(it.Description) {
			continue
		}
		if _, err := tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConciliado).Set("statement_line_id = ?", l.ID).
			Where("id = ? AND user_id = ?", it.ID, uid).Exec(ctx); err != nil {
			return 0, fmt.Errorf("reconciling payment: %w", err)
		}
		if st.Kind == StatementInternational {
			if err := learnFxRate(ctx, tx, st.ID, it.Amount, paid); err != nil {
				return 0, err
			}
		}
		return 1, nil
	}
	return 0, nil
}

// matchPaymentLine is the other direction: a cartola card payment staged after
// the statement that lists it.
func matchPaymentLine(ctx context.Context, tx bun.Tx, uid int64, item *ImportItem) (*CardStatementLine, error) {
	international := isInternationalPayment(item.Description)
	var lines []CardStatementLine
	q := tx.NewSelect().Model(&lines).
		Where("csl.user_id = ? AND csl.section = ?", uid, LinePayment).
		Where("ABS(julianday(csl.operation_date) - julianday(?)) <= ?", item.Date, paymentWindowDays).
		Where("csl.id NOT IN (SELECT statement_line_id FROM import_items WHERE user_id = ? AND statement_line_id IS NOT NULL)", uid).
		Join("JOIN card_statements AS cs ON cs.id = csl.statement_id").
		OrderExpr("ABS(julianday(csl.operation_date) - julianday(?)) ASC, csl.id ASC", item.Date)
	if international {
		q = q.Where("cs.kind = ?", StatementInternational)
	} else {
		q = q.Where("cs.kind = ? AND csl.installment_amount = ?", StatementNational, item.Amount.Neg().String())
	}
	if err := q.Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding statement payment: %w", err)
	}
	if len(lines) == 0 {
		return nil, nil
	}
	l := &lines[0]
	if international {
		if err := learnFxRate(ctx, tx, l.StatementID, item.Amount, l.InstallmentAmount.Abs()); err != nil {
			return nil, err
		}
	}
	return l, nil
}

// learnFxRate stores the CLP-per-USD rate implied by paying `usd` with `clp`.
func learnFxRate(ctx context.Context, tx bun.Tx, statementID int64, clp, usd types.Decimal) error {
	if usd.IsZero() {
		return nil
	}
	rate := clp.Decimal.Div(usd.Decimal).Round(4)
	if _, err := tx.NewUpdate().Model((*CardStatement)(nil)).
		Set("fx_rate = ?", rate.String()).Where("id = ?", statementID).Exec(ctx); err != nil {
		return fmt.Errorf("saving exchange rate: %w", err)
	}
	return nil
}

// latestFxRate is the most recent CLP-per-USD rate learned for uid, or "".
func latestFxRate(ctx context.Context, db bun.IDB, uid int64) (string, error) {
	st := new(CardStatement)
	err := db.NewSelect().Model(st).Column("fx_rate").
		Where("user_id = ? AND fx_rate <> ''", uid).Order("statement_date DESC", "id DESC").Limit(1).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("reading exchange rate: %w", err)
	}
	return st.FxRate, nil
}

// ---------- read / delete ----------

// ListCardStatements returns uid's statements for a billed period ("" = all),
// newest first, each compared with what the app has for that card and month.
func (s *FinanceService) ListCardStatements(ctx context.Context, period string) CardStatementsResult {
	if period != "" && !validPeriod(period) {
		return CardStatementsResult{Error: invalidPeriod()}
	}
	out, err := s.listCardStatements(ctx, s.uid(), period)
	if err != nil {
		return CardStatementsResult{Error: internalErr(err)}
	}
	return CardStatementsResult{Data: out}
}

func (s *FinanceService) listCardStatements(ctx context.Context, uid int64, period string) ([]CardStatementView, error) {
	var sts []CardStatement
	q := s.db.NewSelect().Model(&sts).Where("user_id = ?", uid).Order("statement_date DESC", "kind ASC", "id DESC")
	if period != "" {
		q = q.Where("period = ?", period)
	}
	if err := q.Scan(ctx); err != nil {
		return nil, fmt.Errorf("listing statements: %w", err)
	}
	sc := statementsContext{appByPeriod: map[string]map[int64]types.Decimal{}}
	var err error
	if sc.cardByID, err = s.cardMapAll(ctx, uid); err != nil {
		return nil, fmt.Errorf("loading cards: %w", err)
	}
	if sc.lines, sc.pending, err = s.statementLinesAndPending(ctx, uid, sts); err != nil {
		return nil, err
	}
	out := make([]CardStatementView, 0, len(sts))
	for _, st := range sts {
		v, err := s.statementView(ctx, uid, st, &sc)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// statementsContext is what statementView needs beyond the statement itself,
// loaded once for a whole list instead of once per statement.
type statementsContext struct {
	cardByID    map[int64]Card
	lines       map[int64][]CardStatementLine      // statement id → lines
	pending     map[int64]int                      // statement id → pending inbox items
	appByPeriod map[string]map[int64]types.Decimal // period → card → app charges (filled lazily)
}

// statementLinesAndPending loads the lines of every statement in sts and how
// many of their inbox items are still pending, in two queries.
func (s *FinanceService) statementLinesAndPending(ctx context.Context, uid int64, sts []CardStatement) (
	map[int64][]CardStatementLine, map[int64]int, error,
) {
	lines := map[int64][]CardStatementLine{}
	pending := map[int64]int{}
	if len(sts) == 0 {
		return lines, pending, nil
	}
	ids := make([]int64, len(sts))
	for i, st := range sts {
		ids[i] = st.ID
	}
	var all []CardStatementLine
	if err := s.db.NewSelect().Model(&all).Where("user_id = ? AND statement_id IN (?)", uid, bun.List(ids)).Scan(ctx); err != nil {
		return nil, nil, fmt.Errorf("loading lines: %w", err)
	}
	for _, l := range all {
		lines[l.StatementID] = append(lines[l.StatementID], l)
	}
	var counts []struct {
		StatementID int64 `bun:"statement_id"`
		N           int   `bun:"n"`
	}
	if err := s.db.NewRaw(`
		SELECT csl.statement_id, COUNT(*) AS n FROM import_items AS ii
		JOIN card_statement_lines AS csl ON csl.id = ii.statement_line_id
		WHERE ii.user_id = ? AND ii.status = ? AND csl.statement_id IN (?)
		GROUP BY csl.statement_id`, uid, ImportPendiente, bun.List(ids)).Scan(ctx, &counts); err != nil {
		return nil, nil, fmt.Errorf("counting pending lines: %w", err)
	}
	for _, c := range counts {
		pending[c.StatementID] = c.N
	}
	return lines, pending, nil
}

// statementView adds the bank-vs-app comparison. BankCharges is what the app
// should have as expenses on the card for the period (purchases, products and
// charges billed this month); credits are income, payments move money.
func (s *FinanceService) statementView(ctx context.Context, uid int64, st CardStatement, sc *statementsContext) (CardStatementView, error) {
	v := CardStatementView{CardStatement: st, BankCharges: types.Zero(), BankCredits: types.Zero()}
	for _, l := range sc.lines[st.ID] {
		switch l.Section {
		case LinePurchase, LineVoluntary, LineCharge:
			v.BankCharges = v.BankCharges.Add(l.InstallmentAmount)
		case LineCredit:
			v.BankCredits = v.BankCredits.Add(l.InstallmentAmount.Abs())
		}
	}
	v.PendingItems = sc.pending[st.ID]
	if st.CardID == nil {
		return v, nil
	}
	c, ok := sc.cardByID[*st.CardID]
	if ok {
		v.CardName = c.Name
	}
	if st.Currency != "CLP" {
		return v, nil // the app keeps CLP only: USD lines are compared in the inbox
	}
	byCard, ok := sc.appByPeriod[st.Period]
	if !ok {
		var err error
		if byCard, err = s.cardChargesIn(ctx, uid, st.Period); err != nil {
			return v, fmt.Errorf("card charges of %s: %w", st.Period, err)
		}
		sc.appByPeriod[st.Period] = byCard
	}
	// MonthlySummary's per-card totals cover live cards only; a card in the
	// trash compares against zero, as before.
	app := types.Zero()
	if c.DeletedAt == nil {
		app = byCard[*st.CardID]
	}
	v.AppCharges = &app
	return v, nil
}

// GetCardStatement returns a statement with every line (and what became of
// it in the app) and the bank's schedule.
func (s *FinanceService) GetCardStatement(ctx context.Context, id int64) CardStatementDetailResult {
	uid := s.uid()
	st := new(CardStatement)
	err := s.db.NewSelect().Model(st).Where("id = ? AND user_id = ?", id, uid).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return CardStatementDetailResult{Error: shared.NewError(shared.ErrNotFound, "estado de cuenta no encontrado")}
	}
	if err != nil {
		return CardStatementDetailResult{Error: internalErr(err)}
	}
	sc := statementsContext{appByPeriod: map[string]map[int64]types.Decimal{}}
	if sc.cardByID, err = s.cardMapAll(ctx, uid); err != nil {
		return CardStatementDetailResult{Error: internalErr(err)}
	}
	if sc.lines, sc.pending, err = s.statementLinesAndPending(ctx, uid, []CardStatement{*st}); err != nil {
		return CardStatementDetailResult{Error: internalErr(err)}
	}
	view, err := s.statementView(ctx, uid, *st, &sc)
	if err != nil {
		return CardStatementDetailResult{Error: internalErr(err)}
	}
	detail := &CardStatementDetail{Statement: view, Lines: []CardStatementLineView{}, Schedule: []CardStatementScheduleEntry{}}
	if err := s.db.NewSelect().Model(&detail.Schedule).Where("statement_id = ?", id).Order("period ASC").Scan(ctx); err != nil {
		return CardStatementDetailResult{Error: internalErr(err)}
	}
	var lines []CardStatementLine
	if err := s.db.NewSelect().Model(&lines).Where("statement_id = ? AND user_id = ?", id, uid).Order("position ASC").Scan(ctx); err != nil {
		return CardStatementDetailResult{Error: internalErr(err)}
	}
	for _, l := range lines {
		lv, err := s.lineView(ctx, uid, l, lines)
		if err != nil {
			return CardStatementDetailResult{Error: internalErr(err)}
		}
		detail.Lines = append(detail.Lines, lv)
	}
	return CardStatementDetailResult{Data: detail}
}

// lineView says what became of a line: the app expense its cuota continues,
// its inbox item's status, and for a points redemption the purchase it pays.
func (s *FinanceService) lineView(ctx context.Context, uid int64, l CardStatementLine, all []CardStatementLine) (CardStatementLineView, error) {
	v := CardStatementLineView{CardStatementLine: l}
	var expenseID *int64
	if l.InstallmentID != nil {
		inst := new(Installment)
		if err := s.db.NewSelect().Model(inst).Where("id = ? AND user_id = ?", *l.InstallmentID, uid).Scan(ctx); err == nil {
			expenseID = &inst.ExpenseID
		} else if !errors.Is(err, sql.ErrNoRows) {
			return v, err
		}
	}
	if l.ImportItemID != nil {
		it := new(ImportItem)
		if err := s.db.NewSelect().Model(it).Where("id = ? AND user_id = ?", *l.ImportItemID, uid).Scan(ctx); err == nil {
			v.ItemStatus = it.Status
			if it.ExpenseID != nil {
				expenseID = it.ExpenseID
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return v, err
		}
	}
	if expenseID != nil {
		ex := new(Expense)
		if err := s.db.NewSelect().Model(ex).Where("id = ? AND user_id = ?", *expenseID, uid).Scan(ctx); err == nil {
			v.ExpenseID, v.ExpenseDescription = &ex.ID, ex.Description
		} else if !errors.Is(err, sql.ErrNoRows) {
			return v, err
		}
	}
	if l.Section == LineCredit {
		for _, p := range all {
			if p.Section == LinePurchase && p.InstallmentAmount.Cmp(l.InstallmentAmount.Abs()) == 0 {
				v.RedeemedPurchase = p.Description
				break
			}
		}
	}
	return v, nil
}

// DeleteCardStatement forgets a statement (to re-import it after a parser
// fix). Its inbox items and linked expenses stay.
func (s *FinanceService) DeleteCardStatement(ctx context.Context, id int64) OpResult {
	res, err := s.db.NewDelete().Model((*CardStatement)(nil)).Where("id = ? AND user_id = ?", id, s.uid()).Exec(ctx)
	return OpResult{Error: requireOne(res, err, "estado de cuenta no encontrado")}
}

// ---------- credits as income ----------

// ConfirmImportItemAsIncome records a pending item (typically a bank credit:
// cashback, points redemption) as an extra income of `period`.
func (s *FinanceService) ConfirmImportItemAsIncome(ctx context.Context, id int64, period, description, amount string) IncomeResult {
	if !validPeriod(period) {
		return IncomeResult{Error: invalidPeriod()}
	}
	desc := strings.TrimSpace(description)
	if desc == "" {
		return IncomeResult{Error: shared.NewError(shared.ErrValidation, "la descripción es obligatoria")}
	}
	amt, aerr := parseAmount(amount)
	if aerr != nil {
		return IncomeResult{Error: aerr}
	}
	if amt.IsZero() {
		return IncomeResult{Error: shared.NewError(shared.ErrValidation, "el monto debe ser mayor a 0")}
	}
	uid := s.uid()
	inc := &Income{UserID: uid, Period: period, Description: desc, Amount: amt}
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		item, err := loadPendingItem(ctx, tx, uid, id)
		if err != nil {
			return err
		}
		if err := requireKind(item, ImportKindCredit); err != nil {
			return err
		}
		if err := requirePesos(item, amt); err != nil {
			return err
		}
		if _, err := tx.NewInsert().Model(inc).Returning("*").Exec(ctx); err != nil {
			return fmt.Errorf("inserting income: %w", err)
		}
		_, err = tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConfirmado).Set("income_id = ?", inc.ID).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return IncomeResult{Error: appErr(err)}
	}
	return IncomeResult{Data: inc}
}
