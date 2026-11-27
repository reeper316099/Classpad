package server

import (
	"os"
	"path/filepath"
	"runtime"
)

// DefaultDataDir is the per-OS data directory; CLASSPAD_DATA_DIR overrides it. Same rule as
// packages/server's defaultDataDir.
func DefaultDataDir() string {
	if d := os.Getenv("CLASSPAD_DATA_DIR"); d != "" {
		if abs, err := filepath.Abs(d); err == nil {
			return abs
		}
		return d
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if a := os.Getenv("APPDATA"); a != "" {
			return filepath.Join(a, AppName)
		}
		return filepath.Join(home, "AppData", "Roaming", AppName)
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", AppName)
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, AppName)
	}
	return filepath.Join(home, ".config", AppName)
}
