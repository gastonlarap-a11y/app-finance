package reports

import (
	"context"
	"fmt"
	"maps"
	"slices"

	"github.com/xuri/excelize/v2"
)

// ReportsService exports tabular data to .xlsx and returns the raw bytes. The
// frontend turns the bytes into a Blob + URL.createObjectURL to trigger a download.
type ReportsService struct{}

func NewReportsService() *ReportsService { return &ReportsService{} }

func (s *ReportsService) ServiceName() string { return "ReportsService" }

// ExportToExcel writes rows as a sheet: one header row (the first row's keys,
// sorted) and one row per entry.
func (s *ReportsService) ExportToExcel(ctx context.Context, rows []map[string]any, sheet string) ([]byte, error) {
	if sheet == "" {
		sheet = "Sheet1"
	}
	f := excelize.NewFile()
	defer f.Close()
	if sheet != "Sheet1" {
		if err := f.SetSheetName("Sheet1", sheet); err != nil {
			return nil, fmt.Errorf("renombrar hoja: %w", err)
		}
	}

	if len(rows) > 0 {
		headers := slices.Sorted(maps.Keys(rows[0]))
		for c, h := range headers {
			if err := setCell(f, sheet, c+1, 1, h); err != nil {
				return nil, err
			}
		}
		for r, row := range rows {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			for c, h := range headers {
				if err := setCell(f, sheet, c+1, r+2, row[h]); err != nil {
					return nil, err
				}
			}
		}
	}

	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func setCell(f *excelize.File, sheet string, col, row int, value any) error {
	cell, err := excelize.CoordinatesToCellName(col, row)
	if err != nil {
		return fmt.Errorf("celda (%d,%d): %w", col, row, err)
	}
	if err := f.SetCellValue(sheet, cell, value); err != nil {
		return fmt.Errorf("celda %s: %w", cell, err)
	}
	return nil
}
