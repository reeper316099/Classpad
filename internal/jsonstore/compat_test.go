package jsonstore

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// What the TypeScript store writes (scripts/jsonstore-compat.mjs). The Go store must write the same
// bytes and read the same files, so a data folder works with either.

type compatFile struct {
	Stable []struct {
		Input  string `json:"input"`
		Output string `json:"output"`
	} `json:"stable"`
	Keys []struct {
		Pass string `json:"pass"`
		Salt string `json:"salt"`
		Key  string `json:"key"`
	} `json:"keys"`
	Envelopes []struct {
		Key      string `json:"key"`
		Rel      string `json:"rel"`
		Text     string `json:"text"`
		Envelope string `json:"envelope"`
	} `json:"envelopes"`
	Backup struct {
		Zip   string            `json:"zip"`
		Files map[string]string `json:"files"`
	} `json:"backup"`
}

func loadCompat(t *testing.T) compatFile {
	t.Helper()
	path := "testdata/compat.json"
	if p := os.Getenv("JSONSTORE_COMPAT_FILE"); p != "" {
		path = p
	}
	b, err := os.ReadFile(path)
	must(t, err)
	var c compatFile
	must(t, json.Unmarshal(b, &c))
	return c
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	must(t, err)
	return b
}

func TestCompatStableJSON(t *testing.T) {
	c := loadCompat(t)
	for i, cs := range c.Stable {
		v, err := ParseJSON(cs.Input)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		got, err := StableStringify(v)
		must(t, err)
		if got != cs.Output {
			t.Errorf("case %d\n input: %s\n go: %q\n ts: %q", i, cs.Input, got, cs.Output)
		}
	}
	t.Logf("%d JSON cases written byte for byte like the TypeScript store", len(c.Stable))
}

func TestCompatCrypto(t *testing.T) {
	c := loadCompat(t)
	for _, k := range c.Keys {
		got, err := DeriveKey(k.Pass, unhex(t, k.Salt))
		must(t, err)
		if hex.EncodeToString(got) != k.Key {
			t.Errorf("key for %q differs", k.Pass)
		}
	}
	iv := regexp.MustCompile(`"iv":"([^"]*)"`)
	for _, e := range c.Envelopes {
		key := unhex(t, e.Key)
		got, err := DecryptText(key, e.Rel, e.Envelope)
		if err != nil || got != e.Text {
			t.Errorf("%s: %q, %v", e.Rel, got, err)
		}
		// With the same IV, Go writes the identical envelope.
		ivBytes, err := base64.StdEncoding.DecodeString(iv.FindStringSubmatch(e.Envelope)[1])
		must(t, err)
		again, err := encryptWithIV(key, ivBytes, e.Rel, e.Text)
		must(t, err)
		if again != e.Envelope {
			t.Errorf("%s envelope differs\n go: %s\n ts: %s", e.Rel, again, e.Envelope)
		}
	}
}

func TestCompatBackup(t *testing.T) {
	c := loadCompat(t)
	dir := t.TempDir()
	zip, err := base64.StdEncoding.DecodeString(c.Backup.Zip)
	must(t, err)
	put(t, dir, "backups/backup-ts.zip", string(zip))
	for rel, want := range c.Backup.Files {
		got, ok := readFromLatestBackup(dir, rel)
		if !ok || got != want {
			t.Errorf("%s: %q (found %v)", rel, got, ok)
		}
	}
	if _, ok := readFromLatestBackup(dir, "attachments/skip.bin"); ok {
		t.Error("attachments were backed up")
	}
	// And a corrupt file is restored from the TypeScript-made backup.
	s, err := Open(dir, false)
	must(t, err)
	put(t, dir, "config.json", "{ broken")
	v, err := s.ReadJSON("config.json", ReadOptions{})
	must(t, err)
	if v.(map[string]any)["theme"] != "dark" {
		t.Fatal(v)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "config.json")); string(b) != c.Backup.Files["config.json"] {
		t.Fatal(string(b))
	}
}

// TestCompatExport writes a data folder with the Go store, for the TypeScript store to open
// (node scripts/jsonstore-compat.mjs --verify DIR). It runs only when JSONSTORE_GO_OUT is set.
func TestCompatExport(t *testing.T) {
	dir := os.Getenv("JSONSTORE_GO_OUT")
	if dir == "" {
		t.Skip("set JSONSTORE_GO_OUT to write a folder for the TypeScript store to check")
	}
	c := loadCompat(t)
	key := unhex(t, c.Keys[0].Key)
	s, err := Open(dir, false)
	must(t, err)
	defer s.Close()
	s.SetCrypto(policy(key, "data/journal/"))
	files := map[string]string{}
	for i, cs := range c.Stable[:50] {
		v, err := ParseJSON(cs.Input)
		must(t, err)
		rel := "data/stable/" + strconv.Itoa(i) + ".json"
		must(t, s.WriteJSON(rel, v, nil))
		files[rel] = cs.Output
	}
	for rel, text := range c.Backup.Files {
		must(t, s.WriteText(rel, text))
		files[rel] = text
	}
	must(t, s.WriteText("data/journal/secret.md", "# A synthetic diary page\n"))
	files["data/journal/secret.md"] = "# A synthetic diary page\n"
	_, err = s.Backup("go", 20)
	must(t, err)
	b, _ := json.Marshal(map[string]any{"key": c.Keys[0].Key, "files": files})
	must(t, os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o644))
}
