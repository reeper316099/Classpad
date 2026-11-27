package jsonstore

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Ports of packages/jsonstore/src/store.test.ts and crypto.test.ts.

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func disk(t *testing.T, dir, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	must(t, err)
	return string(b)
}

func put(t *testing.T, dir, rel, text string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	must(t, os.MkdirAll(filepath.Dir(p), 0o755))
	must(t, os.WriteFile(p, []byte(text), 0o644))
}

func code(err error) string { return ErrorCode(err) }

// schema: { schemaVersion: number, items: { id: string }[] }
func schema(v any) (any, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("not an object")
	}
	if _, ok := m["schemaVersion"].(float64); !ok {
		return nil, errors.New("schemaVersion Expected number")
	}
	items, ok := m["items"].([]any)
	if !ok {
		return nil, errors.New("items Expected array")
	}
	for _, it := range items {
		o, ok := it.(map[string]any)
		if !ok {
			return nil, errors.New("items Expected object")
		}
		if _, ok := o["id"].(string); !ok {
			return nil, errors.New("items.id Expected string")
		}
	}
	return v, nil
}

func fallback() any { return map[string]any{"schemaVersion": 1.0, "items": []any{}} }

func items(v any) []any { return v.(map[string]any)["items"].([]any) }

func TestStableWrites(t *testing.T) {
	s, dir := open(t)
	must(t, s.WriteJSON("a/b.json", map[string]any{"z": 1, "a": map[string]any{"y": 2, "b": 3}}, nil))
	if got := disk(t, dir, "a/b.json"); got != "{\n  \"a\": {\n    \"b\": 3,\n    \"y\": 2\n  },\n  \"z\": 1\n}\n" {
		t.Fatalf("%q", got)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "a"))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatal("temp file left behind")
		}
	}
	// invalid data is refused and the old file kept
	must(t, s.WriteJSON("x.json", fallback(), schema))
	if err := s.WriteJSON("x.json", map[string]any{"schemaVersion": "no"}, schema); err == nil {
		t.Fatal("invalid data written")
	}
	v, err := s.ReadJSON("x.json", ReadOptions{Validate: schema})
	must(t, err)
	if len(items(v)) != 0 {
		t.Fatal(v)
	}
	// path traversal
	if code(s.WriteText("../evil.txt", "x")) != CodePath {
		t.Fatal("wrote outside the folder")
	}
	if _, err := s.Resolve("a/../../x"); err == nil {
		t.Fatal("resolved outside the folder")
	}
	// structs and nil-able fields
	type T struct {
		B int  `json:"b"`
		A *int `json:"a,omitempty"`
	}
	got, err := StableStringify(T{B: 1})
	must(t, err)
	if got != "{\n  \"b\": 1\n}\n" {
		t.Fatalf("%q", got)
	}
}

func TestConcurrentUpdates(t *testing.T) {
	s, _ := open(t)
	must(t, s.WriteJSON("c.json", map[string]any{"n": 0}, nil))
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Update("c.json", func(c any) (any, error) {
				m := c.(map[string]any)
				return map[string]any{"n": m["n"].(float64) + 1}, nil
			}, ReadOptions{Fallback: func() any { return map[string]any{"n": 0.0} }})
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	v, err := s.ReadJSON("c.json", ReadOptions{})
	must(t, err)
	if n := v.(map[string]any)["n"]; n != 50.0 {
		t.Fatalf("n = %v, want 50", n)
	}
}

func TestKeyedMutex(t *testing.T) {
	var m KeyedMutex
	if err := m.Run("k", func() error { return errors.New("x") }); err == nil {
		t.Fatal("error lost")
	}
	got := 0
	must(t, m.Run("k", func() error { got = 5; return nil }))
	if got != 5 || len(m.locks) != 0 {
		t.Fatal("queue blocked or key kept")
	}
}

