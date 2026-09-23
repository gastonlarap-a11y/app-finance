package reports

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/shopspring/decimal"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/xuri/excelize/v2"

	"github.com/gastonlarap-a11y/app-finance/backend/shared"
)

// Column kinds of an ExportTable: how each cell is written to the sheet.
const (
	KindText  = "text"
	KindMoney = "money" // decimal string → numeric cell with CLP format
	KindInt   = "int"
)

// ExportColumn describes one column of an ExportTable.
type ExportColumn struct {
	Title string `json:"title"`
	Kind  string `json:"kind"` // text | money | int
}

// ExportTable is a sheet ready to write: the frontend builds it from the data it
// already shows (month, year, search), so export stays in sync with the views.
// Cells are strings; money cells hold the backend's decimal strings.
type ExportTable struct {
	Sheet   string         `json:"sheet"`
	Columns []ExportColumn `json:"columns"`
	Rows    [][]string     `json:"rows"`
}

// SaveResult reports where the file was written, or that the user canceled.
type SaveResult struct {
	Path     string           `json:"path,omitempty"`
	Canceled bool             `json:"canceled,omitempty"`
	Error    *shared.AppError `json:"error,omitempty"`
}

// ReportsService exports tables to .xlsx files chosen with the native Save dialog
// (a webview blob download is unreliable in WKWebView/WebView2).
type ReportsService struct{}

func NewReportsService() *ReportsService { return &ReportsService{} }

func (s *ReportsService) ServiceName() string { return "ReportsService" }

// SaveTable asks where to save `filename` (.xlsx) and writes the table there.
func (s *ReportsService) SaveTable(ctx context.Context, table ExportTable, filename string) SaveResult {
	data, err := buildWorkbook(ctx, table)
	if err != nil {
		return SaveResult{Error: shared.NewError(shared.ErrValidation, err.Error())}
	}
	if !strings.HasSuffix(strings.ToLower(filename), ".xlsx") {
		filename += ".xlsx"
	}
	path, err := application.Get().Dialog.SaveFile().
		SetFilename(filename).
		AddFilter("Excel", "*.xlsx").
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return SaveResult{Error: shared.NewError(shared.ErrInternal, err.Error())}
	}
	if path == "" {
		return SaveResult{Canceled: true}
	}
	if !strings.HasSuffix(strings.ToLower(path), ".xlsx") {
		path += ".xlsx"
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return SaveResult{Error: shared.NewError(shared.ErrInternal, fmt.Sprintf("guardar %s: %v", path, err))}
	}
	return SaveResult{Path: path}
}

// buildWorkbook renders the table as an .xlsx: bold header, money as numbers
// with a CLP format (so sums/filters work in Excel), ints as numbers.
func buildWorkbook(ctx context.Context, table ExportTable) ([]byte, error) {
	if len(table.Columns) == 0 {
		return nil, errors.New("la tabla no tiene columnas")
	}
	sheet := strings.TrimSpace(table.Sheet)
	if sheet == "" {
		sheet = "Datos"
	}
	f := excelize.NewFile()
	defer f.Close()
	if err := f.SetSheetName("Sheet1", sheet); err != nil {
		return nil, fmt.Errorf("nombre de hoja: %w", err)
	}
	header, err := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	if err != nil {
		return nil, err
	}
	clpFmt := `"$"#,##0;-"$"#,##0`
	money, err := f.NewStyle(&excelize.Style{CustomNumFmt: &clpFmt})
	if err != nil {
		return nil, err
	}

	for c, col := range table.Columns {
		if err := setCell(f, sheet, c+1, 1, col.Title, header); err != nil {
			return nil, err
		}
		colName, err := excelize.ColumnNumberToName(c + 1)
		if err != nil {
			return nil, err
		}
		width := max(12, float64(len([]rune(col.Title))+4))
		if err := f.SetColWidth(sheet, colName, colName, width); err != nil {
			return nil, err
		}
	}
	for r, row := range table.Rows {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(row) != len(table.Columns) {
			return nil, fmt.Errorf("fila %d: %d celdas, se esperaban %d", r+1, len(row), len(table.Columns))
		}
		for c, raw := range row {
			value, style, err := cellValue(table.Columns[c].Kind, raw, money)
			if err != nil {
				return nil, fmt.Errorf("fila %d, columna %q: %w", r+1, table.Columns[c].Title, err)
			}
			if err := setCell(f, sheet, c+1, r+2, value, style); err != nil {
				return nil, err
			}
		}
	}

	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// cellValue converts a raw cell string according to its column kind. Empty
// money/int cells stay empty.
func cellValue(kind, raw string, moneyStyle int) (any, int, error) {
	if raw == "" || kind == KindText || kind == "" {
		return raw, 0, nil
	}
	switch kind {
	case KindMoney:
		d, err := decimal.NewFromString(raw)
		if err != nil {
			return nil, 0, fmt.Errorf("monto inválido %q", raw)
		}
		return d.InexactFloat64(), moneyStyle, nil // Excel stores doubles; CLP fits exactly
	case KindInt:
		n, err := strconv.Atoi(raw)
		if err != nil {
			return nil, 0, fmt.Errorf("entero inválido %q", raw)
		}
		return n, 0, nil
	default:
		return nil, 0, fmt.Errorf("tipo de columna desconocido %q", kind)
	}
}

func setCell(f *excelize.File, sheet string, col, row int, value any, style int) error {
	cell, err := excelize.CoordinatesToCellName(col, row)
	if err != nil {
		return fmt.Errorf("celda (%d,%d): %w", col, row, err)
	}
	if err := f.SetCellValue(sheet, cell, value); err != nil {
		return fmt.Errorf("celda %s: %w", cell, err)
	}
	if style != 0 {
		if err := f.SetCellStyle(sheet, cell, cell, style); err != nil {
			return fmt.Errorf("estilo %s: %w", cell, err)
		}
	}
	return nil
}
