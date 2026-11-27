package importers

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/reeper316099/classpad/internal/jsonstore"
)

// Archive is a read-only view of an export. Nothing is ever extracted to disk, so a zip entry
// can't write outside where it should (zip-slip).
type Archive interface {
	Files() []string // sorted like JavaScript's default sort
	Has(p string) bool
	Read(p string) ([]byte, error)
}

const (
	maxEntries = 50_000
	maxTotal   = 1 << 30
)

func sortJS(xs []string) []string {
	sort.SliceStable(xs, func(i, j int) bool { return utf16Less(xs[i], xs[j]) })
	return xs
}

type memArchive struct {
	files []string
	data  map[string][]byte
}

func (a *memArchive) Files() []string   { return a.files }
func (a *memArchive) Has(p string) bool { _, ok := a.data[p]; return ok }
func (a *memArchive) Read(p string) ([]byte, error) {
	b, ok := a.data[p]
	if !ok {
		return nil, fmt.Errorf("missing archive entry: %s", p)
	}
	return b, nil
}

// OpenMemory is an archive of files held in memory.
func OpenMemory(files map[string][]byte) Archive {
	a := &memArchive{data: files}
	for k := range files {
		a.files = append(a.files, k)
	}
	sortJS(a.files)
	return a
}

var zipName = regexp.MustCompile(`(?i)\.zip$`)
var contentName = regexp.MustCompile(`(?i)\.(csv|md)$`)

