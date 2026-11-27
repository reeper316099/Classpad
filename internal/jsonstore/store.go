package jsonstore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Event kinds.
const (
	EventExternalChange = "external-change" // a file changed outside the app
	EventInvalidEdit    = "invalid-edit"    // a hand edit failed validation; the file was copied to quarantine/
	EventRestored       = "restored"        // a corrupt file was restored from the newest backup
	EventQuarantined    = "quarantined"     // a corrupt file was moved to quarantine/
	EventWatchError     = "watch-error"     // the watcher hit an error; watching goes on
)

type Event struct {
	Kind    string
	Rel     string
	Message string // invalid-edit
	Line    int    // invalid-edit: 1-based line of the problem, 0 if unknown
	To      string // quarantined: where the file went
	From    string // restored: "backup"
	Err     error  // watch-error
}

// Op is one step of a Batch: "write" (Rel, Text), "remove" (Rel) or "move" (From, To).
type Op struct {
	Type string
	Rel  string
	Text string
	From string
	To   string
}

// Validate checks a parsed JSON value and returns the value to use (it may fill in defaults).
type Validate func(v any) (any, error)

type ReadOptions struct {
	Validate Validate
	Fallback func() any // used when the file is missing (or corrupt with no good backup)
}

type VersionedOptions struct {
	Version    int
	Migrations Migrations
	Validate   Validate
	Fallback   func() any
}

type validator struct {
	match    func(rel string) bool
	validate func(text, rel string) error
}

// Store is an open data folder.
type Store struct {
	Root string

	mutex      KeyedMutex
	mu         sync.RWMutex // guards the fields below
	selfWrites map[string]string
	validators []validator
	crypto     *Crypto
	listeners  []func(Event)
	locked     bool
	watcher    *watcher
}

