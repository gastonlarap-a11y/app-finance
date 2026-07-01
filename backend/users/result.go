package users

import "github.com/gastonlarap-a11y/app-finance/backend/shared"

// Concrete Result types (no generics — safest for the Wails AST binding generator).

type UserResult struct {
	Data  *User            `json:"data,omitempty"`
	Error *shared.AppError `json:"error,omitempty"`
}

type OpResult struct {
	Error *shared.AppError `json:"error,omitempty"`
}