// OpenZip reads a zip export. Some exports wrap everything in one nested zip; that one is opened
// instead.
func OpenZip(buf []byte) (Archive, error) {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		return nil, err
	}
	var entries []*zip.File
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") || strings.HasPrefix(f.Name, "__MACOSX/") {
			continue
		}
		entries = append(entries, f)
	}
	if len(entries) > maxEntries {
		return nil, errors.New("archive has too many entries")
	}
	var total uint64
	for _, f := range entries {
		total += f.UncompressedSize64
	}
	if total > maxTotal {
		return nil, errors.New("archive is too large when uncompressed")
	}
	byName := map[string]*zip.File{}
	var order []string
	for _, f := range entries {
		n := strings.ReplaceAll(f.Name, `\`, "/")
		if _, ok := byName[n]; !ok {
			order = append(order, n)
		}
		byName[n] = f
	}
	data := map[string][]byte{}
	for n, f := range byName {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxTotal+1))
		rc.Close()
		if err != nil {
			return nil, err
		}
		data[n] = b
	}
	a := &memArchive{files: sortJS(order), data: data}
	hasContent := false
	var nested []string
	for _, f := range a.files {
		hasContent = hasContent || contentName.MatchString(f)
		if zipName.MatchString(f) {
			nested = append(nested, f)
		}
	}
	if !hasContent && len(nested) == 1 {
		return OpenZip(a.data[nested[0]])
	}
	return a, nil
}

// OpenDir reads an unzipped export folder.
func OpenDir(dir string) (Archive, error) {
	var files []string
	var walk func(rel string) error
	walk = func(rel string) error {
		entries, err := os.ReadDir(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return err
		}
		for _, e := range entries {
			r := e.Name()
			if rel != "" {
				r = rel + "/" + r
			}
			st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(r)))
			if err != nil {
				return err
			}
			if st.IsDir() {
				if err := walk(r); err != nil {
					return err
				}
			} else {
				files = append(files, r)
			}
		}
		return nil
	}
	if err := walk(""); err != nil {
		return nil, err
	}
	set := map[string]bool{}
	for _, f := range files {
		set[f] = true
	}
	return &dirArchive{dir: dir, files: sortJS(files), set: set}, nil
}

type dirArchive struct {
	dir   string
	files []string
	set   map[string]bool
}

func (a *dirArchive) Files() []string   { return a.files }
func (a *dirArchive) Has(p string) bool { return a.set[p] }
func (a *dirArchive) Read(p string) ([]byte, error) {
	return os.ReadFile(filepath.Join(a.dir, filepath.FromSlash(p)))
}

// readText decodes a file like Node's buffer.toString('utf8'): each bad byte sequence becomes
// U+FFFD the way the WHATWG decoder does it, and a BOM is kept.
func readText(a Archive, p string) string {
	b, err := a.Read(p)
	if err != nil {
		return ""
	}
	return decodeUTF8(b)
}

func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for i := 0; i < len(b); {
		r, size := utf8.DecodeRune(b[i:])
		if r != utf8.RuneError || size > 1 {
			out.WriteRune(r)
			i += size
			continue
		}
		// Invalid: skip the longest prefix of a well-formed sequence (the "maximal subpart").
		out.WriteRune(utf8.RuneError)
		i += maximalSubpart(b[i:])
	}
	return out.String()
}

func maximalSubpart(b []byte) int {
	c := b[0]
	var n int
	lo, hi := byte(0x80), byte(0xBF)
	switch {
	case c >= 0xC2 && c <= 0xDF:
		n = 2
	case c == 0xE0:
		n, lo = 3, 0xA0
	case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
		n = 3
	case c == 0xED:
		n, hi = 3, 0x9F
	case c == 0xF0:
		n, lo = 4, 0x90
	case c >= 0xF1 && c <= 0xF3:
		n = 4
	case c == 0xF4:
		n, hi = 4, 0x8F
	default:
		return 1
	}
	i := 1
	for ; i < n && i < len(b); i++ {
		x := b[i]
		if i == 1 {
			if x < lo || x > hi {
				return 1
			}
		} else if x < 0x80 || x > 0xBF {
			return i
		}
	}
	return i
}

// ---------------- Classpad backups ----------------

// Backup is a Classpad backup file (schema version 1). Entities stay as parsed JSON.
type Backup struct {
	Format         string `json:"format"`
	SchemaVersion  int    `json:"schemaVersion"`
	ExportedAt     string `json:"exportedAt"`
	Semesters      []any  `json:"semesters"`
	Classes        []any  `json:"classes"`
	Assignments    []any  `json:"assignments"`
	Tasks          []any  `json:"tasks"`
	Readings       []any  `json:"readings"`
	Notes          []any  `json:"notes"`
	Journal        []any  `json:"journal"`
	Contacts       []any  `json:"contacts"`
	Activities     []any  `json:"activities"`
	Jobs           []any  `json:"jobs"`
	Admissions     []any  `json:"admissions"`
	Budget         []any  `json:"budget"`
	Flashcards     []any  `json:"flashcards"`
	Attachments    []any  `json:"attachments"`
	GradingSchemes []any  `json:"gradingSchemes"`
	GpaScales      []any  `json:"gpaScales"`
}

// ParseBackup checks and reads a backup file; missing or non-list collections become empty.
func ParseBackup(text string) (*Backup, error) {
	raw, err := jsonstore.ParseJSON(text)
	if err != nil {
		return nil, errors.New("Not valid JSON")
	}
	m, _ := raw.(map[string]any)
	if m == nil || m["format"] != "classpad-backup" {
		return nil, errors.New("Not a Classpad backup file")
	}
	if v, ok := m["schemaVersion"].(float64); !ok || v != 1 {
		got := "undefined"
		if sv, present := m["schemaVersion"]; present {
			got = jsString(sv)
		}
		return nil, fmt.Errorf("Unsupported backup version %s", got)
	}
	arr := func(k string) []any {
		if a, ok := m[k].([]any); ok {
			return a
		}
		return []any{}
	}
	exported := ""
	if v, ok := m["exportedAt"]; ok && v != nil {
		exported = jsString(v)
	}
	return &Backup{
		Format: "classpad-backup", SchemaVersion: 1, ExportedAt: exported,
		Semesters: arr("semesters"), Classes: arr("classes"), Assignments: arr("assignments"),
		Tasks: arr("tasks"), Readings: arr("readings"), Notes: arr("notes"), Journal: arr("journal"),
		Contacts: arr("contacts"), Activities: arr("activities"), Jobs: arr("jobs"),
		Admissions: arr("admissions"), Budget: arr("budget"), Flashcards: arr("flashcards"),
		Attachments: arr("attachments"), GradingSchemes: arr("gradingSchemes"), GpaScales: arr("gpaScales"),
	}, nil
}

// jsString is String(v) for a parsed JSON or YAML value.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		switch {
		case math.IsNaN(x):
			return "NaN"
		case math.IsInf(x, 1):
			return "Infinity"
		case math.IsInf(x, -1):
			return "-Infinity"
		}
		return jsonstore.JSNumber(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}
