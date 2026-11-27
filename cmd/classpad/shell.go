package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/reeper316099/classpad/internal/server"
)

//go:embed bridge.js
var bridgeJS string

// Shell is the desktop side of the app: it serves the web view's requests and gives the page the
// few native things it needs (window.classpad, see bridge.js). Its exported methods are callable
// from the page.
type Shell struct {
	app      *application.App
	api      *server.App
	dataDir  string
	token    string
	selfTest bool
	exitCode int

	index []byte // index.html with the bridge script added
	main  *application.WebviewWindow
	mu    sync.Mutex
	state *windowState
}

const bridgePath = "/classpad-bridge.js"
const reportPath = "/__classpad/report.html"

var reScript = regexp.MustCompile(`(?i)<script\b`)

// prepare adds the bridge to the page: a module script before the app's own scripts, so
// window.classpad exists before the app reads it (module scripts run in document order).
func (s *Shell) prepare(web fs.FS) error {
	html, err := fs.ReadFile(web, "index.html")
	if err != nil {
		return err
	}
	tag := []byte(`<script type="module" src="` + bridgePath + `"></script>`)
	if loc := reScript.FindIndex(html); loc != nil {
		s.index = append(append(append([]byte{}, html[:loc[0]]...), append(tag, '\n')...), html[loc[0]:]...)
	} else if i := bytes.Index(html, []byte("</head>")); i >= 0 {
		s.index = append(append(append([]byte{}, html[:i]...), tag...), html[i:]...)
	} else {
		return errors.New("index.html has no <head>")
	}
	return nil
}

func (s *Shell) bridge() string {
	cfg, _ := json.Marshal(map[string]any{
		"token":    s.token,
		"platform": runtime.GOOS,
		"version":  version,
		"dataDir":  s.dataDir,
		"service":  "main.Shell",
		"selfTest": s.selfTest,
	})
	return strings.Replace(bridgeJS, "__CONFIG__", string(cfg), 1)
}

func isPage(p string) bool {
	return p == "/" || p == "/index.html" || (path.Ext(p) == "" && !strings.HasPrefix(p, "/api/"))
}

// ServeHTTP answers every request from the web view: the page (with the bridge), the bridge, the
// printable report, and otherwise the API and the interface files.
func (s *Shell) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	h := w.Header()
	switch {
	case r.Method == http.MethodGet && p == bridgePath:
		h.Set("Content-Type", "text/javascript; charset=utf-8")
		h.Set("Cache-Control", "no-store")
		w.Write([]byte(s.bridge()))
	case r.Method == http.MethodGet && p == reportPath:
		hide := r.URL.Query().Get("hide") == "1"
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-store")
		w.Write([]byte(s.api.Ctx.GradeReportHTML(hide)))
	case r.Method == http.MethodGet && isPage(p):
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		h.Set("Content-Security-Policy", server.AppCSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		w.Write(s.index)
	default:
		s.api.ServeHTTP(w, r)
	}
}

// ------------------------------------------------------------------ windows

func (s *Shell) openMain() {
	s.state = loadWindowState(filepath.Join(s.dataDir, "shell", "window-state.json"))
	b := s.state.bounds
	opts := application.WebviewWindowOptions{
		Name:             "main",
		Title:            server.AppName,
		URL:              "/",
		Width:            b.Width,
		Height:           b.Height,
		MinWidth:         800,
		MinHeight:        560,
		BackgroundColour: application.NewRGB(0x0d, 0x0f, 0x1a),
		DevToolsEnabled:  version == "dev",
		Hidden:           s.selfTest,
		Mac:              application.MacWindow{InvisibleTitleBarHeight: 0},
	}
	if b.X != nil && b.Y != nil {
		opts.InitialPosition = application.WindowXY
		opts.X, opts.Y = *b.X, *b.Y
	}
	if b.Maximized && !s.selfTest {
		opts.StartState = application.WindowStateMaximised
	}
	w := s.app.Window.NewWithOptions(opts)
	s.main = w
	s.state.track(w)
}

