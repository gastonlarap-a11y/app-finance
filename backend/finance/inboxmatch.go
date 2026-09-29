package finance

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/uptrace/bun"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
	"github.com/gastonlarap-a11y/app-finance/backend/shared/types"
)

// Two more questions the inbox asks, the way Actual Budget reviews an import:
// is this movement one leg of a transfer between your own accounts (money
// loaded into Mercado Pago, the month's saving), and is it a bank fact you
// already imported from another format? Both are suggestions only: a transfer
// is linked by the user, a duplicate is never removed on its own.

// transferLeg is one side (kind) of one month of a transfer: the source
// account's cartola shows the charge, the destination's the credit.
type transferLeg struct {
	transfer int64
	period   string
	kind     string
}

// transferIndex is what the inbox needs to suggest a transfer for a movement.
type transferIndex struct {
	transfers []Transfer
	names     map[int64]string         // account id → name
	salaryOf  map[string]types.Decimal // a salary_rest transfer follows the month's salary
	taken     map[transferLeg]bool     // legs already linked to a movement
}

func (s *FinanceService) loadTransferIndex(ctx context.Context, uid int64, items []ImportItem) (transferIndex, error) {
	ix := transferIndex{names: map[int64]string{}, salaryOf: map[string]types.Decimal{}, taken: map[transferLeg]bool{}}
	from, to := "", ""
	for _, it := range items {
		if !transferReviewable(it) {
			continue
		}
		m := it.Date[:len(periodLayout)]
		if from == "" || m < from {
			from = m
		}
		to = max(to, m)
	}
	if from == "" {
		return ix, nil
	}
	if err := s.db.NewSelect().Model(&ix.transfers).Where("user_id = ?", uid).Order("id ASC").Scan(ctx); err != nil {
		return ix, fmt.Errorf("loading transfers: %w", err)
	}
	if len(ix.transfers) == 0 {
		return ix, nil
	}
	salaries, err := s.salaryByMonth(ctx, uid, from, to)
	if err != nil {
		return ix, err
	}
	for m, ms := range salaries {
		ix.salaryOf[m] = ms.amount
	}
	var accs []Account
	if err := s.db.NewSelect().Model(&accs).Column("id", "name").Where("user_id = ?", uid).Scan(ctx); err != nil {
		return ix, fmt.Errorf("loading accounts: %w", err)
	}
	for _, a := range accs {
		ix.names[a.ID] = a.Name
	}
	var linked []ImportItem
	if err := s.db.NewSelect().Model(&linked).Column("transfer_id", "transfer_period", "kind").
		Where("user_id = ? AND transfer_id IS NOT NULL", uid).Scan(ctx); err != nil {
		return ix, fmt.Errorf("loading transfer links: %w", err)
	}
	for _, l := range linked {
		ix.taken[transferLeg{*l.TransferID, l.TransferPeriod, l.Kind}] = true
	}
	return ix, nil
}

// transferReviewable reports whether an item may be a transfer leg: a pending
// movement in pesos with a real date.
func transferReviewable(it ImportItem) bool {
	return it.Status == ImportPendiente && it.Currency == CurrencyCLP && len(it.Date) >= len(dateLayout)
}

// suggest returns the transfer whose month the item looks like a leg of: one
// that moves exactly the item's amount in the item's month, with that leg not
// linked yet (the oldest transfer wins a tie).
func (ix transferIndex) suggest(it ImportItem) (*Transfer, string, bool) {
	if !transferReviewable(it) {
		return nil, "", false
	}
	period := it.Date[:len(periodLayout)]
	for i := range ix.transfers {
		t := &ix.transfers[i]
		if !t.activeIn(period) || ix.taken[transferLeg{t.ID, period, it.Kind}] {
			continue
		}
		if t.moved(ix.salaryOf[period]).Cmp(it.Amount) == 0 {
			return t, period, true
		}
	}
	return nil, "", false
}

// label is how the inbox names a transfer: its description, else its accounts.
func (ix transferIndex) label(t *Transfer) string {
	return cmp.Or(t.Description, ix.names[t.FromAccountID]+" → "+ix.names[t.ToAccountID])
}

