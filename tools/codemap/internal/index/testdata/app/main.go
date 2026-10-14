package main

import (
	"embed"

	"example.com/app/backend/shop"
	"example.com/app/third_party/bun"
	"example.com/app/third_party/wails/v3/pkg/application"
)

// Like the real app, main embeds the built frontend, which is absent here (as
// in CI before the frontend build): the bound services must still be found.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	svc := shop.NewShopService(&bun.DB{})
	_ = []application.Service{application.NewService(svc)}
	_ = assets
}
