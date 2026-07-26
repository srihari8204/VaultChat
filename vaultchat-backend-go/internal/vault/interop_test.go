package vault

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestVaultInterop proves rows written by either backend decrypt/verify in the
// other, by driving the real Node lib/vault.js (same pattern as the crypto
// parity suite driving vc-crypto-cli). Skips when node or the Node backend is
// absent — never a false green.
func TestVaultInterop(t *testing.T) {
	vaultJS, err := filepath.Abs(filepath.Join("..", "..", "..", "vaultchat-backend", "lib", "vault.js"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(vaultJS); err != nil {
		t.Skipf("vaultchat-backend/lib/vault.js not found: %v", err)
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH")
	}

	t.Setenv("VAULTCHAT_MASTER_KEY", "8f3a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8")
	t.Setenv("VAULTCHAT_LOOKUP_PEPPER", "interop-test-pepper")

	const (
		plain      = "héllo 👋 vault — PII round trip"
		secret     = "482913"
		ticketData = "d41d8cd98f00b204e9800998ecf8427e"
		email      = "  Foo.Bar+x@EXAMPLE.com  "
		phone      = " +91 98765-43210 "
		clientSha  = "AbCdEf0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	)

	goEnvelope, err := Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	goPhc, err := HashSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	goTicket, err := SignTicket(ticketData, 900)
	if err != nil {
		t.Fatal(err)
	}
	goEmail, err := EmailLookup(email)
	if err != nil {
		t.Fatal(err)
	}
	goPhone, err := PhoneLookup(phone)
	if err != nil {
		t.Fatal(err)
	}
	goDisc, err := DiscoveryHash(clientSha)
	if err != nil {
		t.Fatal(err)
	}

	in, _ := json.Marshal(map[string]string{
		"plain": plain, "secret": secret, "ticketData": ticketData,
		"email": email, "phone": phone, "clientSha": clientSha,
		"goEnvelope": goEnvelope, "goPhc": goPhc, "goTicket": goTicket,
		"goEmailLookup": goEmail, "goPhoneLookup": goPhone, "goDiscovery": goDisc,
	})
	var stderr bytes.Buffer
	cmd := exec.Command("node", "interop_node.js", vaultJS)
	cmd.Stdin = bytes.NewReader(in)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node driver failed: %v\n%s", err, stderr.String())
	}

	var res struct {
		Errors       []string
		NodeEnvelope string
		NodePhc      string
		NodeTicket   string
		KbBlobB64    string
		KbKeyHex     string
		KbPlainB64   string
	}
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("bad node output: %v\n%s", err, out)
	}
	for _, e := range res.Errors {
		t.Errorf("node-side: %s", e)
	}

	// Node → Go direction.
	if got, err := Decrypt(res.NodeEnvelope); err != nil || got != plain {
		t.Errorf("Decrypt(nodeEnvelope) = %q, %v", got, err)
	}
	if !VerifySecret(secret, res.NodePhc) {
		t.Error("VerifySecret rejected Node argon2 PHC")
	}
	if VerifySecret("wrong-"+secret, res.NodePhc) {
		t.Error("VerifySecret accepted wrong secret")
	}
	if !VerifyTicket(res.NodeTicket, ticketData) {
		t.Error("VerifyTicket rejected Node ticket")
	}
	if VerifyTicket(res.NodeTicket, "other-data") {
		t.Error("VerifyTicket accepted wrong data binding")
	}
	blob, _ := base64.StdEncoding.DecodeString(res.KbBlobB64)
	want, _ := base64.StdEncoding.DecodeString(res.KbPlainB64)
	if got, err := DecryptWithKey(blob, res.KbKeyHex); err != nil || !bytes.Equal(got, want) {
		t.Errorf("DecryptWithKey(node blob) failed: %v", err)
	}
}
