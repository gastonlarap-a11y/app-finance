package finance

import (
	"testing"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// pendingNamed returns the pending view of the item described `desc`.
func pendingNamed(t *testing.T, s *FinanceService, desc string) ImportItemView {
	t.Helper()
	for _, it := range mustList(t, s, ImportPendiente) {
		if it.Description == desc {
			return it
		}
	}
	t.Fatalf("%q is not pending", desc)
	return ImportItemView{}
}

// A cartola movement that moves exactly what a registered transfer moves that
// month is suggested as that transfer; linking it adds no expense, each leg of
// a month takes one movement, and deleting the transfer lets it be reviewed again.
func TestCartolaMovementLinkedToATransfer(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2026-09", true)
	mustOK(t, "itau", itau.Error)
	mp := s.CreateAccount(ctx, "Mercado Pago", "digital", "0", "2026-09", false)
	mustOK(t, "mp", mp.Error)
	load := s.CreateTransfer(ctx, itau.Data.ID, mp.Data.ID, "Carga Mercado Pago", TransferFixed, "50000", "2026-09", true)
	mustOK(t, "load", load.Error)

	out := stageOne(t, s, ImportCandidate{Date: "2026-09-15", Description: "TRANSFERENCIA A MERCADOPAGO", Amount: "50000"})
	if out.SuggestedTransferID == nil || *out.SuggestedTransferID != load.Data.ID ||
		out.SuggestedTransferPeriod != "2026-09" || out.SuggestedTransferDescription != "Carga Mercado Pago" {
		t.Fatalf("suggestion = %v %q %q, want the Mercado Pago load of 2026-09",
			out.SuggestedTransferID, out.SuggestedTransferPeriod, out.SuggestedTransferDescription)
	}
	if other := stageOne(t, s, ImportCandidate{Date: "2026-09-16", Description: "COMPRA FERIA", Amount: "49990"}); other.SuggestedTransferID != nil {
		t.Fatalf("a different amount was suggested as a transfer: %+v", other)
	}

	wantCode(t, "a month it does not move", s.LinkImportItemToTransfer(ctx, out.ID, load.Data.ID, "2026-08").Error, shared.ErrValidation)
	wantCode(t, "an unknown transfer", s.LinkImportItemToTransfer(ctx, out.ID, 999, "2026-09").Error, shared.ErrNotFound)
	mustOK(t, "LinkImportItemToTransfer", s.LinkImportItemToTransfer(ctx, out.ID, load.Data.ID, "2026-09").Error)
	wantMoney(t, "September gastos", monthly(t, s, "2026-09").Gastos, "0")

	// The same charge again: that leg is taken.
	again := stageOne(t, s, ImportCandidate{Date: "2026-09-20", Description: "TRANSFERENCIA A MERCADO PAGO", Amount: "50000"})
	if again.SuggestedTransferID != nil {
		t.Fatalf("a linked leg is suggested again: %+v", again)
	}
	wantCode(t, "the same leg twice", s.LinkImportItemToTransfer(ctx, again.ID, load.Data.ID, "2026-09").Error, shared.ErrConflict)
	// The other leg — the credit in Mercado Pago's statement — is its own.
	in := stageOne(t, s, ImportCandidate{Date: "2026-09-15", Description: "CARGA DESDE ITAU", Amount: "50000", Kind: ImportKindCredit})
	if in.SuggestedTransferID == nil || *in.SuggestedTransferID != load.Data.ID {
		t.Fatalf("the credit leg = %+v, want the same transfer", in)
	}
	mustOK(t, "credit leg", s.LinkImportItemToTransfer(ctx, in.ID, load.Data.ID, "2026-09").Error)

	confirmed := mustList(t, s, ImportConfirmado)
	if len(confirmed) != 2 || confirmed[0].TransferID == nil || confirmed[0].Reopenable {
		t.Fatalf("confirmed = %+v, want both legs linked and not reopenable", confirmed)
	}
	mustOK(t, "DeleteTransfer", s.DeleteTransfer(ctx, load.Data.ID).Error)
	for _, it := range mustList(t, s, ImportConfirmado) {
		if !it.Reopenable {
			t.Fatalf("%q is not reopenable after its transfer was deleted", it.Description)
		}
	}
	mustOK(t, "RestoreImportItem", s.RestoreImportItem(ctx, out.ID).Error)
	if back := pendingNamed(t, s, "TRANSFERENCIA A MERCADOPAGO"); back.TransferID != nil || back.TransferPeriod != "" {
		t.Fatalf("reopened = %+v, want the link forgotten", back)
	}
}

// A salary_rest transfer moves the month's salary minus what stays: that is
// the amount a charge must have to be its leg.
func TestSalaryRestTransferSuggestion(t *testing.T) {
	ctx := t.Context()
	s := newTestService(t)
	chile := s.CreateAccount(ctx, "Banco de Chile", "corriente", "0", "2026-09", true)
	mustOK(t, "chile", chile.Error)
	itau := s.CreateAccount(ctx, "Itaú", "corriente", "0", "2026-09", false)
	mustOK(t, "itau", itau.Error)
	mustOK(t, "rest", s.CreateTransfer(ctx, chile.Data.ID, itau.Data.ID, "", TransferSalaryRest, "470000", "2026-09", true).Error)
	mustOK(t, "SetSalary", s.SetSalary(ctx, "2026-09", "2300000").Error)

	it := stageOne(t, s, ImportCandidate{Date: "2026-09-30", Description: "TRASPASO A CTA ITAU", Amount: "1830000"})
	if it.SuggestedTransferID == nil || it.SuggestedTransferDescription != "Banco de Chile → Itaú" {
		t.Fatalf("suggestion = %v %q, want the salary rest named by its accounts", it.SuggestedTransferID, it.SuggestedTransferDescription)
	}
}

// The same bank movement imported from another format (the cartola's PDF, then
// its CSV) is flagged on the later sighting only, and nothing is removed.
func TestDuplicateAcrossFormats(t *testing.T) {
	s := newTestService(t)
	pdf := stageOne(t, s, ImportCandidate{Date: "2026-09-10", Description: "COMPRA PANADERIA LA ESPIGA", Amount: "8450"})
	mustStage(t, s, ImportBatch{Source: ImportSourceCSV, Issuer: "Itaú CSV", Items: []ImportCandidate{
		{Date: "2026-09-11", Description: "Compra Panaderia La Espiga", Amount: "8450"},
		{Date: "2026-09-11", Description: "Farmacia Ahumada", Amount: "8450"},    // same amount, another shop
		{Date: "2026-09-14", Description: "Panaderia La Espiga", Amount: "8450"}, // three days apart
	}})
	if again := pendingNamed(t, s, "COMPRA PANADERIA LA ESPIGA"); again.DuplicateItemID != nil {
		t.Fatalf("the first sighting is flagged: %+v", again)
	}
	csv := pendingNamed(t, s, "Compra Panaderia La Espiga")
	if csv.DuplicateItemID == nil || *csv.DuplicateItemID != pdf.ID || csv.DuplicateItemSource != ImportSourcePDFAccount ||
		csv.DuplicateItemStatus != ImportPendiente || csv.DuplicateItemDescription != "COMPRA PANADERIA LA ESPIGA" {
		t.Fatalf("CSV sighting = %+v, want it flagged as the PDF's", csv)
	}
	for _, desc := range []string{"Farmacia Ahumada", "Panaderia La Espiga"} {
		if v := pendingNamed(t, s, desc); v.DuplicateItemID != nil {
			t.Fatalf("%q was flagged as a duplicate", desc)
		}
	}
	if n := len(mustList(t, s, ImportPendiente)); n != 4 {
		t.Fatalf("pending = %d, want all 4 kept", n)
	}
}
