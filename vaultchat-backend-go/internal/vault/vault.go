// Package vault — byte-compatible port of vaultchat-backend/lib/vault.js.
//
// Same envelope (v1 ‖ salt16 ‖ iv12 ‖ ct ‖ tag16, base64), same HKDF info
// ("vaultchat-pii-v1"), same HMAC pepper hashes, same Argon2id params
// (64 MB / t=3 / p=4, PHC strings), same ticket format. Rows written by either
// backend decrypt/verify in the other — proven by TestVaultInterop against
// Node-produced values.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/hkdf"
)

const (
	version = 0x01
	saltLen = 16
	ivLen   = 12
	tagLen  = 16
	keyLen  = 32
)

var hkdfInfo = []byte("vaultchat-pii-v1")
var hexKeyRe = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func masterKey() ([]byte, error) {
	raw := os.Getenv("VAULTCHAT_MASTER_KEY")
	if raw == "" {
		return nil, errors.New("VAULTCHAT_MASTER_KEY not set")
	}
	var key []byte
	var err error
	if hexKeyRe.MatchString(raw) {
		key, err = hex.DecodeString(raw)
	} else {
		key, err = base64.StdEncoding.DecodeString(raw)
	}
	if err != nil || len(key) != keyLen {
		return nil, errors.New("VAULTCHAT_MASTER_KEY must decode to 32 bytes (hex or base64)")
	}
	return key, nil
}

func pepper() (string, error) {
	p := os.Getenv("VAULTCHAT_LOOKUP_PEPPER")
	if p == "" {
		return "", errors.New("VAULTCHAT_LOOKUP_PEPPER not set")
	}
	return p, nil
}

func deriveKey(salt []byte) ([]byte, error) {
	mk, err := masterKey()
	if err != nil {
		return nil, err
	}
	out := make([]byte, keyLen)
	if _, err := io.ReadFull(hkdf.New(sha256.New, mk, salt, hkdfInfo), out); err != nil {
		return nil, err
	}
	return out, nil
}

// ── Normalizers (must match Node exactly) ──────────────────────────────

func NormalizeEmail(v string) string { return strings.ToLower(strings.TrimSpace(v)) }

var nonPhoneRe = regexp.MustCompile(`[^\d+]`)

func NormalizePhone(v string) string {
	s := nonPhoneRe.ReplaceAllString(strings.TrimSpace(v), "")
	if i := strings.Index(s, "+"); i > 0 {
		s = strings.ReplaceAll(s, "+", "")
	}
	if strings.HasPrefix(s, "+") {
		s = "+" + strings.ReplaceAll(s[1:], "+", "")
	}
	return s
}

var spaceRe = regexp.MustCompile(`\s+`)

func NormalizeAnswer(v string) string {
	return strings.ToLower(spaceRe.ReplaceAllString(strings.TrimSpace(v), " "))
}

// ── Two-way encryption (PII) ───────────────────────────────────────────

