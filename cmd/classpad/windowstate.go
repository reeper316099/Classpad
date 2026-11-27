package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

type savedBounds struct {
	X         *int `json:"x,omitempty"`
	Y         *int `json:"y,omitempty"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized,omitempty"`
}

// windowState remembers the main window's size and position between launches, and never restores
// it off-screen (the same rules as the Electron shell had).
type windowState struct {
	file   string
	bounds savedBounds
	mu     sync.Mutex
	timer  *time.Timer
}

func loadWindowState(file string) *windowState {
	ws := &windowState{file: file, bounds: savedBounds{Width: 1280, Height: 820}}
	var s savedBounds
	b, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(b, &s) != nil {
		return ws
	}
	ws.bounds.Maximized = s.Maximized
	if s.X == nil || s.Y == nil || s.Width <= 0 || s.Height <= 0 || !visible(s) {
		return ws
	}
	ws.bounds = savedBounds{X: s.X, Y: s.Y, Width: max(800, s.Width), Height: max(560, s.Height), Maximized: s.Maximized}
	return ws
}

// visible: at least a 100px square of the window shows on some display.
func visible(s savedBounds) bool {
	app := application.Get()
	if app == nil {
		return false
	}
	for _, d := range app.Screen.GetAll() {
		a := d.WorkArea
		if *s.X+s.Width-100 > a.X && *s.X+100 < a.X+a.Width && *s.Y+100 < a.Y+a.Height && *s.Y >= a.Y-20 {
			return true
		}
	}
	return false
}

func (ws *windowState) track(w *application.WebviewWindow) {
	save := func(*application.WindowEvent) {
		ws.mu.Lock()
		defer ws.mu.Unlock()
		if ws.timer != nil {
			ws.timer.Stop()
		}
		ws.timer = time.AfterFunc(400*time.Millisecond, func() { application.InvokeSync(func() { ws.write(w) }) })
	}
	for _, e := range []events.WindowEventType{events.Common.WindowDidResize, events.Common.WindowDidMove,
		events.Common.WindowMaximise, events.Common.WindowUnMaximise} {
		w.OnWindowEvent(e, save)
	}
	w.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { ws.write(w) })
}

func (ws *windowState) write(w *application.WebviewWindow) {
	s := savedBounds{Maximized: w.IsMaximised()}
	if s.Maximized {
		s.X, s.Y, s.Width, s.Height = ws.bounds.X, ws.bounds.Y, ws.bounds.Width, ws.bounds.Height
	} else {
		r := w.Bounds()
		x, y := r.X, r.Y
		s.X, s.Y, s.Width, s.Height = &x, &y, r.Width, r.Height
		ws.bounds = s
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	_ = os.MkdirAll(filepath.Dir(ws.file), 0o755)
	tmp := ws.file + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, ws.file)
	}
}