// LinkImportItemToTransfer confirms a pending movement as one leg of a
// transfer between own accounts in `period`: the charge in the source
// account's cartola or the credit in the destination's. It adds no expense nor
// income — the transfer already moves both accounts. Each leg of a month takes
// one movement.
func (s *FinanceService) LinkImportItemToTransfer(ctx context.Context, id, transferID int64, period string) OpResult {
	if !validPeriod(period) {
		return OpResult{Error: invalidPeriod()}
	}
	uid := s.uid()
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		item, err := loadPendingItem(ctx, tx, uid, id)
		if err != nil {
			return err
		}
		if item.Currency != CurrencyCLP {
			return shared.NewError(shared.ErrValidation, "solo un movimiento en pesos puede ser una transferencia entre tus cuentas")
		}
		t := new(Transfer)
		err = tx.NewSelect().Model(t).Where("id = ? AND user_id = ?", transferID, uid).Scan(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			return shared.NewError(shared.ErrNotFound, "transferencia no encontrada")
		}
		if err != nil {
			return fmt.Errorf("loading transfer: %w", err)
		}
		if !t.activeIn(period) {
			return shared.NewError(shared.ErrValidation, "la transferencia no mueve plata en "+period)
		}
		taken, err := tx.NewSelect().Model((*ImportItem)(nil)).
			Where("user_id = ? AND transfer_id = ? AND transfer_period = ? AND kind = ?", uid, transferID, period, item.Kind).Exists(ctx)
		if err != nil {
			return fmt.Errorf("checking transfer links: %w", err)
		}
		if taken {
			return shared.NewError(shared.ErrConflict, "ese mes de la transferencia ya está enlazado a otro movimiento del banco")
		}
		_, err = tx.NewUpdate().Model((*ImportItem)(nil)).
			Set("status = ?", ImportConfirmado).Set("transfer_id = ?", transferID).Set("transfer_period = ?", period).
			Where("id = ? AND user_id = ?", id, uid).Exec(ctx)
		return err
	})
	if err != nil {
		return OpResult{Error: appErr(err)}
	}
	return OpResult{}
}

// duplicateItemDays is how far apart two sightings of one bank movement may be
// dated (a posting date against an operation date).
const duplicateItemDays = 1

// itemSightings are the inbox items a pending one may repeat, loaded once.
type itemSightings []ImportItem

// sightingsNear loads the non-discarded items dated within duplicateItemDays
// of any pending item.
func (s *FinanceService) sightingsNear(ctx context.Context, uid int64, items []ImportItem) (itemSightings, error) {
	var from, to time.Time
	for _, it := range items {
		if it.Status != ImportPendiente {
			continue
		}
		d, err := time.Parse(dateLayout, it.Date)
		if err != nil {
			continue
		}
		if from.IsZero() || d.Before(from) {
			from = d
		}
		if to.IsZero() || d.After(to) {
			to = d
		}
	}
	if from.IsZero() {
		return nil, nil
	}
	var out itemSightings
	if err := s.db.NewSelect().Model(&out).
		Where("user_id = ? AND status <> ?", uid, ImportDescartado).
		Where("date >= ? AND date <= ?",
			from.AddDate(0, 0, -duplicateItemDays).Format(dateLayout), to.AddDate(0, 0, duplicateItemDays).Format(dateLayout)).
		Order("id ASC").Scan(ctx); err != nil {
		return nil, fmt.Errorf("finding earlier sightings: %w", err)
	}
	return out, nil
}

// find returns the earlier item that looks like the same bank movement as a
// pending one, imported from another format or under another bank label
// (the same file is already deduplicated by its key): same kind, currency and
// amount, dated a day apart at most, and named alike or with the same bank
// reference. The oldest wins.
func (s itemSightings) find(it ImportItem) *ImportItem {
	if it.Status != ImportPendiente {
		return nil
	}
	day, err := time.Parse(dateLayout, it.Date)
	if err != nil {
		return nil
	}
	for i := range s {
		o := &s[i]
		if o.ID >= it.ID || o.Kind != it.Kind || o.Currency != it.Currency || o.Amount.Cmp(it.Amount) != 0 {
			continue
		}
		if o.Source == it.Source && o.Issuer == it.Issuer {
			continue
		}
		when, err := time.Parse(dateLayout, o.Date)
		if err != nil || math.Abs(when.Sub(day).Hours()/24) > duplicateItemDays {
			continue
		}
		if namesMatch(o.Description, it.Description) || (o.Reference != "" && o.Reference == it.Reference) {
			return o
		}
	}
	return nil
}