func Encrypt(plaintext string) (string, error) {
	salt := make([]byte, saltLen)
	iv := make([]byte, ivLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	key, err := deriveKey(salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil) // ct ‖ tag16
	env := make([]byte, 0, 1+saltLen+ivLen+len(sealed))
	env = append(env, version)
	env = append(env, salt...)
	env = append(env, iv...)
	env = append(env, sealed...)
	return base64.StdEncoding.EncodeToString(env), nil
}

func Decrypt(envelope string) (string, error) {
	buf, err := base64.StdEncoding.DecodeString(envelope)
	if err != nil {
		return "", err
	}
	if len(buf) < 1+saltLen+ivLen+tagLen {
		return "", errors.New("decrypt: envelope too short")
	}
	if buf[0] != version {
		return "", errors.New("decrypt: unsupported envelope version")
	}
	salt := buf[1 : 1+saltLen]
	iv := buf[1+saltLen : 1+saltLen+ivLen]
	sealed := buf[1+saltLen+ivLen:]
	key, err := deriveKey(salt)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// DecryptWithKey — iv12 ‖ ct ‖ tag16 with an explicit hex key (avatar blobs).
func DecryptWithKey(blob []byte, keyHex string) ([]byte, error) {
	key, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, err
	}
	if len(blob) < ivLen+tagLen {
		return nil, errors.New("decryptWithKey: blob too short")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, blob[:ivLen], blob[ivLen:], nil)
}

// ── Deterministic lookup hashes ────────────────────────────────────────

func hmacHex(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

func LookupHash(normalized string) (string, error) {
	p, err := pepper()
	if err != nil {
		return "", err
	}
	return hmacHex(p, normalized), nil
}

func EmailLookup(email string) (string, error) { return LookupHash(NormalizeEmail(email)) }
func PhoneLookup(phone string) (string, error) { return LookupHash(NormalizePhone(phone)) }

// DiscoveryHash peppers the client's sha256 hex (contact discovery, F1).
func DiscoveryHash(clientSha256Hex string) (string, error) {
	p, err := pepper()
	if err != nil {
		return "", err
	}
	return hmacHex(p, strings.ToLower(clientSha256Hex)), nil
}

// ── One-way secret hashing (Argon2id PHC, params = Node's) ─────────────

const (
	argonMem     = 65536 // KiB = 64 MB
	argonTime    = 3
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

func HashSecret(plaintext string) (string, error) {
	if plaintext == "" {
		return "", errors.New("hashSecret: empty")
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := argon2.IDKey([]byte(plaintext), salt, argonTime, argonMem, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMem, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(sum)), nil
}

var phcRe = regexp.MustCompile(`^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$`)

// VerifySecret verifies a PHC argon2id string produced by either backend.
func VerifySecret(plaintext, encoded string) bool {
	m := phcRe.FindStringSubmatch(encoded)
	if m == nil {
		return false
	}
	mem, _ := strconv.Atoi(m[1])
	t, _ := strconv.Atoi(m[2])
	p, _ := strconv.Atoi(m[3])
	salt, err := base64.RawStdEncoding.DecodeString(m[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(m[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(plaintext), salt, uint32(t), uint32(mem), uint8(p), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ── Stateless signed tickets ───────────────────────────────────────────

func SignTicket(data string, ttlSec int64) (string, error) {
	p, err := pepper()
	if err != nil {
		return "", err
	}
	exp := time.Now().Unix() + ttlSec
	body := fmt.Sprintf("%s.%d", data, exp)
	sig := hmacHex(p, "ticket|"+body)
	return base64.RawURLEncoding.EncodeToString([]byte(body + "." + sig)), nil
}

func VerifyTicket(token, expectedData string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		// Node's base64url decode is padding-tolerant; try padded form too.
		raw, err = base64.URLEncoding.DecodeString(token)
		if err != nil {
			return false
		}
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 3 {
		return false
	}
	data, expStr, sig := parts[0], parts[1], parts[2]
	if data != expectedData {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || exp < time.Now().Unix() {
		return false
	}
	p, err := pepper()
	if err != nil {
		return false
	}
	want := hmacHex(p, fmt.Sprintf("ticket|%s.%s", data, expStr))
	return len(sig) == len(want) && subtle.ConstantTimeCompare([]byte(sig), []byte(want)) == 1
}

// ── Identity decryption from a users row ───────────────────────────────

// Identity mirrors vault.identityFromRow's output.
type Identity struct {
	Email     *string
	Phone     *string
	Name      *string
	FirstName *string
	LastName  *string
	DOB       *string
	Status    *string
}

func safeDec(c *string) *string {
	if c == nil || *c == "" {
		return nil
	}
	v, err := Decrypt(*c)
	if err != nil {
		return nil
	}
	return &v
}

// IdentityFromRow decrypts cipher columns with legacy plaintext fallback,
// exactly like Node (first+last joined, else legacy name).
func IdentityFromRow(firstCipher, lastCipher, emailCipher, phoneCipher, dobCipher, statusCipher,
	legacyName, legacyEmail, legacyPhone, legacyDOB, legacyStatus *string) Identity {
	first := safeDec(firstCipher)
	last := safeDec(lastCipher)
	var name *string
	if first != nil || last != nil {
		parts := []string{}
		if first != nil {
			parts = append(parts, *first)
		}
		if last != nil {
			parts = append(parts, *last)
		}
		joined := strings.Join(parts, " ")
		name = &joined
	} else {
		name = legacyName
	}
	pick := func(dec *string, legacy *string) *string {
		if dec != nil {
			return dec
		}
		return legacy
	}
	return Identity{
		Email:     pick(safeDec(emailCipher), legacyEmail),
		Phone:     pick(safeDec(phoneCipher), legacyPhone),
		Name:      name,
		FirstName: first,
		LastName:  last,
		DOB:       pick(safeDec(dobCipher), legacyDOB),
		Status:    pick(safeDec(statusCipher), legacyStatus),
	}
}
