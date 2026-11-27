// Package jsonstore keeps Classpad's data folder: atomic file writes, pretty JSON with sorted keys,
// per-file locking, corruption recovery from backups, schema migrations, encryption at rest,
// zipped backups and a watcher for hand edits. It is a port of packages/jsonstore and reads and
// writes the same files, byte for byte, so existing data folders keep working.
package jsonstore

import (
	"errors"
	"sync"
)

// Error codes, as in the TypeScript store.
const (
	CodeInvalid   = "INVALID"
	CodeCorrupt   = "CORRUPT"
	CodeLocked    = "LOCKED"
	CodeIO        = "IO"
	CodePath      = "PATH"
	CodeEncrypted = "ENCRYPTED"
	CodeDecrypt   = "DECRYPT"
)

// StoreError is every error the store returns on purpose.
type StoreError struct {
	Message string
	Code    string
	File    string
	Line    int // 1-based line of a JSON error, 0 if unknown
}

func (e *StoreError) Error() string { return e.Message }

func storeErr(code, file, msg string) *StoreError {
	return &StoreError{Message: msg, Code: code, File: file}
}

// ErrorCode returns the store code of err, or "" if it is not a StoreError.
func ErrorCode(err error) string {
	var se *StoreError
	if errors.As(err, &se) {
		return se.Code
	}
	return ""
}

// KeyedMutex serializes work per key (a file path). Unused keys are forgotten.
type KeyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyLock
}

type keyLock struct {
	sync.Mutex
	users int
}

// Lock locks key and returns its unlock function.
func (m *KeyedMutex) Lock(key string) func() {
	m.mu.Lock()
	if m.locks == nil {
		m.locks = map[string]*keyLock{}
	}
	l := m.locks[key]
	if l == nil {
		l = &keyLock{}
		m.locks[key] = l
	}
	l.users++
	m.mu.Unlock()
	l.Lock()
	return func() {
		l.Unlock()
		m.mu.Lock()
		if l.users--; l.users == 0 {
			delete(m.locks, key)
		}
		m.mu.Unlock()
	}
}

// Run runs fn while holding key's lock.
func (m *KeyedMutex) Run(key string, fn func() error) error {
	unlock := m.Lock(key)
	defer unlock()
	return fn()
}