func (s *Shell) focusMain() {
	if s.main == nil {
		return
	}
	s.main.Restore()
	s.main.Show()
	s.main.Focus()
}

func (s *Shell) newReportWindow(hide bool) *application.WebviewWindow {
	q := "0"
	if hide {
		q = "1"
	}
	return s.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            server.AppName + " grade report",
		URL:              reportPath + "?hide=" + q,
		Width:            920,
		Height:           900,
		BackgroundColour: application.NewRGB(0xff, 0xff, 0xff),
		DevToolsEnabled:  version == "dev",
	})
}

// ------------------------------------------------------------------ called from the page

// OpenDataFolder shows the data folder in the file manager.
func (s *Shell) OpenDataFolder() error { return s.app.Browser.OpenFile(s.dataDir) }

// ChooseFolder asks for a folder (the export-to-folder target); "" when cancelled.
func (s *Shell) ChooseFolder() (string, error) {
	d := s.app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).
		CanCreateDirectories(true).SetTitle("Choose a folder for the export")
	if s.main != nil {
		d.AttachToWindow(s.main)
	}
	p, err := d.PromptForSingleSelection()
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "cancel") {
		return "", nil
	}
	return p, err
}

// ClipboardText is the clipboard's text, for the editor's Paste menu item (the page itself may not
// read the clipboard without a user gesture).
func (s *Shell) ClipboardText() string {
	t, _ := s.app.Clipboard.Text()
	return t
}

// OpenReport shows the printable grade report in its own window.
func (s *Shell) OpenReport(hide bool) { s.newReportWindow(hide).Show() }

// PrintReport opens the report and the system print dialog, where it can be saved as a PDF.
func (s *Shell) PrintReport() map[string]any {
	w := s.newReportWindow(false)
	w.Show()
	go func() {
		time.Sleep(700 * time.Millisecond) // the report is a small static page; let it lay out
		application.InvokeSync(func() { _ = w.Print() })
	}()
	return map[string]any{"saved": false, "printing": true}
}

var reExternal = regexp.MustCompile(`(?i)^(https://|mailto:)`)

// OpenURL opens a link in the default browser or mail app (https and mailto only).
func (s *Shell) OpenURL(u string) error {
	if !reExternal.MatchString(u) {
		return errors.New("only https and mailto links open outside the app")
	}
	return s.app.Browser.OpenURL(u)
}

var reDownload = regexp.MustCompile(`^/(export/|import/templates/)`)
var reFileName = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)

// SaveDownload saves an export: it asks where, then writes what the API returns for the path (only
// export and template routes). The file never passes through the page.
func (s *Shell) SaveDownload(apiPath, filename string) (map[string]any, error) {
	if !reDownload.MatchString(apiPath) || strings.Contains(apiPath, "..") {
		return nil, errors.New("not an export")
	}
	name := reFileName.ReplaceAllString(filename, "_")
	d := s.app.Dialog.SaveFile().SetFilename(name).CanCreateDirectories(true)
	if s.main != nil {
		d.AttachToWindow(s.main)
	}
	dest, err := d.PromptForSingleSelection()
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "cancel") || dest == "" {
		return map[string]any{"saved": false}, nil
	}
	if err != nil {
		return nil, err
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1"+apiPath, nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	rec := httptest.NewRecorder()
	s.api.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		return nil, fmt.Errorf("export failed (%d)", rec.Code)
	}
	if err := os.WriteFile(dest, rec.Body.Bytes(), 0o644); err != nil {
		return nil, err
	}
	return map[string]any{"saved": true, "path": dest}, nil
}

// SelfTestResult ends a self-test run (CLASSPAD_SELFTEST=1): the page reports what it checked.
func (s *Shell) SelfTestResult(ok bool, report string) {
	if !s.selfTest {
		return
	}
	fmt.Println(report)
	if !ok {
		s.exitCode = 1
	}
	go s.app.Quit()
}