// Open opens a data folder, creating it if needed. With lock, it takes the folder's .lock file and
// fails with LOCKED if another live process holds it.
func Open(root string, lock bool) (*Store, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	s := &Store{Root: abs, selfWrites: map[string]string{}}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	if lock {
		if err := s.acquireLock(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) acquireLock() error {
	lock := filepath.Join(s.Root, ".lock")
	if b, err := os.ReadFile(lock); err == nil {
		pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		if pid > 0 && pid != os.Getpid() && processAlive(pid) {
			return storeErr(CodeLocked, lock, fmt.Sprintf("data directory is in use by process %d", pid))
		}
	}
	if err := os.WriteFile(lock, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return err
	}
	s.locked = true
	return nil
}

// OnEvent adds a listener. Listeners run on the goroutine that caused the event (the watcher's,
// for external changes).
func (s *Store) OnEvent(fn func(Event)) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

func (s *Store) emit(e Event) {
	s.mu.RLock()
	ls := append([]func(Event){}, s.listeners...)
	s.mu.RUnlock()
	for _, l := range ls {
		l(e)
	}
}

// Resolve turns a relative path into an absolute one, refusing anything outside the folder.
func (s *Store) Resolve(rel string) (string, error) {
	var abs string
	if filepath.IsAbs(rel) {
		abs = filepath.Clean(rel)
	} else {
		abs = filepath.Join(s.Root, filepath.FromSlash(rel))
	}
	if abs != s.Root && !strings.HasPrefix(abs, s.Root+string(filepath.Separator)) {
		return "", storeErr(CodePath, rel, "path escapes data directory: "+rel)
	}
	return abs, nil
}

// RegisterValidator checks hand edits the watcher sees on matching files.
func (s *Store) RegisterValidator(match func(rel string) bool, validate func(text, rel string) error) {
	s.mu.Lock()
	s.validators = append(s.validators, validator{match, validate})
	s.mu.Unlock()
}

func (s *Store) getCrypto() *Crypto {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.crypto
}

// SetCrypto turns encryption on (or off with nil) for later reads and writes.
func (s *Store) SetCrypto(c *Crypto) {
	s.mu.Lock()
	s.crypto = c
	s.mu.Unlock()
}

func shaHex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// ---------- raw IO (callers hold the file locks) ----------

func (s *Store) rawRead(rel string) (string, bool, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return "", false, err
	}
	b, err := os.ReadFile(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, storeErr(CodeIO, rel, fmt.Sprintf("cannot read %s: %v", rel, err))
	}
	text, err := s.plain(rel, string(b))
	return text, err == nil, err
}

// plain decrypts a file's text if it is an encrypted envelope.
func (s *Store) plain(rel, text string) (string, error) {
	if !IsEnvelope(text) {
		return text, nil
	}
	c := s.getCrypto()
	if c == nil {
		return "", storeErr(CodeEncrypted, rel, rel+" is encrypted and the app is locked")
	}
	return DecryptText(c.Key, rel, text)
}

func (s *Store) rawWrite(rel string, data []byte, isText bool) error {
	abs, err := s.Resolve(rel)
	if err != nil {
		return err
	}
	if c := s.getCrypto(); isText && c != nil && c.ShouldEncrypt(rel) {
		env, err := EncryptText(c.Key, rel, string(data))
		if err != nil {
			return err
		}
		data = []byte(env)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	rnd := make([]byte, 4)
	rand.Read(rnd)
	tmp := fmt.Sprintf("%s.%d.%s.tmp", abs, os.Getpid(), hex.EncodeToString(rnd))
	if err := writeSynced(tmp, data); err != nil {
		os.Remove(tmp)
		return err
	}
	for i := 0; ; i++ {
		err = os.Rename(tmp, abs)
		// Windows: a reader (antivirus, the indexer) can hold the file for a moment.
		if err == nil || runtime.GOOS != "windows" || i >= 5 {
			break
		}
		time.Sleep(time.Duration(20*(i+1)) * time.Millisecond)
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	s.mu.Lock()
	s.selfWrites[abs] = shaHex(data)
	s.mu.Unlock()
	return nil
}

func writeSynced(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func (s *Store) rawRemove(rel string) error {
	abs, err := s.Resolve(rel)
	if err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.selfWrites, abs)
	s.mu.Unlock()
	// Like fs.rm(…, { force: true }): a missing file is fine; a folder is refused.
	if err := os.Remove(abs); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// withLocks runs fn holding the locks of every path, taken in a fixed order.
func (s *Store) withLocks(rels []string, fn func() error) error {
	seen := map[string]bool{}
	var keys []string
	for _, r := range rels {
		abs, err := s.Resolve(r)
		if err != nil {
			return err
		}
		if !seen[abs] {
			seen[abs] = true
			keys = append(keys, abs)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		defer s.mutex.Lock(k)()
	}
	return fn()
}

// ---------- text and bytes ----------

// ReadText returns a file's text (decrypted if needed); ok is false if it doesn't exist.
func (s *Store) ReadText(rel string) (text string, ok bool, err error) {
	err = s.withLocks([]string{rel}, func() error {
		text, ok, err = s.rawRead(rel)
		return err
	})
	return
}

// WriteText writes a file atomically (encrypted if the policy says so).
func (s *Store) WriteText(rel, text string) error {
	return s.withLocks([]string{rel}, func() error { return s.rawWrite(rel, []byte(text), true) })
}

// WriteBinary writes raw bytes atomically (attachments). Never encrypted.
func (s *Store) WriteBinary(rel string, data []byte) error {
	return s.withLocks([]string{rel}, func() error { return s.rawWrite(rel, data, false) })
}

// ReadBinary returns a file's bytes, or nil if it doesn't exist.
func (s *Store) ReadBinary(rel string) ([]byte, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, storeErr(CodeIO, rel, fmt.Sprintf("cannot read %s: %v", rel, err))
	}
	return b, nil
}

func (s *Store) Remove(rel string) error {
	return s.withLocks([]string{rel}, func() error { return s.rawRemove(rel) })
}

func (s *Store) Exists(rel string) (bool, error) {
	_, ok, err := s.rawRead(rel)
	return ok, err
}

// List returns the files under relDir (relative paths with "/"), sorted, skipping temp files.
func (s *Store) List(relDir, ext string, recursive bool) ([]string, error) {
	out := []string{}
	var walk func(rel string) error
	walk = func(rel string) error {
		abs, err := s.Resolve(rel)
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(abs)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		for _, e := range entries {
			r := e.Name()
			if rel != "" {
				r = rel + "/" + r
			}
			if strings.HasSuffix(e.Name(), ".tmp") {
				continue
			}
			if e.IsDir() {
				if recursive {
					if err := walk(r); err != nil {
						return err
					}
				}
			} else if ext == "" || strings.HasSuffix(e.Name(), ext) {
				out = append(out, r)
			}
		}
		return nil
	}
	if err := walk(strings.TrimRight(relDir, "/")); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return utf16Less(out[i], out[j]) })
	return out, nil
}

// ---------- JSON ----------

func (s *Store) parseAndValidate(text, rel string, validate Validate) (any, error) {
	v, err := ParseJSON(text)
	if err != nil {
		return nil, &StoreError{
			Message: fmt.Sprintf("invalid JSON in %s: %v", rel, err),
			Code:    CodeCorrupt, File: rel, Line: jsonErrorLine(text, err),
		}
	}
	if validate == nil {
		return v, nil
	}
	out, err := validate(v)
	if err != nil {
		return nil, storeErr(CodeCorrupt, rel, fmt.Sprintf("%s failed validation: %v", rel, err))
	}
	return out, nil
}

// quarantine moves a bad file aside and returns the newest backed-up copy of it, if any.
func (s *Store) quarantine(rel string) (string, bool) {
	abs, _ := s.Resolve(rel)
	dest := "quarantine/" + isoStamp(time.Now()) + "-" + strings.NewReplacer("/", "__", `\`, "__").Replace(rel)
	destAbs, _ := s.Resolve(dest)
	os.MkdirAll(filepath.Dir(destAbs), 0o755)
	os.Rename(abs, destAbs)
	s.emit(Event{Kind: EventQuarantined, Rel: rel, To: dest})
	return readFromLatestBackup(s.Root, strings.ReplaceAll(rel, `\`, "/"))
}

// ReadJSON reads and validates a JSON file. A corrupt file is moved to quarantine/ and the newest
// good backup of it is restored; failing that, the fallback is used, or the error returned.
func (s *Store) ReadJSON(rel string, o ReadOptions) (out any, err error) {
	err = s.withLocks([]string{rel}, func() error {
		text, ok, err := s.rawRead(rel)
		if err != nil {
			return err
		}
		if !ok {
			if o.Fallback != nil {
				out = o.Fallback()
				return nil
			}
			return storeErr(CodeIO, rel, rel+" does not exist")
		}
		v, perr := s.parseAndValidate(text, rel, o.Validate)
		if perr == nil {
			out = v
			return nil
		}
		good, found := s.quarantine(rel)
		if found && IsEnvelope(good) {
			if g, err := s.plain(rel, good); err == nil {
				good = g
			} else {
				found = false
			}
		}
		if found {
			if v, err := s.parseAndValidate(good, rel, o.Validate); err == nil {
				if err := s.rawWrite(rel, []byte(good), true); err != nil {
					return err
				}
				s.emit(Event{Kind: EventRestored, Rel: rel, From: "backup"})
				out = v
				return nil
			}
		}
		if o.Fallback != nil {
			out = o.Fallback()
			return nil
		}
		return perr
	})
	return
}

// WriteJSON validates (if asked) and writes v as stable JSON.
func (s *Store) WriteJSON(rel string, v any, validate Validate) error {
	if validate != nil {
		norm, err := normalize(v)
		if err != nil {
			return err
		}
		if v, err = validate(norm); err != nil {
			return err
		}
	}
	text, err := StableStringify(v)
	if err != nil {
		return err
	}
	return s.WriteText(rel, text)
}

// Update reads, changes and writes a JSON file under its lock, so concurrent updates never lose
// each other's changes. A missing file starts from o.Fallback().
func (s *Store) Update(rel string, fn func(cur any) (any, error), o ReadOptions) (out any, err error) {
	err = s.withLocks([]string{rel}, func() error {
		text, ok, err := s.rawRead(rel)
		if err != nil {
			return err
		}
		var cur any
		if !ok {
			cur = o.Fallback()
		} else if cur, err = s.parseAndValidate(text, rel, o.Validate); err != nil {
			return err
		}
		next, err := fn(cur)
		if err != nil {
			return err
		}
		if next, err = normalize(next); err != nil {
			return err
		}
		if o.Validate != nil {
			if next, err = o.Validate(next); err != nil {
				return err
			}
		}
		t, err := StableStringify(next)
		if err != nil {
			return err
		}
		out = next
		return s.rawWrite(rel, []byte(t), true)
	})
	return
}

// ReadVersioned reads a `{ "schemaVersion": n, ... }` document, migrating it on disk (after a
// pre-migration backup) when it is older than o.Version.
func (s *Store) ReadVersioned(rel string, o VersionedOptions) (any, error) {
	text, ok, err := s.ReadText(rel)
	if err != nil {
		return nil, err
	}
	if !ok {
		return o.Fallback(), nil
	}
	parsed, perr := ParseJSON(text)
	if perr != nil {
		v, err := s.ReadJSON(rel, ReadOptions{Validate: o.Validate, Fallback: o.Fallback})
		if err != nil {
			return nil, perr
		}
		return v, nil
	}
	if doc, isDoc := parsed.(map[string]any); isDoc {
		ver, _ := doc["schemaVersion"].(float64)
		if ver < float64(o.Version) {
			if _, err := s.Backup("pre-migration", 20); err != nil {
				return nil, err
			}
			doc, err = Migrate(doc, o.Version, o.Migrations)
			if err != nil {
				return nil, err
			}
			if err := s.WriteJSON(rel, doc, nil); err != nil {
				return nil, err
			}
		}
	}
	return s.ReadJSON(rel, ReadOptions{Validate: o.Validate, Fallback: o.Fallback})
}

// ---------- several files at once ----------

// Batch applies writes, removes and moves together; if one fails, every file is put back.
func (s *Store) Batch(ops []Op) error {
	var rels []string
	for _, o := range ops {
		if o.Type == "move" {
			rels = append(rels, o.From, o.To)
		} else {
			rels = append(rels, o.Rel)
		}
	}
	return s.withLocks(rels, func() error {
		type prior struct {
			text string
			ok   bool
		}
		before := map[string]prior{}
		for _, r := range rels {
			t, ok, err := s.rawRead(r)
			if err != nil {
				return err
			}
			before[r] = prior{t, ok}
		}
		apply := func() error {
			for _, o := range ops {
				switch o.Type {
				case "write":
					if err := s.rawWrite(o.Rel, []byte(o.Text), true); err != nil {
						return err
					}
				case "remove":
					if err := s.rawRemove(o.Rel); err != nil {
						return err
					}
				case "move":
					t, ok, err := s.rawRead(o.From)
					if err != nil {
						return err
					}
					if !ok {
						return storeErr(CodeIO, o.From, "cannot move missing file "+o.From)
					}
					if err := s.rawWrite(o.To, []byte(t), true); err != nil {
						return err
					}
					if err := s.rawRemove(o.From); err != nil {
						return err
					}
				default:
					return storeErr(CodeInvalid, "", "unknown batch op "+o.Type)
				}
			}
			return nil
		}
		err := apply()
		if err != nil {
			for r, p := range before {
				if p.ok {
					s.rawWrite(r, []byte(p.text), true)
				} else {
					s.rawRemove(r)
				}
			}
		}
		return err
	})
}

// ---------- backups ----------

// Backup zips the data folder (keeping the newest `keep` backups).
func (s *Store) Backup(reason string, keep int) (string, error) {
	return CreateBackup(s.Root, reason, keep)
}

// BackupIfStale makes a launch backup when the newest backup is older than maxAge (6 h if 0).
// It returns "" if no backup was needed.
func (s *Store) BackupIfStale(maxAge time.Duration) (string, error) {
	if maxAge == 0 {
		maxAge = 6 * time.Hour
	}
	all, _ := ListBackups(s.Root)
	if len(all) > 0 {
		st, err := os.Stat(filepath.Join(s.Root, "backups", all[len(all)-1]))
		if err == nil && time.Since(st.ModTime()) < maxAge {
			return "", nil
		}
	}
	return s.Backup("launch", 20)
}

// PurgeBackups deletes every backup (after encrypting, old backups still hold plain text).
func (s *Store) PurgeBackups() (int, error) {
	files, err := s.List("backups", ".zip", false)
	if err != nil {
		return 0, err
	}
	for _, f := range files {
		abs, _ := s.Resolve(f)
		os.Remove(abs)
	}
	return len(files), nil
}

var dataFile = regexp.MustCompile(`\.(json|jsonl|md)$`)

// ReencryptAll rewrites every data file under a new policy (encrypt chosen paths, decrypt the
// rest, or change the key), after a backup unless skipBackup. Each file says whether it is
// encrypted, so a crash part-way leaves a readable mix.
func (s *Store) ReencryptAll(next *Crypto, skipBackup bool) (int, error) {
	if !skipBackup {
		if _, err := s.Backup("pre-encryption", 20); err != nil {
			return 0, err
		}
	}
	all, err := s.List("data", "", true)
	if err != nil {
		return 0, err
	}
	type file struct{ rel, text string }
	var plain []file
	for _, r := range all {
		if !dataFile.MatchString(r) {
			continue
		}
		t, ok, err := s.ReadText(r)
		if err != nil {
			return 0, err
		}
		if ok {
			plain = append(plain, file{r, t})
		}
	}
	s.SetCrypto(next)
	for _, f := range plain {
		if err := s.WriteText(f.rel, f.text); err != nil {
			return 0, err
		}
	}
	return len(plain), nil
}

// Close stops watching and releases the folder's lock.
func (s *Store) Close() error {
	s.mu.Lock()
	w := s.watcher
	s.watcher = nil
	locked := s.locked
	s.locked = false
	s.mu.Unlock()
	if w != nil {
		w.close()
	}
	if locked {
		os.Remove(filepath.Join(s.Root, ".lock"))
	}
	return nil
}
