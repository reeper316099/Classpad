package jsonstore

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// settle is how long a file must stay quiet before it is read (a half-written file is never
// validated). The TypeScript store waits 60 ms for the size to stop changing.
const settle = 80 * time.Millisecond

var ignoredPath = regexp.MustCompile(`(^|[\\/])(backups|quarantine|logs|attachments|exports|imports|electron|shell)([\\/]|$)|(^|[\\/])Singleton(Lock|Socket|Cookie)$|\.tmp$|\.lock$`)

type watcher struct {
	fs     *fsnotify.Watcher
	mu     sync.Mutex
	timers map[string]*time.Timer
	dirs   map[string]bool
	done   chan struct{}
	wg     sync.WaitGroup
}

// Watch starts reporting changes made outside the app: EventExternalChange for good edits and
// deletions, EventInvalidEdit (with a copy in quarantine/) for edits a validator rejects. The
// app's own writes are recognised and not reported.
func (s *Store) Watch() error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w := &watcher{fs: fw, timers: map[string]*time.Timer{}, dirs: map[string]bool{}, done: make(chan struct{})}
	s.mu.Lock()
	if s.watcher != nil {
		s.mu.Unlock()
		fw.Close()
		return nil
	}
	s.watcher = w
	s.mu.Unlock()
	w.addTree(s, s.Root)
	w.wg.Add(1)
	go w.loop(s)
	return nil
}

func (s *Store) relOf(abs string) string {
	r, err := filepath.Rel(s.Root, abs)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(r)
}

func (s *Store) ignored(abs string) bool {
	r, err := filepath.Rel(s.Root, abs)
	return err != nil || (r != "." && ignoredPath.MatchString(r))
}

// addTree watches a folder and every folder under it (fsnotify is not recursive).
func (w *watcher) addTree(s *Store, dir string) {
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != dir && s.ignored(p) {
			return filepath.SkipDir
		}
		if err := w.fs.Add(p); err != nil {
			s.emit(Event{Kind: EventWatchError, Rel: s.relOf(p), Err: err})
			return nil
		}
		w.mu.Lock()
		w.dirs[p] = true
		w.mu.Unlock()
		return nil
	})
}

func (w *watcher) loop(s *Store) {
	defer w.wg.Done()
	for {
		select {
		case <-w.done:
			return
		case err, ok := <-w.fs.Errors:
			if !ok {
				return
			}
			s.emit(Event{Kind: EventWatchError, Err: err})
		case ev, ok := <-w.fs.Events:
			if !ok {
				return
			}
			if s.ignored(ev.Name) {
				continue
			}
			if ev.Has(fsnotify.Create) {
				if st, err := os.Stat(ev.Name); err == nil && st.IsDir() {
					w.addTree(s, ev.Name)
					continue
				}
			}
			w.later(s, ev.Name)
		}
	}
}

// later handles a path once it has been quiet for `settle`.
func (w *watcher) later(s *Store, abs string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if t := w.timers[abs]; t != nil {
		t.Reset(settle)
		return
	}
	w.timers[abs] = time.AfterFunc(settle, func() {
		w.mu.Lock()
		delete(w.timers, abs)
		wasDir := w.dirs[abs]
		w.mu.Unlock()
		select {
		case <-w.done:
			return
		default:
		}
		st, err := os.Lstat(abs)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if wasDir {
				w.mu.Lock()
				delete(w.dirs, abs)
				w.mu.Unlock()
				return
			}
			s.emit(Event{Kind: EventExternalChange, Rel: s.relOf(abs)})
		case err == nil && st.Mode().IsRegular():
			s.onFile(abs)
		}
	})
}

func (s *Store) onFile(abs string) {
	rel := s.relOf(abs)
	b, err := os.ReadFile(abs)
	if err != nil {
		s.emit(Event{Kind: EventExternalChange, Rel: rel})
		return
	}
	s.mu.RLock()
	own := s.selfWrites[abs] == shaHex(b)
	validators := append([]validator{}, s.validators...)
	s.mu.RUnlock()
	if own {
		return
	}
	text := string(b)
	if IsEnvelope(text) {
		c := s.getCrypto()
		if c == nil {
			return // locked: it can't be read, so there is nothing to refresh
		}
		t, err := DecryptText(c.Key, rel, text)
		if err != nil {
			s.emit(Event{Kind: EventInvalidEdit, Rel: rel, Message: "encrypted file could not be decrypted"})
			return
		}
		text = t
	}
	for _, v := range validators {
		if !v.match(rel) {
			continue
		}
		if err := v.validate(text, rel); err != nil {
			// Keep the broken edit for the user, but never let it replace what the app has.
			copyRel := "quarantine/" + isoStamp(time.Now()) + "-" + strings.ReplaceAll(rel, "/", "__")
			if dst, rerr := s.Resolve(copyRel); rerr == nil {
				os.MkdirAll(filepath.Dir(dst), 0o755)
				os.WriteFile(dst, []byte(text), 0o644)
			}
			line := jsonErrorLine(text, err)
			var se *StoreError
			if errors.As(err, &se) && se.Line > 0 {
				line = se.Line
			}
			s.emit(Event{Kind: EventInvalidEdit, Rel: rel, Message: err.Error(), Line: line})
			return
		}
	}
	s.emit(Event{Kind: EventExternalChange, Rel: rel})
}

func (w *watcher) close() {
	close(w.done)
	w.fs.Close()
	w.wg.Wait()
	w.mu.Lock()
	for _, t := range w.timers {
		t.Stop()
	}
	w.mu.Unlock()
}
