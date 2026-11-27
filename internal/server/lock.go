package server

import (
	"encoding/base64"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
)

const privacyFile = "config/privacy.json"

// Encryptable is which on-disk paths each encryptable collection covers (attachment files are never
// encrypted), in the order the API lists them.
var encryptableNames = []string{"notes", "journal", "contacts", "flashcards", "budget", "jobs", "admissions", "activities", "grades", "study"}

var Encryptable = map[string][]string{
	"notes":      {"data/notes/"},
	"journal":    {"data/journal/"},
	"contacts":   {"data/contacts/"},
	"flashcards": {"data/flashcards/"},
	"budget":     {"data/modules/budget/"},
	"jobs":       {"data/modules/jobs/"},
	"admissions": {"data/modules/admissions/"},
	"activities": {"data/modules/activities/"},
	"grades":     {"data/assignments/"},
	"study":      {"data/study/"},
}

// ReadPrivacy reads config/privacy.json before the data directory is opened, to decide whether the
// data must stay unloaded until unlock. Nil when missing or unreadable.
func ReadPrivacy(dataDir string) *jsv.Obj {
	b, err := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(privacyFile)))
	if err != nil {
		return nil
	}
	v, err := jsv.Parse(string(b))
	if err != nil {
		return nil
	}
	o, _ := v.(*jsv.Obj)
	return o
}

const minPassphrase = 4

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// unb64 is Buffer.from(s, 'base64'): it accepts base64url too, skips characters that are not base64,
// stops at padding and ignores a lone trailing character.
func unb64(s string) []byte {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b
	}
	var clean strings.Builder
	for _, r := range s {
		switch {
		case r == '=':
			goto done
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/':
			clean.WriteRune(r)
		case r == '-':
			clean.WriteByte('+')
		case r == '_':
			clean.WriteByte('/')
		}
	}
done:
	c := clean.String()
	if len(c)%4 == 1 {
		c = c[:len(c)-1]
	}
	b, _ := base64.RawStdEncoding.DecodeString(c)
	return b
}

// LockService is the passphrase lock and encryption at rest.
type LockService struct {
	ctx *Context

	mu      sync.Mutex
	cfg     *jsv.Obj
	locked  bool
	failed  int
	retryAt float64 // ms since the epoch
	key     []byte
}

func NewLockService(ctx *Context, cfg *jsv.Obj) *LockService {
	return &LockService{ctx: ctx, cfg: cfg, locked: cfg != nil && cfg.ObjAt("auth") != nil}
}

func nowMs() float64 { return float64(Now().UnixMilli()) }

func (l *LockService) hasAuth() bool { return l.cfg != nil && l.cfg.ObjAt("auth") != nil }

func (l *LockService) collections() []string {
	if l.cfg == nil {
		return []string{}
	}
	if enc := l.cfg.ObjAt("enc"); enc != nil {
		if c := enc.Strings("collections"); c != nil {
			return c
		}
	}
	return []string{}
}

func policy(key []byte, collections []string) *jsonstore.Crypto {
	var prefixes []string
	for _, c := range collections {
		prefixes = append(prefixes, Encryptable[c]...)
	}
	return &jsonstore.Crypto{Key: key, ShouldEncrypt: func(rel string) bool {
		for _, p := range prefixes {
			if strings.HasPrefix(rel, p) {
				return true
			}
		}
		return false
	}}
}

func (l *LockService) save(cfg *jsv.Obj) error {
	l.cfg = cfg
	if cfg != nil {
		return l.ctx.Store.WriteJSON(privacyFile, cfg, nil)
	}
	return l.ctx.Store.Remove(privacyFile)
}

// Locked reports whether requests other than the lock routes are refused.
func (l *LockService) Locked() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.locked
}

func (l *LockService) Status() *jsv.Obj {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.status()
}

func (l *LockService) status() *jsv.Obj {
	cols := make([]any, 0)
	for _, c := range l.collections() {
		cols = append(cols, c)
	}
	avail := make([]any, len(encryptableNames))
	for i, n := range encryptableNames {
		avail[i] = n
	}
	auto, onHide := 0.0, false
	if l.cfg != nil {
		auto = l.cfg.Num("autoLockMinutes")
		onHide = l.cfg.Bool("lockOnHide")
	}
	return jsv.O("enabled", l.hasAuth(), "locked", l.locked, "encryptedCollections", cols, "available", avail,
		"autoLockMinutes", auto, "lockOnHide", onHide, "retryAfterMs", math.Max(0, l.retryAt-nowMs()))
}