func TestCorruptionRecovery(t *testing.T) {
	s, dir := open(t)
	must(t, s.WriteJSON("d.json", map[string]any{"schemaVersion": 1, "items": []any{map[string]any{"id": "good"}}}, nil))
	_, err := s.Backup("test", 20)
	must(t, err)
	put(t, dir, "d.json", "{ not json")
	var events []string
	s.OnEvent(func(e Event) { events = append(events, e.Kind) })
	v, err := s.ReadJSON("d.json", ReadOptions{Validate: schema})
	must(t, err)
	if items(v)[0].(map[string]any)["id"] != "good" {
		t.Fatal(v)
	}
	if strings.Join(events, ",") != "quarantined,restored" {
		t.Fatal(events)
	}
	q, _ := os.ReadDir(filepath.Join(dir, "quarantine"))
	if len(q) != 1 {
		t.Fatal(len(q))
	}

	put(t, dir, "e.json", "{ nope")
	v, err = s.ReadJSON("e.json", ReadOptions{Validate: schema, Fallback: fallback})
	must(t, err)
	if len(items(v)) != 0 {
		t.Fatal(v)
	}
	put(t, dir, "f.json", "{ nope")
	if _, err := s.ReadJSON("f.json", ReadOptions{Validate: schema}); code(err) != CodeCorrupt {
		t.Fatal(err)
	}
	put(t, dir, "g.json", `{"schemaVersion":"x"}`)
	if _, err := s.ReadJSON("g.json", ReadOptions{Validate: schema}); code(err) != CodeCorrupt {
		t.Fatal(err)
	}
	put(t, dir, "h.json", "{\n  \"a\": 1\n}\n trailing")
	_, err = s.ReadJSON("h.json", ReadOptions{})
	var se *StoreError
	if !errors.As(err, &se) || se.Code != CodeCorrupt || se.Line != 4 {
		t.Fatalf("%#v", err)
	}
}

var migrations = Migrations{
	1: func(d Versioned) Versioned {
		out := Versioned{}
		for k, v := range d {
			out[k] = v
		}
		var its []any
		for _, it := range d["items"].([]any) {
			o := map[string]any{"v2": true}
			for k, v := range it.(map[string]any) {
				o[k] = v
			}
			its = append(its, o)
		}
		out["items"] = its
		return out
	},
}

func TestMigrations(t *testing.T) {
	out, err := Migrate(Versioned{"schemaVersion": 1.0, "items": []any{map[string]any{"id": "a"}}}, 2, migrations)
	must(t, err)
	if out["schemaVersion"] != 2.0 || out["items"].([]any)[0].(map[string]any)["v2"] != true {
		t.Fatal(out)
	}
	if _, err := Migrate(Versioned{"schemaVersion": 9.0}, 2, migrations); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatal(err)
	}
	if _, err := Migrate(Versioned{"schemaVersion": 0.0}, 2, migrations); err == nil || !strings.Contains(err.Error(), "no migration") {
		t.Fatal(err)
	}

	s, dir := open(t)
	must(t, s.WriteJSON("m.json", map[string]any{"schemaVersion": 1, "items": []any{map[string]any{"id": "a"}}}, nil))
	doc, err := s.ReadVersioned("m.json", VersionedOptions{Version: 2, Migrations: migrations,
		Fallback: func() any { return map[string]any{"schemaVersion": 2.0, "items": []any{}} }})
	must(t, err)
	if doc.(map[string]any)["schemaVersion"] != 2.0 {
		t.Fatal(doc)
	}
	bs, _ := ListBackups(dir)
	if len(bs) != 1 || !strings.Contains(bs[0], "pre-migration") {
		t.Fatal(bs)
	}
	if !strings.Contains(disk(t, dir, "m.json"), `"schemaVersion": 2`) {
		t.Fatal(disk(t, dir, "m.json"))
	}
}

func TestBatch(t *testing.T) {
	s, _ := open(t)
	must(t, s.WriteText("a.txt", "A"))
	must(t, s.Batch([]Op{{Type: "move", From: "a.txt", To: "sub/b.txt"}, {Type: "write", Rel: "c.txt", Text: "C"}}))
	if _, ok, _ := s.ReadText("a.txt"); ok {
		t.Fatal("not moved")
	}
	if b, _, _ := s.ReadText("sub/b.txt"); b != "A" {
		t.Fatal(b)
	}

	must(t, s.WriteText("a.txt", "A"))
	err := s.Batch([]Op{
		{Type: "write", Rel: "a.txt", Text: "CHANGED"},
		{Type: "write", Rel: "n.txt", Text: "N"},
		{Type: "move", From: "missing.txt", To: "z.txt"},
	})
	if err == nil {
		t.Fatal("batch should fail")
	}
	if a, _, _ := s.ReadText("a.txt"); a != "A" {
		t.Fatal("not rolled back:", a)
	}
	if _, ok, _ := s.ReadText("n.txt"); ok {
		t.Fatal("n.txt left behind")
	}
}

