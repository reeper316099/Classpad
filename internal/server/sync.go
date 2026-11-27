package server

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/reeper316099/classpad/internal/jsv"
)

const SyncFolder = "Classpad Export"
const syncManifest = ".classpad-export.json"

const syncReadme = `This folder is written by Classpad and replaced on every export.
Do not edit files here: your changes will be overwritten. Classpad never reads it back.

  classpad-backup.json   everything, re-importable with Import > JSON backup
  gradebook.csv          one row per assignment with class grades
  csv/                   one CSV per collection
  calendar/              deadlines.ics and timetable.ics
  notes/                 your notes as Markdown files
`

// inside is whether child is parent or below it.
func inside(parent, child string) bool {
	r, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return r == "." || (!strings.HasPrefix(r, "..") && !filepath.IsAbs(r))
}

func unsafeRel(rel string) bool {
	if strings.HasPrefix(rel, "/") {
		return true
	}
	for _, p := range strings.Split(rel, "/") {
		if p == ".." {
			return true
		}
	}
	return false
}

// SyncToFolder is a one-way export to a folder other apps read (a spreadsheet, a calendar, a notes
// app, a backup tool). Everything goes into a "Classpad Export" subfolder that Classpad owns; nothing
// outside it is touched.
func (c *Context) SyncToFolder(dataDir, dir string) (*jsv.Obj, error) {
	if !filepath.IsAbs(dir) {
		return nil, apiErr(422, "BAD_PATH", "Choose a full folder path")
	}
	base := filepath.Clean(dir)
	if filepath.VolumeName(base)+string(filepath.Separator) == base {
		return nil, apiErr(422, "BAD_PATH", "Choose a folder, not the top of a drive")
	}
	data, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	if inside(data, base) {
		return nil, apiErr(422, "BAD_PATH", "The export folder cannot be inside Classpad’s own data folder")
	}
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		return nil, apiErr(422, "BAD_PATH", "That folder does not exist")
	}

	target := filepath.Join(base, SyncFolder)
	var previous []string
	if tst, err := os.Lstat(target); err == nil {
		if !tst.IsDir() || tst.Mode()&fs.ModeSymlink != 0 {
			return nil, apiErr(409, "NOT_OURS", fmt.Sprintf(`"%s" exists and is not a plain folder`, SyncFolder))
		}
		m, err := os.ReadFile(filepath.Join(target, syncManifest))
		if err != nil {
			entries, rerr := os.ReadDir(target)
			if rerr != nil {
				return nil, rerr
			}
			if len(entries) > 0 {
				return nil, apiErr(409, "NOT_OURS", fmt.Sprintf(`"%s" already exists and was not created by Classpad. Rename or remove it first.`, SyncFolder))
			}
		} else {
			v, err := jsv.Parse(string(m))
			if err != nil {
				return nil, err
			}
			if o, ok := v.(*jsv.Obj); ok {
				previous = o.Strings("files")
			}
		}
	}

	type file struct {
		rel  string
		data []byte
	}
	var files []file
	index := map[string]int{}
	set := func(rel string, data []byte) {
		if i, ok := index[rel]; ok {
			files[i].data = data
			return
		}
		index[rel] = len(files)
		files = append(files, file{rel, data})
	}
	set("README.txt", []byte(syncReadme))
	set("classpad-backup.json", []byte(jsv.Stringify(c.ExportJSON(), "  ")))
	set("gradebook.csv", []byte(c.ExportGradebook()))
	for _, col := range CSVCollections {
		set("csv/"+col+".csv", []byte(c.ExportCSV(col)))
	}
	set("calendar/deadlines.ics", []byte(c.ExportICS("deadlines")))
	set("calendar/timetable.ics", []byte(c.ExportICS("timetable")))
	vault, err := c.ExportMarkdownVault()
	if err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(vault), int64(len(vault)))
	if err != nil {
		return nil, err
	}
	for _, e := range zr.File {
		if e.FileInfo().IsDir() {
			continue
		}
		rel := strings.ReplaceAll(e.Name, `\`, "/")
		if unsafeRel(rel) {
			continue // never trust zip paths
		}
		rc, err := e.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
		set("notes/"+rel, b)
	}

	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, err
	}
	total := 0
	for _, f := range files {
		dest := filepath.Join(target, filepath.FromSlash(f.rel))
		if !inside(target, dest) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return nil, err
		}
		tmp := dest + ".tmp"
		if err := os.WriteFile(tmp, f.data, 0o644); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, dest); err != nil {
			return nil, err
		}
		total += len(f.data)
	}
	// remove only files an earlier export wrote and this one no longer has (renamed or deleted notes)
	for _, rel := range previous {
		if _, ok := index[rel]; ok || unsafeRel(rel) {
			continue
		}
		if err := os.Remove(filepath.Join(target, filepath.FromSlash(rel))); err != nil && !errors.Is(err, fs.ErrNotExist) {
			continue
		}
	}
	exportedAt := nowISO()
	names := make([]any, len(files))
	for i, f := range files {
		names[i] = f.rel
	}
	man := jsv.O("format", "classpad-export", "version", 1.0, "exportedAt", exportedAt, "files", names)
	if err := os.WriteFile(filepath.Join(target, syncManifest), []byte(jsv.Stringify(man, "  ")), 0o644); err != nil {
		return nil, err
	}
	return jsv.O("folder", target, "files", float64(len(files)), "bytes", float64(total), "exportedAt", exportedAt), nil
}