func (l *LockService) verify(passphrase string) error {
	if !l.hasAuth() {
		return apiErr(409, "NO_LOCK", "No passphrase is set")
	}
	if wait := l.retryAt - nowMs(); wait > 0 {
		e := apiErr(429, "TOO_MANY_ATTEMPTS", fmt.Sprintf("Too many attempts. Try again in %d seconds.", int(math.Ceil(wait/1000))))
		e.Details = jsv.O("retryAfterMs", wait)
		return e
	}
	a := l.cfg.ObjAt("auth")
	ok, err := jsonstore.VerifyHash(passphrase, unb64(a.Str("salt")), unb64(a.Str("hash")))
	if err != nil {
		return err
	}
	if !ok {
		l.failed++
		if l.failed >= 5 {
			l.retryAt = nowMs() + math.Min(300_000, 5_000*math.Pow(2, float64(l.failed-5)))
		}
		return apiErr(403, "BAD_PASSPHRASE", "That passphrase is not correct")
	}
	l.failed, l.retryAt = 0, 0
	return nil
}

func (l *LockService) Unlock(passphrase string) (*jsv.Obj, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.verify(passphrase); err != nil {
		return nil, err
	}
	if enc := l.cfg.ObjAt("enc"); enc != nil && len(l.collections()) > 0 {
		key, err := jsonstore.DeriveKey(passphrase, unb64(enc.Str("salt")))
		if err != nil {
			return nil, err
		}
		l.key = key
		l.ctx.Store.SetCrypto(policy(key, l.collections()))
	}
	if !l.ctx.Loaded() {
		if err := l.ctx.LoadAll(); err != nil {
			l.ctx.Store.SetCrypto(nil)
			l.key = nil
			return nil, apiErr(500, "UNLOCK_FAILED", "Could not read your encrypted data: "+err.Error())
		}
	}
	l.locked = false
	return l.status(), nil
}

func (l *LockService) Lock() (*jsv.Obj, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.hasAuth() {
		return nil, apiErr(409, "NO_LOCK", "Set a passphrase first")
	}
	l.locked = true
	l.key = nil
	l.ctx.Store.SetCrypto(nil) // the key leaves memory; encrypted files can't be read until the next unlock
	return l.status(), nil
}

// dropPlaintextBackups: older backups (including the safety copy taken just before migrating) hold
// the data unencrypted.
func (l *LockService) dropPlaintextBackups() error {
	if _, err := l.ctx.Store.PurgeBackups(); err != nil {
		return err
	}
	_, err := l.ctx.Store.Backup("post-encryption", 20)
	return err
}

func chooseCollections(list []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, c := range list {
		if !seen[c] {
			seen[c] = true
			if _, ok := Encryptable[c]; ok {
				out = append(out, c)
			}
		}
	}
	return out
}