func TestBackupsAndLock(t *testing.T) {
	s, dir := open(t)
	must(t, s.WriteText("x.txt", "1"))
	must(t, s.WriteText("attachments/big.bin", "zzz"))
	for i := range 4 {
		_, err := s.Backup(fmt.Sprintf("r%d", i), 3)
		must(t, err)
		time.Sleep(5 * time.Millisecond)
	}
	bs, _ := ListBackups(dir)
	if len(bs) != 3 {
		t.Fatal(bs)
	}
	if f, err := s.BackupIfStale(time.Hour); err != nil || f != "" {
		t.Fatal("backed up although fresh", f, err)
	}
	if f, err := s.BackupIfStale(time.Nanosecond); err != nil || f == "" {
		t.Fatal("stale backup skipped", err)
	}

	// a live foreign process holds the lock (our parent is always alive)
	other := t.TempDir()
	put(t, other, ".lock", strconv.Itoa(os.Getppid()))
	if _, err := Open(other, true); code(err) != CodeLocked {
		t.Fatal(err)
	}
	// a stale lock is taken over
	put(t, other, ".lock", "999999999")
	s2, err := Open(other, true)
	must(t, err)
	s2.Close()
	if _, err := os.Stat(filepath.Join(other, ".lock")); !os.IsNotExist(err) {
		t.Fatal("lock not released")
	}
}

func waitFor(cond func() bool) {
	for i := 0; i < 50 && !cond(); i++ {
		time.Sleep(50 * time.Millisecond)
	}
}

type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) add(e Event) { r.mu.Lock(); r.events = append(r.events, e); r.mu.Unlock() }
func (r *recorder) has(kind, rel string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.events {
		if e.Kind == kind && (rel == "" || e.Rel == rel) {
			return true
		}
	}
	return false
}

func TestWatching(t *testing.T) {
	s, dir := open(t)
	s.RegisterValidator(func(r string) bool { return strings.HasSuffix(r, ".json") }, func(text, _ string) error {
		v, err := ParseJSON(text)
		if err != nil {
			return err
		}
		_, err = schema(v)
		return err
	})
	must(t, s.WriteJSON("w.json", fallback(), nil))
	must(t, s.Watch())
	var r recorder
	s.OnEvent(r.add)
	must(t, s.WriteJSON("w.json", map[string]any{"schemaVersion": 1, "items": []any{map[string]any{"id": "own"}}}, nil))
	time.Sleep(400 * time.Millisecond)
	if r.has(EventExternalChange, "") {
		t.Fatal("own write reported")
	}
	put(t, dir, "w.json", `{"schemaVersion":1,"items":[{"id":"hand"}]}`)
	waitFor(func() bool { return r.has(EventExternalChange, "w.json") })
	if !r.has(EventExternalChange, "w.json") {
		t.Fatal("hand edit not reported")
	}
	put(t, dir, "w.json", "{\n  \"schemaVersion\": 1,\n  oops\n}")
	waitFor(func() bool { return r.has(EventInvalidEdit, "w.json") })
	r.mu.Lock()
	var bad *Event
	for i := range r.events {
		if r.events[i].Kind == EventInvalidEdit {
			bad = &r.events[i]
		}
	}
	r.mu.Unlock()
	if bad == nil || bad.Line <= 0 {
		t.Fatalf("invalid edit: %+v", bad)
	}
	// new folders are watched too, and deletions are reported
	put(t, dir, "data/new/n.json", fmt.Sprintf(`{"schemaVersion":1,"items":[]}`))
	waitFor(func() bool { return r.has(EventExternalChange, "data/new/n.json") })
	must(t, os.Remove(filepath.Join(dir, "data/new/n.json")))
	time.Sleep(300 * time.Millisecond)
	if !r.has(EventExternalChange, "data/new/n.json") {
		t.Fatal("new folder not watched")
	}
}

