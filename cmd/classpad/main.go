// Command classpad is the Classpad desktop app: the web interface in the operating system's own web
// view (Wails), with the API (internal/server) running in the same process. The web view calls the
// API directly through the app's request handler, so the API never listens on a network port.
//
// Build the web interface first (npm run build -w @classpad/web, then node scripts/build-desktop.mjs
// copies it into cmd/classpad/web), then go build ./cmd/classpad.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/reeper316099/classpad/internal/server"
)

//go:embed all:web
var webFiles embed.FS

// version is set at build time (-ldflags "-X main.version=1.2.3").
var version = "dev"

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func main() {
	selfTest := os.Getenv("CLASSPAD_SELFTEST") == "1"
	dataDir := server.DefaultDataDir()
	web, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err)
	}
	if _, err := fs.Stat(web, "index.html"); err != nil {
		fmt.Fprintln(os.Stderr, "classpad: the web interface is missing; run node scripts/build-desktop.mjs first")
		os.Exit(1)
	}

	shell := &Shell{dataDir: dataDir, token: randomHex(32), selfTest: selfTest}
	app := application.New(application.Options{
		Name:        server.AppName,
		Description: "A local-first student workspace",
		Services:    []application.Service{application.NewService(shell)},
		Assets:      application.AssetOptions{Handler: shell, DisableLogging: true},
		LogLevel:    slog.LevelWarn,
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               "dev.classpad.app",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) { shell.focusMain() },
		},
		Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: false},
		OnShutdown: func() {
			if shell.api != nil {
				shell.api.Close() // releases the data folder lock and flushes the file watcher
			}
		},
	})
	shell.app = app

	// the API, in this process: its handler serves the page and the API on the web view's own origin
	api, err := server.NewApp(server.AppOptions{
		DataDir: dataDir, Token: shell.token, Watch: true, StaticFS: web, InProcess: true,
		Log: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) },
	})
	if err != nil {
		app.Dialog.Error().SetTitle(server.AppName + " could not start").
			SetMessage(err.Error() + "\n\nIs " + server.AppName + " already running?").Show()
		os.Exit(1)
	}
	shell.api = api
	if err := shell.prepare(web); err != nil {
		panic(err)
	}
	// live updates reach the page as app events (a web view request cannot stream on every platform)
	api.Ctx.Bus.On(func(ev server.Event) { app.Event.Emit("classpad:event", ev) })

	app.Menu.SetApplicationMenu(shell.buildMenu(runtime.GOOS == "darwin"))
	// the window opens once the app runs: restoring its position needs the list of screens
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		shell.openMain()
	})

	if err := app.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "classpad:", err)
		os.Exit(1)
	}
	os.Exit(shell.exitCode)
}