func strList(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

type LockSetup struct {
	Passphrase      string
	Current         *string
	Collections     []string // nil: keep
	AutoLockMinutes *float64
	LockOnHide      *bool
}

// Setup is first-time setup, or changing the passphrase (then Current is required).
func (l *LockService) Setup(o LockSetup) (*jsv.Obj, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if utf16Len(o.Passphrase) < minPassphrase {
		return nil, apiErr(422, "WEAK_PASSPHRASE", fmt.Sprintf("Use at least %d characters", minPassphrase))
	}
	if l.hasAuth() {
		cur := ""
		if o.Current != nil {
			cur = *o.Current
		}
		if err := l.verify(cur); err != nil {
			return nil, err
		}
		if l.locked {
			return nil, apiErr(423, "LOCKED", "Unlock first")
		}
	}
	want := o.Collections
	if want == nil {
		want = l.collections()
	}
	cols := chooseCollections(want)
	authSalt, encSalt := jsonstore.NewSalt(), jsonstore.NewSalt()
	hash, err := jsonstore.DeriveKey(o.Passphrase, authSalt)
	if err != nil {
		return nil, err
	}
	next := jsv.O("version", 1.0, "auth", jsv.O("salt", b64(authSalt), "hash", b64(hash)))
	if len(cols) > 0 {
		next.Set("enc", jsv.O("salt", b64(encSalt), "collections", strList(cols)))
	}
	auto := 0.0
	if o.AutoLockMinutes != nil {
		auto = *o.AutoLockMinutes
	} else if l.cfg != nil && l.cfg.Has("autoLockMinutes") {
		auto = l.cfg.Num("autoLockMinutes")
	}
	onHide := false
	if o.LockOnHide != nil {
		onHide = *o.LockOnHide
	} else if l.cfg != nil {
		onHide = l.cfg.Bool("lockOnHide")
	}
	next.Set("autoLockMinutes", auto).Set("lockOnHide", onHide)
	// rewrite the data under the new key (or plain) before recording the new config
	if len(cols) > 0 {
		key, err := jsonstore.DeriveKey(o.Passphrase, encSalt)
		if err != nil {
			return nil, err
		}
		if _, err := l.ctx.Store.ReencryptAll(policy(key, cols), false); err != nil {
			return nil, err
		}
		if err := l.dropPlaintextBackups(); err != nil {
			return nil, err
		}
		l.key = key
	} else if len(l.collections()) > 0 {
		if _, err := l.ctx.Store.ReencryptAll(nil, false); err != nil {
			return nil, err
		}
		l.key = nil
	}
	if err := l.save(next); err != nil {
		return nil, err
	}
	l.locked = false
	l.failed = 0
	return l.status(), nil
}

// SetCollections chooses which collections are encrypted at rest; turning it on from none needs the
// passphrase to derive a key.
func (l *LockService) SetCollections(collections []string, passphrase *string) (*jsv.Obj, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.hasAuth() {
		return nil, apiErr(409, "NO_LOCK", "Set a passphrase first")
	}
	chosen := chooseCollections(collections)
	salt := ""
	if enc := l.cfg.ObjAt("enc"); enc != nil {
		salt = enc.Str("salt")
	}
	key := l.key
	if len(chosen) > 0 && key == nil {
		p := ""
		if passphrase != nil {
			p = *passphrase
		}
		if err := l.verify(p); err != nil {
			return nil, err
		}
		s := jsonstore.NewSalt()
		salt = b64(s)
		k, err := jsonstore.DeriveKey(p, s)
		if err != nil {
			return nil, err
		}
		key = k
	}
	if len(chosen) > 0 {
		if _, err := l.ctx.Store.ReencryptAll(policy(key, chosen), false); err != nil {
			return nil, err
		}
		if err := l.dropPlaintextBackups(); err != nil {
			return nil, err
		}
		l.key = key
		if err := l.save(l.cfg.Clone().Set("enc", jsv.O("salt", salt, "collections", strList(chosen)))); err != nil {
			return nil, err
		}
	} else {
		if _, err := l.ctx.Store.ReencryptAll(nil, false); err != nil {
			return nil, err
		}
		l.key = nil
		rest := l.cfg.Clone()
		rest.Delete("enc")
		if err := l.save(rest); err != nil {
			return nil, err
		}
	}
	return l.status(), nil
}

func (l *LockService) UpdateSettings(autoLock *float64, onHide *bool) (*jsv.Obj, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.hasAuth() {
		return nil, apiErr(409, "NO_LOCK", "Set a passphrase first")
	}
	next := l.cfg.Clone()
	if autoLock != nil {
		next.Set("autoLockMinutes", *autoLock)
	}
	if onHide != nil {
		next.Set("lockOnHide", *onHide)
	}
	if err := l.save(next); err != nil {
		return nil, err
	}
	return l.status(), nil
}

// Disable removes the lock; encrypted collections are decrypted back to plain files first.
func (l *LockService) Disable(passphrase string) (*jsv.Obj, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.verify(passphrase); err != nil {
		return nil, err
	}
	if len(l.collections()) > 0 {
		if l.key == nil {
			k, err := jsonstore.DeriveKey(passphrase, unb64(l.cfg.ObjAt("enc").Str("salt")))
			if err != nil {
				return nil, err
			}
			l.ctx.Store.SetCrypto(policy(k, l.collections()))
		}
		if _, err := l.ctx.Store.ReencryptAll(nil, false); err != nil {
			return nil, err
		}
	}
	l.key = nil
	if err := l.save(nil); err != nil {
		return nil, err
	}
	l.locked = false
	return l.status(), nil
}
