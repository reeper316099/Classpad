package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/reeper316099/classpad/internal/frontmatter"
	"github.com/reeper316099/classpad/internal/importers"
	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

// ------------------------------------------------------------------ note templates

const templatesDir = "config/templates/notes"

// Placeholders {{title}}, {{date}} and {{class}} are filled in by the app when a note is created.
var defaultTemplates = [][3]string{
	{"lecture", "Lecture notes", "# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Key ideas\n\n- \n\n## Details\n\n\n## Questions\n\n- [ ] \n\n## Summary\n\n"},
	{"cornell", "Cornell notes", "# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Cues / questions\n\n- \n\n## Notes\n\n\n## Summary\n\n> Write a two-sentence summary in your own words.\n"},
	{"lab-report", "Lab report", "# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Purpose\n\n\n## Hypothesis\n\n\n## Method\n\n1. \n\n## Data\n\n| Trial | Measurement | Notes |\n| --- | --- | --- |\n|  |  |  |\n\n## Analysis\n\nUse math like $v = \\frac{d}{t}$ where needed.\n\n## Conclusion\n\n"},
	{"reading-notes", "Reading notes", "# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Source\n\n\n## Main argument\n\n\n## Quotes & page numbers\n\n> \n\n## My reaction\n\n"},
	{"problem-set", "Problem set", "# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Problem 1\n\n**Approach:**\n\n**Work:**\n\n$$\n\n$$\n\n**Answer:**\n\n## Problem 2\n\n"},
}