// ------------------------------------------------------------------ the menu

type menuItem struct {
	label, action, accel string
}

func (s *Shell) send(action string) func(*application.Context) {
	return func(*application.Context) { s.app.Event.Emit("classpad:menu", action) }
}

func (s *Shell) buildMenu(mac bool) *application.Menu {
	m := s.app.Menu.New()
	if mac {
		appMenu := m.AddSubmenu(server.AppName)
		appMenu.AddRole(application.About)
		appMenu.AddSeparator()
		appMenu.Add("Settings…").SetAccelerator("CmdOrCtrl+,").OnClick(s.send("settings"))
		appMenu.AddSeparator()
		appMenu.AddRole(application.ServicesMenu)
		appMenu.AddSeparator()
		appMenu.AddRole(application.Hide)
		appMenu.AddRole(application.HideOthers)
		appMenu.AddRole(application.UnHide)
		appMenu.AddSeparator()
		appMenu.AddRole(application.Quit)
	}
	file := m.AddSubmenu("File")
	for _, it := range []menuItem{
		{"New Assignment", "new-assignment", "CmdOrCtrl+Shift+A"},
		{"New Note", "new-note", "CmdOrCtrl+Shift+N"},
		{"New Task", "new-task", "CmdOrCtrl+Shift+T"},
		{"New Class…", "new-class", ""},
		{"New Semester…", "new-semester", ""},
	} {
		item := file.Add(it.label).OnClick(s.send(it.action))
		if it.accel != "" {
			item.SetAccelerator(it.accel)
		}
	}
	file.AddSeparator()
	// the page handles Ctrl/Cmd+P and Ctrl/Cmd+K itself; a menu shortcut would take the key away
	file.Add("Open Note…").OnClick(s.send("quick-open"))
	file.Add("Command Palette…").OnClick(s.send("palette"))
	file.AddSeparator()
	file.Add("Import & Export…").OnClick(s.send("import"))
	file.Add("Print Grade Report…").OnClick(func(*application.Context) { s.PrintReport() })
	if !mac {
		file.AddSeparator()
		file.Add("Settings…").SetAccelerator("Ctrl+,").OnClick(s.send("settings"))
		file.AddRole(application.Quit)
	}
	m.AddRole(application.EditMenu)
	goMenu := m.AddSubmenu("Go")
	for i, it := range []menuItem{
		{"Dashboard", "go-dashboard", ""}, {"Classes", "go-classes", ""}, {"Assignments", "go-assignments", ""},
		{"Notes", "go-notes", ""}, {"Planner", "go-planner", ""}, {"Study", "go-study", ""},
		{"Grades", "go-grades", ""}, {"GPA", "go-gpa", ""},
	} {
		goMenu.Add(it.label).SetAccelerator("CmdOrCtrl+" + strconv.Itoa(i+1)).OnClick(s.send(it.action))
	}
	view := m.AddSubmenu("View")
	view.AddRole(application.ResetZoom)
	view.AddRole(application.ZoomIn)
	view.AddRole(application.ZoomOut)
	view.AddSeparator()
	view.AddRole(application.ToggleFullscreen)
	if version == "dev" {
		view.AddSeparator()
		view.AddRole(application.Reload)
		view.AddRole(application.OpenDevTools)
	}
	m.AddRole(application.WindowMenu)
	help := m.AddSubmenu("Help")
	// the page handles "?" itself; the menu item only shows it exists
	help.Add("Keyboard Shortcuts").OnClick(s.send("help"))
	help.Add("Show Data Folder").OnClick(func(*application.Context) { _ = s.OpenDataFolder() })
	help.Add("Your data stays on this computer").SetEnabled(false)
	help.AddSeparator()
	help.Add("Version " + version).SetEnabled(false)
	return m
}
