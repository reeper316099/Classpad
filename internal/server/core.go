// Package server is Classpad's local API: the Go port of packages/server. Same routes, same JSON,
// same files in the data folder.
package server

import (
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/reeper316099/classpad/internal/jsonstore"
	"github.com/reeper316099/classpad/internal/jsv"
	"github.com/reeper316099/classpad/internal/schema"
)

// AppName is the product name.
const AppName = "Classpad"

// Now is the clock (tests replace it).
var Now = func() time.Time { return time.Now() }

// ISO is Date.prototype.toISOString.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func nowISO() string { return ISO(Now()) }

// ---------------- ids ----------------

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewID returns a ULID: 48 bits of milliseconds and 80 random bits, Crockford base32.
var NewID = func() string {
	var b [26]byte
	ms := uint64(Now().UnixMilli())
	for i := 9; i >= 0; i-- {
		b[i] = crockford[ms&31]
		ms >>= 5
	}
	var r [16]byte
	rand.Read(r[:])
	for i := 10; i < 26; i++ {
		b[i] = crockford[r[i-10]&31]
	}
	return string(b[:])
}

// ---------------- errors ----------------

// APIError is an error with an HTTP status and a stable code.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details any
}

func (e *APIError) Error() string { return e.Message }

func apiErr(status int, code, msg string) *APIError {
	return &APIError{Status: status, Code: code, Message: msg}
}

func notFound(what, id string) *APIError {
	return apiErr(404, "NOT_FOUND", fmt.Sprintf(`%s "%s" not found`, what, id))
}

func asAPI(err error) (*APIError, bool) {
	var a *APIError
	ok := errors.As(err, &a)
	return a, ok
}

func asSchema(err error) (*schema.Error, bool) {
	var s *schema.Error
	ok := errors.As(err, &s)
	return s, ok
}

// ---------------- event bus ----------------

// Event is an activity entry (metadata only, never content).
type Event struct {
	Kind       string `json:"kind"`
	Collection string `json:"collection"`
	EntityID   string `json:"entityId,omitempty"`
	Message    string `json:"message,omitempty"`
	ID         int    `json:"id"`
	At         string `json:"at"`
}

// Bus publishes events to listeners and keeps the last 200.
type Bus struct {
	mu        sync.Mutex
	seq       int
	ring      []Event
	listeners map[int]func(Event)
	nextL     int
}

func NewBus() *Bus { return &Bus{listeners: map[int]func(Event){}} }

func (b *Bus) Publish(kind, collection, entityID, message string) Event {
	b.mu.Lock()
	b.seq++
	ev := Event{ID: b.seq, At: nowISO(), Kind: kind, Collection: collection, EntityID: entityID, Message: message}
	b.ring = append(b.ring, ev)
	if len(b.ring) > 200 {
		b.ring = b.ring[1:]
	}
	ls := make([]func(Event), 0, len(b.listeners))
	for i := 0; i < b.nextL; i++ {
		if l, ok := b.listeners[i]; ok {
			ls = append(ls, l)
		}
	}
	b.mu.Unlock()
	for _, l := range ls {
		l(ev)
	}
	return ev
}

// On adds a listener; the returned function removes it.
func (b *Bus) On(fn func(Event)) func() {
	b.mu.Lock()
	id := b.nextL
	b.nextL++
	b.listeners[id] = fn
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.listeners, id)
		b.mu.Unlock()
	}
}

// Recent is the newest events first.
func (b *Bus) Recent(limit int) []Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []Event{}
	for i := len(b.ring) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, b.ring[i])
	}
	return out
}

// ---------------- slugs ----------------

// Slugify makes a file-name-safe slug (at most 60 characters), "untitled" if nothing is left.
func Slugify(input string) string {
	s := jsLowerASCIIOnly(stripMarks(input))
	var b strings.Builder
	dash := false
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 60 {
		out = out[:60]
	}
	out = strings.TrimRight(out, "-")
	if out == "" {
		return "untitled"
	}
	return out
}

// UniqueSlug adds -2, -3… until the slug is free.
func UniqueSlug(base string, taken map[string]bool) string {
	if !taken[base] {
		return base
	}
	for i := 2; ; i++ {
		if s := fmt.Sprintf("%s-%d", base, i); !taken[s] {
			return s
		}
	}
}

// ---------------- repository plumbing ----------------

// Collection is what the CRUD routes need.
type Collection interface {
	Name() string
	List() []*jsv.Obj
	Get(id string) *jsv.Obj
	Create(input *jsv.Obj) (*jsv.Obj, error)
	Update(id string, patch *jsv.Obj) (*jsv.Obj, error)
	Delete(id string) error
}

func storeErr(err error) bool { return jsonstore.ErrorCode(err) != "" }
