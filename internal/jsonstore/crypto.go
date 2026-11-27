package jsonstore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

// Crypto turns on encryption at rest.
type Crypto struct {
	Key []byte // 32 bytes, from DeriveKey
	// ShouldEncrypt says which relative paths are stored encrypted.
	ShouldEncrypt func(rel string) bool
}

const envelopeMagic = `{"classpad":"enc1"`

// IsEnvelope reports whether a file's text is an encrypted envelope.
func IsEnvelope(text string) bool { return strings.HasPrefix(text, envelopeMagic) }

// DeriveKey derives a 32-byte key from a passphrase (scrypt N=32768, r=8, p=1, after NFKC
// normalization). Different salts give independent keys.
func DeriveKey(passphrase string, salt []byte) ([]byte, error) {
	return scrypt.Key([]byte(norm.NFKC.String(passphrase)), salt, 1<<15, 8, 1, 32)
}

// NewSalt returns 16 random bytes.
func NewSalt() []byte {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// VerifyHash checks a passphrase against a stored derived key in constant time.
func VerifyHash(passphrase string, salt, expected []byte) (bool, error) {
	got, err := DeriveKey(passphrase, salt)
	if err != nil {
		return false, err
	}
	return len(got) == len(expected) && subtle.ConstantTimeCompare(got, expected) == 1, nil
}

type envelope struct {
	Classpad string `json:"classpad"`
	IV       string `json:"iv"`
	Tag      string `json:"tag"`
	Data     string `json:"data"`
}

// EncryptText seals text with AES-256-GCM. The file's relative path is authenticated, so a
// ciphertext cannot be moved to another file.
func EncryptText(key []byte, rel, text string) (string, error) {
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	return encryptWithIV(key, iv, rel, text)
}

func encryptWithIV(key, iv []byte, rel, text string) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(text), []byte(rel))
	n := len(sealed) - gcm.Overhead()
	b64 := base64.StdEncoding.EncodeToString
	// Same field order and layout as the TypeScript store's JSON.stringify.
	return fmt.Sprintf(`{"classpad":"enc1","iv":"%s","tag":"%s","data":"%s"}`+"\n",
		b64(iv), b64(sealed[n:]), b64(sealed[:n])), nil
}

// DecryptText opens an envelope written by EncryptText (or the TypeScript store).
func DecryptText(key []byte, rel, env string) (string, error) {
	fail := storeErr(CodeDecrypt, rel, fmt.Sprintf("cannot decrypt %s (wrong passphrase, or the file was changed)", rel))
	var e envelope
	if json.Unmarshal([]byte(env), &e) != nil {
		return "", fail
	}
	dec := func(s string) []byte {
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil
		}
		return b
	}
	iv, tag, data := dec(e.IV), dec(e.Tag), dec(e.Data)
	gcm, err := newGCMSize(key, len(iv))
	if err != nil || len(iv) == 0 || len(tag) != gcm.Overhead() {
		return "", fail
	}
	plain, err := gcm.Open(nil, iv, append(data, tag...), []byte(rel))
	if err != nil {
		return "", fail
	}
	return string(plain), nil
}

func newGCM(key []byte) (cipher.AEAD, error) { return newGCMSize(key, 12) }

func newGCMSize(key []byte, ivLen int) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if ivLen == 12 {
		return cipher.NewGCM(block)
	}
	if ivLen < 1 {
		return nil, fmt.Errorf("empty iv")
	}
	return cipher.NewGCMWithNonceSize(block, ivLen)
}
