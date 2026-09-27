package windowstate

import "testing"

func TestStateClamped(t *testing.T) {
	tests := []struct {
		name string
		in   State
		want State
	}{
		{"large enough stays", State{X: 10, Y: 20, W: 1400, H: 900}, State{X: 10, Y: 20, W: 1400, H: 900}},
		{"narrow window widens", State{X: 10, Y: 20, W: 800, H: 900}, State{X: 10, Y: 20, W: MinWidth, H: 900}},
		{"short window grows", State{W: 1400, H: 500}, State{W: 1400, H: MinHeight}},
		{"tiny window takes the minimum", State{W: 300, H: 200, Maximized: true}, State{W: MinWidth, H: MinHeight, Maximized: true}},
		{"exact minimum stays", State{W: MinWidth, H: MinHeight}, State{W: MinWidth, H: MinHeight}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.in.Clamped(); got != tt.want {
				t.Errorf("Clamped() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestDefaultStateFitsTheMinimum(t *testing.T) {
	if d := defaultState(); d != d.Clamped() {
		t.Errorf("default window %+v is below the minimum %dx%d", d, MinWidth, MinHeight)
	}
}