var reTemplateID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,60}$`)

type Templates struct{ store *jsonstore.Store }

func NewTemplates(store *jsonstore.Store) *Templates { return &Templates{store: store} }

// Seed writes the built-in templates the first time (never overwrites yours).
func (t *Templates) Seed() error {
	list, err := t.store.List(templatesDir, ".md", false)
	if err != nil || len(list) > 0 {
		return err
	}
	for _, d := range defaultTemplates {
		if err := t.write(d[0], d[1], d[2]); err != nil {
			return err
		}
	}
	return nil
}

func (t *Templates) write(id, name, markdown string) error {
	return t.store.WriteText(templatesDir+"/"+id+".md", frontmatter.Stringify(markdown, jsv.O("name", name)))
}

func (t *Templates) List() ([]any, error) {
	files, err := t.store.List(templatesDir, ".md", false)
	if err != nil {
		return nil, err
	}
	type tpl struct {
		name string
		o    *jsv.Obj
	}
	var out []tpl
	for _, rel := range files {
		text, ok, err := t.store.ReadText(rel)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		id := strings.TrimSuffix(path.Base(rel), ".md")
		fallback := strings.ReplaceAll(id, "-", " ")
		name, md := fallback, text
		if fm, err := frontmatter.Parse(text); err == nil {
			md = fm.Content
			if v, ok := fm.Data["name"]; ok && v != nil {
				name = jsString(toJSV(v))
			}
		}
		out = append(out, tpl{name, jsv.O("id", id, "name", name, "markdown", md)})
	}
	sort.SliceStable(out, func(i, j int) bool { return localeCompare(out[i].name, out[j].name) < 0 })
	res := make([]any, len(out))
	for i, x := range out {
		res[i] = x.o
	}
	return res, nil
}

func (t *Templates) Save(name, markdown, id string) (any, error) {
	slug := id
	if slug == "" {
		slug = Slugify(name)
	}
	if !reTemplateID.MatchString(slug) {
		return nil, apiErr(400, "BAD_ID", "invalid template id")
	}
	if err := t.write(slug, name, markdown); err != nil {
		return nil, err
	}
	return jsv.O("id", slug, "name", name, "markdown", markdown), nil
}

func (t *Templates) Remove(id string) error {
	if !reTemplateID.MatchString(id) {
		return apiErr(400, "BAD_ID", "invalid template id")
	}
	return t.store.Remove(templatesDir + "/" + id + ".md")
}

// ------------------------------------------------------------------ attachments

var attachmentMIME = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
	"svg": "image/svg+xml", "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown",
	"csv": "text/csv", "json": "application/json",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"mp3":  "audio/mpeg", "mp4": "video/mp4", "zip": "application/zip",
}

const MaxAttachmentBytes = 50 * 1024 * 1024

// Types a browser could execute in the app origin are always served as downloads.
var inlineSafe = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
	"application/pdf": true, "text/plain": true, "audio/mpeg": true, "video/mp4": true,
}

func IsInlineSafe(mime string) bool { return inlineSafe[mime] }

var reExt = regexp.MustCompile(`\.([A-Za-z0-9]{1,8})$`)

func ExtOf(filename string) string {
	if m := reExt.FindStringSubmatch(filename); m != nil {
		return strings.ToLower(m[1])
	}
	return "bin"
}

var reBadFilenameChar = regexp.MustCompile(`[\\/\x00-\x1f]`)

// Attachments are content-addressed files under attachments/<sha256>.<ext>.
type Attachments struct {
	store *jsonstore.Store
	repo  *Repo
}

func NewAttachments(store *jsonstore.Store, repo *Repo) *Attachments {
	return &Attachments{store: store, repo: repo}
}

func (a *Attachments) Add(filename string, data []byte) (*jsv.Obj, bool, error) {
	if len(data) > MaxAttachmentBytes {
		return nil, false, apiErr(413, "TOO_LARGE", "attachment exceeds 50 MB")
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	for _, x := range a.repo.List() {
		if x.Str("hash") == hash {
			return x, false, nil
		}
	}
	ext := ExtOf(filename)
	rel := "attachments/" + hash + "." + ext
	if err := a.store.WriteBinary(rel, data); err != nil {
		return nil, false, err
	}
	clean := utf16Slice(reBadFilenameChar.ReplaceAllString(filename, "_"), 0, 200)
	if clean == "" {
		clean = "file"
	}
	mime := attachmentMIME[ext]
	if mime == "" {
		mime = "application/octet-stream"
	}
	rec, err := a.repo.Create(jsv.O("filename", clean, "mime", mime, "size", float64(len(data)), "hash", hash, "path", rel))
	if err != nil {
		return nil, false, err
	}
	return rec, true, nil
}

// AttachmentLink is the link form used inside Markdown.
func AttachmentLink(a *jsv.Obj) string {
	return "attachment://" + a.Str("hash") + "." + ExtOf(a.Str("path"))
}

func (a *Attachments) Read(rec *jsv.Obj) ([]byte, error) {
	b, err := a.store.ReadBinary(rec.Str("path"))
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, apiErr(404, "NOT_FOUND", "attachment file is missing")
	}
	return b, nil
}

func (a *Attachments) Remove(rec *jsv.Obj) error {
	if err := a.repo.Delete(rec.Str("id")); err != nil {
		return err
	}
	return a.store.Remove(rec.Str("path"))
}

// ------------------------------------------------------------------ mapping plugins

const (
	pluginsDir     = "plugins"
	maxPluginFiles = 50
	maxPluginBytes = 64 * 1024
)

// PluginListing: plugins are plain JSON in <data folder>/plugins/, validated and never executed.
type PluginListing struct {
	Builtin []any
	User    []*jsv.Obj // with "file"
	Errors  []any
}

func (l PluginListing) JSON() *jsv.Obj {
	user := make([]any, len(l.User))
	for i, u := range l.User {
		user[i] = u
	}
	return jsv.O("builtin", l.Builtin, "user", user, "errors", l.Errors)
}

func builtinPlugins() []any {
	out := []any{}
	for _, p := range importers.BuiltinMappings {
		v, _ := schema.Parse(schema.MappingPlugin, jsv.FromGo(p))
		out = append(out, v)
	}
	return out
}

func pluginErrorMessage(err error) string {
	if se, ok := asSchema(err); ok {
		parts := make([]string, len(se.Issues))
		for i, is := range se.Issues {
			p := is.PathString()
			if p == "" {
				p = "file"
			}
			parts[i] = p + ": " + is.Message
		}
		return strings.Join(parts, "; ")
	}
	return err.Error()
}

func ListPlugins(store *jsonstore.Store) (PluginListing, error) {
	out := PluginListing{Builtin: builtinPlugins(), User: []*jsv.Obj{}, Errors: []any{}}
	files, err := store.List(pluginsDir, ".json", true)
	if err != nil {
		return out, err
	}
	if len(files) > maxPluginFiles {
		files = files[:maxPluginFiles]
	}
	taken := map[string]bool{}
	for _, p := range importers.BuiltinMappings {
		taken[p.ID] = true
	}
	for _, file := range files {
		p, err := func() (*jsv.Obj, error) {
			text, ok, err := store.ReadText(file)
			if err != nil || !ok {
				return nil, err
			}
			if utf16Len(text) > maxPluginBytes {
				return nil, errors.New("file is larger than 64 KB")
			}
			v, err := jsv.Parse(text)
			if err != nil {
				return nil, err
			}
			parsed, err := schema.Parse(schema.MappingPlugin, v)
			if err != nil {
				return nil, err
			}
			p := parsed.(*jsv.Obj)
			if taken[p.Str("id")] {
				return nil, fmt.Errorf(`id "%s" is already used`, p.Str("id"))
			}
			taken[p.Str("id")] = true
			return p.Clone().Set("file", file), nil
		}()
		if err != nil {
			out.Errors = append(out.Errors, jsv.O("file", file, "message", pluginErrorMessage(err)))
		} else if p != nil {
			out.User = append(out.User, p)
		}
	}
	return out, nil
}

// FindPlugin returns a mapping plugin by id, in the importers' form.
func FindPlugin(store *jsonstore.Store, id string) (*importers.MappingPlugin, error) {
	for i := range importers.BuiltinMappings {
		if importers.BuiltinMappings[i].ID == id {
			p := importers.BuiltinMappings[i]
			return &p, nil
		}
	}
	l, err := ListPlugins(store)
	if err != nil {
		return nil, err
	}
	for _, u := range l.User {
		if u.Str("id") == id {
			o := u.Clone()
			o.Delete("file")
			var p importers.MappingPlugin
			if err := fromJSON(o, &p); err != nil {
				return nil, err
			}
			return &p, nil
		}
	}
	return nil, nil
}

// ------------------------------------------------------------------ static files

var staticMIME = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
	".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
	".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
}

// AppCSP is the policy for the app shell: everything from this origin, nothing remote.
// 'wasm-unsafe-eval' lets the page compile the note editor's WebAssembly core; it does not allow
// eval() of JavaScript.
const AppCSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

type StaticFile struct {
	Body      []byte
	Type      string
	Immutable bool
}

var reHashedName = regexp.MustCompile(`[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$`)

// ReadStatic resolves a URL path to a file under root, never outside it. Unknown paths without an
// extension fall back to index.html (client-side routes); missing assets give nil.
func ReadStatic(root, urlPath string) *StaticFile {
	p := strings.SplitN(strings.SplitN(urlPath, "?", 2)[0], "#", 2)[0]
	rel, err := url.PathUnescape(p)
	if err != nil || strings.Contains(rel, "\x00") {
		return nil
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return nil
	}
	file := filepath.Join(base, filepath.FromSlash(path.Clean("/"+rel)))
	if file != base && !strings.HasPrefix(file, base+string(filepath.Separator)) {
		return nil
	}
	try := func(f string) *StaticFile {
		st, err := os.Stat(f)
		if err != nil || !st.Mode().IsRegular() {
			return nil
		}
		body, err := os.ReadFile(f)
		if err != nil {
			return nil
		}
		typ := staticMIME[strings.ToLower(filepath.Ext(f))]
		if typ == "" {
			typ = "application/octet-stream"
		}
		sep := string(filepath.Separator)
		return &StaticFile{Body: body, Type: typ,
			Immutable: reHashedName.MatchString(filepath.Base(f)) && strings.Contains(f, sep+"assets"+sep)}
	}
	target := file
	if file == base {
		target = filepath.Join(base, "index.html")
	}
	if f := try(target); f != nil {
		return f
	}
	if nodeExt(rel) != "" {
		return nil
	}
	return try(filepath.Join(base, "index.html"))
}

// nodeExt is path.extname: no extension when the only dot leads the name (".hidden") or for "..".
func nodeExt(p string) string {
	b := path.Base(p)
	if i := strings.LastIndexByte(b, '.'); i > 0 && b != ".." {
		return b[i:]
	}
	return ""
}
