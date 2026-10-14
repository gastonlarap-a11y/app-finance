// Package application stubs the part of Wails' API codemap recognizes: the
// import path ends like github.com/wailsapp/wails/v3/pkg/application.
package application

// Service is a registered service.
type Service struct{ instance any }

// NewService binds the exported methods of *T to the frontend.
func NewService[T any](instance *T) Service { return Service{instance: instance} }
