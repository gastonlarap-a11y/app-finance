package reports

import (
	"bytes"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestBuildWorkbook(t *testing.T) {
	table := ExportTable{
		Sheet: "Septiembre 2026",
		Columns: []ExportColumn{
			{Title: "Descripción", Kind: KindText},
			{Title: "Monto", Kind: KindMoney},
			{Title: "Cuotas", Kind: KindInt},
		},
		Rows: [][]string{
			{"Notebook", "180000", "3"},
			{"Sin monto", "", ""},
		},
	}
	data, err := buildWorkbook(t.Context(), table)
	if err != nil {
		t.Fatalf("buildWorkbook: %v", err)
	}
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer f.Close()

	tests := []struct {
		cell, want string
	}{
		{"A1", "Descripción"},
		{"A2", "Notebook"},
		{"B2", "$180,000"}, // formatted with the CLP number format
		{"C2", "3"},
		{"B3", ""},
	}
	for _, tt := range tests {
		t.Run(tt.cell, func(t *testing.T) {
			got, err := f.GetCellValue("Septiembre 2026", tt.cell)
			if err != nil || got != tt.want {
				t.Fatalf("%s = %q (err %v), want %q", tt.cell, got, err, tt.want)
			}
		})
	}
	typ, err := f.GetCellType("Septiembre 2026", "B2")
	if err != nil || typ == excelize.CellTypeInlineString || typ == excelize.CellTypeSharedString {
		t.Fatalf("B2 type = %v (err %v), want numeric", typ, err)
	}
}

func TestBuildWorkbookRejectsBadInput(t *testing.T) {
	tests := []struct {
		name  string
		table ExportTable
	}{
		{"sin columnas", ExportTable{}},
		{"fila corta", ExportTable{Columns: []ExportColumn{{Title: "A"}, {Title: "B"}}, Rows: [][]string{{"x"}}}},
		{"monto inválido", ExportTable{Columns: []ExportColumn{{Title: "M", Kind: KindMoney}}, Rows: [][]string{{"abc"}}}},
		{"tipo desconocido", ExportTable{Columns: []ExportColumn{{Title: "X", Kind: "date"}}, Rows: [][]string{{"1"}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := buildWorkbook(t.Context(), tt.table); err == nil {
				t.Fatalf("buildWorkbook(%s) = nil error", tt.name)
			}
		})
	}
}
