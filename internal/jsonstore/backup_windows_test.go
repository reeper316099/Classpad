package jsonstore

import (
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// Chromium keeps "lockfile" in its user-data folder open with delete-on-close and no delete sharing,
// so Go's os.Open fails on it. With Electron's user-data folder being the data folder, a backup or
// re-encryption that tried to read it failed (seen in the desktop app's end-to-end tests).
func TestBackupWithChromiumLockfileHeld(t *testing.T) {
	s, dir := open(t)
	must(t, s.WriteText("data/notes/a.md", "# A\n"))
	p, err := windows.UTF16PtrFromString(filepath.Join(dir, "lockfile"))
	must(t, err)
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE, windows.FILE_SHARE_READ, nil,
		windows.CREATE_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_DELETE_ON_CLOSE, 0)
	must(t, err)
	defer windows.CloseHandle(h)
	if _, err := s.Backup("test", 5); err != nil {
		t.Fatal("backup:", err)
	}
	key, err := DeriveKey("passphrase", NewSalt())
	must(t, err)
	if _, err := s.ReencryptAll(&Crypto{Key: key, ShouldEncrypt: func(string) bool { return true }}, false); err != nil {
		t.Fatal("re-encrypt:", err)
	}
}
