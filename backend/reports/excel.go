package reports

import (
	"context"
	"sort"

	"github.com/xuri/excelize/v2"
)

// ReportsService exports tabular data to .xlsx and returns the raw bytes. The
// frontend turns the bytes into a Blob + URL.createObjectURL to trigger a download.
type ReportsService struct{}

func NewReportsService() *ReportsService { return &ReportsService{} }

func (s *ReportsService) ServiceName() string { return "ReportsService" }

func (s *ReportsService) ExportToExcel(ctx context.Context, rows []map[string]any, sheet string) ([]byte, error) {
	if sheet == "" {
		sheet = "Sheet1"
	}
	f := excelize.NewFile()
	defer f.Close()
	if sheet != "Sheet1" {
		_ = f.SetSheetName("Sheet1", sheet)
	}

	if len(rows) > 0 {
		headers := make([]string, 0, len(rows[0]))
		for k := range rows[0] {
			headers = append(headers, k)
		}
		sort.Strings(headers)
		for c, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(c+1, 1)
			_ = f.SetCellValue(sheet, cell, h)
		}
		for r, row := range rows {
			for c, h := range headers {
				cell, _ := excelize.CoordinatesToCellName(c+1, r+2)
				_ = f.SetCellValue(sheet, cell, row[h])
			}
		}
	}

	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