func TestWatchingIgnoresSockets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Chromium's SingletonSocket is a Unix socket")
	}
	s, dir := open(t)
	// Unix socket paths are short; use a short folder for it.
	sockDir, err := os.MkdirTemp("", "cp")
	must(t, err)
	defer os.RemoveAll(sockDir)
	_ = dir
	s2, err := Open(sockDir, true)
	must(t, err)
	defer s2.Close()
	ln, err := net.Listen("unix", filepath.Join(sockDir, "SingletonSocket"))
	must(t, err)
	defer ln.Close()
	must(t, s2.Watch())
	var r recorder
	s2.OnEvent(r.add)
	time.Sleep(200 * time.Millisecond)
	put(t, sockDir, "ordinary.json", `{"a":1}`)
	waitFor(func() bool { return r.has(EventExternalChange, "ordinary.json") })
	if !r.has(EventExternalChange, "ordinary.json") || r.has(EventExternalChange, "SingletonSocket") {
		t.Fatal(r.events)
	}
	_ = s
}

// ---------- encryption ----------

const secret = "my very private diary line"

func key(t *testing.T, pass string) []byte {
	t.Helper()
	k, err := DeriveKey(pass, NewSalt())
	must(t, err)
	return k
}

func policy(k []byte, prefixes ...string) *Crypto {
	return &Crypto{Key: k, ShouldEncrypt: func(rel string) bool {
		for _, p := range prefixes {
			if strings.HasPrefix(rel, p) {
				return true
			}
		}
		return false
	}}
}

func TestCryptoPrimitives(t *testing.T) {
	k := key(t, "correct horse")
	a, _ := EncryptText(k, "data/x.json", secret)
	b, _ := EncryptText(k, "data/x.json", secret)
	if a == b || strings.Contains(a, "private") || !IsEnvelope(a) {
		t.Fatal(a)
	}
	if p, err := DecryptText(k, "data/x.json", a); err != nil || p != secret {
		t.Fatal(p, err)
	}
	if _, err := DecryptText(key(t, "wrong"), "data/x.json", a); code(err) != CodeDecrypt {
		t.Fatal(err)
	}
	if _, err := DecryptText(k, "data/y.json", a); code(err) != CodeDecrypt {
		t.Fatal("ciphertext moved to another file was accepted")
	}
	tampered := strings.Replace(a, `"data":"`, `"data":"A`, 1)
	if _, err := DecryptText(k, "data/x.json", tampered); code(err) != CodeDecrypt {
		t.Fatal("tampering accepted")
	}

	salt := NewSalt()
	hash, err := DeriveKey("pass phrase", salt)
	must(t, err)
	for pass, want := range map[string]bool{"pass phrase": true, "pass phrase ": false, "PASS PHRASE": false} {
		if ok, _ := VerifyHash(pass, salt, hash); ok != want {
			t.Fatalf("%q: %v", pass, ok)
		}
	}
	// "café" typed as one character or as e + combining accent
	k1, _ := DeriveKey("café", salt)
	k2, _ := DeriveKey("café", salt)
	if string(k1) != string(k2) {
		t.Fatal("unicode not normalized")
	}
}

func TestStoreWithEncryption(t *testing.T) {
	s, dir := open(t)
	k := key(t, "correct horse")
	s.SetCrypto(policy(k, "data/journal/"))
	must(t, s.WriteJSON("data/journal/2031-01.json", map[string]any{"note": secret}, nil))
	must(t, s.WriteJSON("data/tasks/tasks.json", map[string]any{"note": "not secret"}, nil))
	must(t, s.WriteBinary("data/journal/pic.bin", []byte{1, 2, 3}))
	if strings.Contains(disk(t, dir, "data/journal/2031-01.json"), "private") || !strings.Contains(disk(t, dir, "data/tasks/tasks.json"), "not secret") {
		t.Fatal("wrong files encrypted")
	}
	v, err := s.ReadJSON("data/journal/2031-01.json", ReadOptions{})
	must(t, err)
	if v.(map[string]any)["note"] != secret {
		t.Fatal(v)
	}
	if b, _ := s.ReadBinary("data/journal/pic.bin"); string(b) != "\x01\x02\x03" {
		t.Fatal(b)
	}

	// locked: encrypted files refuse, plain ones work, nothing is quarantined
	s.SetCrypto(nil)
	if _, err := s.ReadJSON("data/journal/2031-01.json", ReadOptions{}); code(err) != CodeEncrypted {
		t.Fatal(err)
	}
	if _, err := s.ReadJSON("data/tasks/tasks.json", ReadOptions{}); err != nil {
		t.Fatal(err)
	}
	s.SetCrypto(&Crypto{Key: key(t, "wrong"), ShouldEncrypt: func(string) bool { return true }})
	if _, err := s.ReadJSON("data/journal/2031-01.json", ReadOptions{}); code(err) != CodeDecrypt {
		t.Fatal(err)
	}
	if !IsEnvelope(disk(t, dir, "data/journal/2031-01.json")) {
		t.Fatal("file changed")
	}
	if _, err := os.Stat(filepath.Join(dir, "quarantine")); !os.IsNotExist(err) {
		t.Fatal("quarantined an encrypted file")
	}

	// rollback keeps encrypted files encrypted
	s.SetCrypto(policy(k, "data/"))
	must(t, s.WriteText("data/a.txt", "A"))
	if s.Batch([]Op{{Type: "write", Rel: "data/a.txt", Text: "B"}, {Type: "move", From: "data/missing", To: "data/z"}}) == nil {
		t.Fatal("batch should fail")
	}
	if a, _, _ := s.ReadText("data/a.txt"); a != "A" || !IsEnvelope(disk(t, dir, "data/a.txt")) {
		t.Fatal(a)
	}
}

