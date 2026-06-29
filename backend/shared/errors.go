package shared

// AppError is a business-logic error returned inside a service Result.
// System errors (DB/file I/O) should be returned as native Go errors instead,
// which Wails v3 rejects the TypeScript Promise with.
type AppError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Standard error codes — extend per project.
const (
	ErrNotFound   = "NOT_FOUND"
	ErrValidation = "VALIDATION_ERROR"
	ErrConflict   = "CONFLICT"
	ErrForbidden  = "FORBIDDEN"
	ErrInternal   = "INTERNAL_ERROR"
)

func NewError(code, message string) *AppError {
	return &AppError{Code: code, Message: message}
}

func (e *AppError) Error() string { return e.Code + ": " + e.Message }
