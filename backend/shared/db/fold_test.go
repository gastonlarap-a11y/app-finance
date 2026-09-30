package db

import "testing"

func TestFold(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Café", "cafe"},
		{"ÑUÑOA", "nunoa"},
		{"Árbol ÉXITO pingüino", "arbol exito pinguino"},
		{"100%_off", "100%_off"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := Fold(tt.in)
			if err != nil || got != tt.want {
				t.Fatalf("Fold(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
			}
		})
	}
}