func TestReencryptAll(t *testing.T) {
	s, dir := open(t)
	k := key(t, "correct horse")
	must(t, s.WriteJSON("data/journal/a.json", map[string]any{"v": secret}, nil))
	must(t, s.WriteText("data/notes/n.md", "# hi\n"))
	_, err := s.ReencryptAll(policy(k, "data/journal/"), false)
	must(t, err)
	if !IsEnvelope(disk(t, dir, "data/journal/a.json")) || disk(t, dir, "data/notes/n.md") != "# hi\n" {
		t.Fatal("wrong files encrypted")
	}
	_, err = s.ReencryptAll(policy(key(t, "another"), "data/"), false)
	must(t, err)
	if !IsEnvelope(disk(t, dir, "data/notes/n.md")) {
		t.Fatal("not encrypted")
	}
	if n, _, _ := s.ReadText("data/notes/n.md"); n != "# hi\n" {
		t.Fatal(n)
	}
	time.Sleep(2 * time.Millisecond) // backup names have millisecond stamps
	_, err = s.ReencryptAll(nil, false)
	must(t, err)
	if !strings.Contains(disk(t, dir, "data/journal/a.json"), "private") {
		t.Fatal("not decrypted")
	}
	bs, _ := s.List("backups", "", false)
	n := 0
	for _, b := range bs {
		if strings.Contains(b, "pre-encryption") {
			n++
		}
	}
	if n != 3 {
		t.Fatal(bs)
	}
}

func TestWatcherDecryptsHandEdits(t *testing.T) {
	s, dir := open(t)
	k := key(t, "correct horse")
	s.SetCrypto(policy(k, "data/"))
	must(t, s.WriteJSON("data/c.json", map[string]any{"ok": true}, nil))
	s.RegisterValidator(func(r string) bool { return r == "data/c.json" }, func(text, _ string) error {
		v, err := ParseJSON(text)
		if err != nil {
			return err
		}
		if v.(map[string]any)["ok"] != true {
			return errors.New("not ok")
		}
		return nil
	})
	must(t, s.Watch())
	var r recorder
	s.OnEvent(r.add)
	time.Sleep(200 * time.Millisecond)
	env, _ := EncryptText(k, "data/c.json", `{"ok":true,"extra":1}`)
	put(t, dir, "data/c.json", env)
	waitFor(func() bool { return r.has(EventExternalChange, "data/c.json") })
	if !r.has(EventExternalChange, "data/c.json") {
		t.Fatal(r.events)
	}
}

// The data folder is also the desktop shell's folder: Chromium's lock files never go in a backup.
func TestBackupSkipsShellLockFiles(t *testing.T) {
	s, dir := open(t)
	must(t, s.WriteText("x.txt", "1"))
	for _, name := range []string{"lockfile", "SingletonCookie"} {
		must(t, os.WriteFile(filepath.Join(dir, name), []byte("held"), 0o644))
	}
	files, err := backupFiles(dir)
	must(t, err)
	for _, f := range files {
		if f == "lockfile" || f == "SingletonCookie" {
			t.Fatalf("backup includes %s: %v", f, files)
		}
	}
}
