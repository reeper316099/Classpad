package jsonstore

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Versioned is a `{ "schemaVersion": n, ... }` document.
type Versioned = map[string]any

// Migrations: Migrations[n] upgrades a version-n document to version n+1.
type Migrations map[int]func(Versioned) Versioned

// Migrate upgrades doc to the target schema version, one step at a time.
func Migrate(doc Versioned, target int, migrations Migrations) (Versioned, error) {
	start := 0
	if v, ok := doc["schemaVersion"].(float64); ok {
		start = int(v)
	}
	if start > target {
		return nil, storeErr(CodeInvalid, "", fmt.Sprintf("file is from a newer version (%d > %d)", start, target))
	}
	cur := doc
	for v := start; v < target; v++ {
		step := migrations[v]
		if step == nil {
			return nil, storeErr(CodeInvalid, "", fmt.Sprintf("no migration from schemaVersion %d", v))
		}
		next := Versioned{}
		for k, x := range step(cur) {
			next[k] = x
		}
		next["schemaVersion"] = float64(v + 1)
		cur = next
	}
	return cur, nil
}

// backupExclude lists top-level folders and files never put in a backup. The data folder is also the
// desktop shell's own folder, so Chromium's single-instance lock files are skipped too: they hold no
// data, and on Windows "lockfile" is open with delete-on-close, which Go's os.Open cannot share.
var backupExclude = map[string]bool{
	"electron": true, "backups": true, "quarantine": true, "logs": true,
	"attachments": true, "imports": true, "exports": true, ".lock": true,
	"lockfile": true, "SingletonLock": true, "SingletonSocket": true, "SingletonCookie": true,
}

func backupFiles(root string) ([]string, error) {
	var out []string
	var walk func(rel string) error
	walk = func(rel string) error {
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return err
		}
		for _, e := range entries {
			r := e.Name()
			if rel != "" {
				r = rel + "/" + r
			}
			if rel == "" && backupExclude[e.Name()] {
				continue
			}
			if strings.HasSuffix(e.Name(), ".tmp") {
				continue
			}
			if e.IsDir() {
				if err := walk(r); err != nil {
					return err
				}
			} else if e.Type().IsRegular() {
				out = append(out, r)
			}
		}
		return nil
	}
	return out, walk("")
}

// isoStamp is new Date().toISOString() with ":" and "." replaced by "-".
func isoStamp(t time.Time) string {
	return strings.NewReplacer(":", "-", ".", "-").Replace(t.UTC().Format("2006-01-02T15:04:05.000Z"))
}

var notReasonChar = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// CreateBackup zips the data folder into backups/backup-<time>-<reason>.zip and keeps the newest
// `keep` backups. It returns the new file's path.
func CreateBackup(root, reason string, keep int) (string, error) {
	dir := filepath.Join(root, "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	files, err := backupFiles(root)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		st, _ := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		h := &zip.FileHeader{Name: rel, Method: zip.Deflate}
		if st != nil {
			h.Modified = st.ModTime()
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			return "", err
		}
		if _, err := w.Write(data); err != nil {
			return "", err
		}
	}
	if err := zw.Close(); err != nil {
		return "", err
	}
	file := filepath.Join(dir, fmt.Sprintf("backup-%s-%s.zip", isoStamp(time.Now()), notReasonChar.ReplaceAllString(reason, "")))
	if err := os.WriteFile(file, buf.Bytes(), 0o644); err != nil {
		return "", err
	}
	all, _ := ListBackups(root)
	for _, old := range all[:max(0, len(all)-keep)] {
		os.Remove(filepath.Join(dir, old))
	}
	return file, nil
}

// ListBackups lists backup zip names, oldest first.
func ListBackups(root string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root, "backups"))
	if err != nil {
		return []string{}, nil
	}
	out := []string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".zip") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

// readFromLatestBackup returns the newest backed-up copy of a file, if any backup has it.
func readFromLatestBackup(root, rel string) (string, bool) {
	all, _ := ListBackups(root)
	for i := len(all) - 1; i >= 0; i-- {
		zr, err := zip.OpenReader(filepath.Join(root, "backups", all[i]))
		if err != nil {
			continue
		}
		for _, f := range zr.File {
			if path.Clean(f.Name) != rel {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				break
			}
			data, err := io.ReadAll(rc)
			rc.Close()
			if err == nil {
				zr.Close()
				return string(data), true
			}
		}
		zr.Close()
	}
	return "", false
}
