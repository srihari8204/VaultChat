// vaultbeam_storage_test.go — VaultBeam's storage backend is addressable on
// its own, without dragging every other subsystem with it.
//
// # WHY THIS EXISTS
//
// S3_BUCKET is read by three unrelated places: user media (user.go:2610),
// general storage (storage/storage.go:25) and VaultBeam (vaultbeam.go). The
// obvious way to move transfers to a different bucket — repoint S3_BUCKET —
// would therefore ALSO repoint attachments and general media at a bucket that
// does not contain them. Every existing attachment would 404.
//
// The VAULTBEAM_* overrides prevent that. The single most important property
// here is the FIRST test: with none of them set, every accessor returns exactly
// what the old code returned, so this cannot change production until someone
// deliberately configures it.
//
// PURE. Reads only environment variables; touches no network and no database.
package routes

import (
	"os"
	"testing"
)

// The property that makes this change safe to merge un-deployed: unset
// VAULTBEAM_* ⇒ identical behaviour to the pre-existing S3_* reads.
func TestVaultBeamStorageFallsBackToSharedConfig(t *testing.T) {
	t.Setenv("VAULTBEAM_S3_BUCKET", "")
	t.Setenv("VAULTBEAM_S3_ENDPOINT", "")
	t.Setenv("VAULTBEAM_S3_PUBLIC_ENDPOINT", "")
	t.Setenv("VAULTBEAM_S3_ACCESS_KEY", "")
	t.Setenv("VAULTBEAM_S3_SECRET_KEY", "")
	t.Setenv("VAULTBEAM_S3_REGION", "")

	t.Setenv("S3_BUCKET", "vaultchat-media")
	t.Setenv("S3_ENDPOINT", "http://minio:9000")
	t.Setenv("S3_PUBLIC_ENDPOINT", "http://65.21.229.167:19000")
	t.Setenv("S3_ACCESS_KEY", "shared-ak")
	t.Setenv("S3_SECRET_KEY", "shared-sk")
	t.Setenv("S3_REGION", "auto")

	for _, c := range []struct{ name, got, want string }{
		{"bucket", vbBucket(), "vaultchat-media"},
		{"server endpoint", vbServerEndpoint(), "http://minio:9000"},
		{"sign endpoint", vbSignEndpoint(), "http://65.21.229.167:19000"},
		{"access key", vbAccessKey(), "shared-ak"},
		{"secret key", vbSecretKey(), "shared-sk"},
		{"region", vbRegion(), "auto"},
	} {
		if c.got != c.want {
			t.Errorf("%s: got %q, want %q — unset VAULTBEAM_* must change nothing", c.name, c.got, c.want)
		}
	}
}

// The whole point: transfers move without media moving.
func TestVaultBeamOverridesDoNotDisturbSharedConfig(t *testing.T) {
	t.Setenv("S3_BUCKET", "vaultchat-media")
	t.Setenv("S3_ENDPOINT", "http://minio:9000")
	t.Setenv("S3_PUBLIC_ENDPOINT", "http://65.21.229.167:19000")
	t.Setenv("S3_ACCESS_KEY", "shared-ak")
	t.Setenv("S3_SECRET_KEY", "shared-sk")

	t.Setenv("VAULTBEAM_S3_BUCKET", "vaultchat-beam")
	t.Setenv("VAULTBEAM_S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com")
	t.Setenv("VAULTBEAM_S3_PUBLIC_ENDPOINT", "https://storage.corefinite.com")
	t.Setenv("VAULTBEAM_S3_ACCESS_KEY", "r2-ak")
	t.Setenv("VAULTBEAM_S3_SECRET_KEY", "r2-sk")

	if vbBucket() != "vaultchat-beam" {
		t.Errorf("bucket override ignored: %q", vbBucket())
	}
	if vbServerEndpoint() != "https://acct.r2.cloudflarestorage.com" {
		t.Errorf("server endpoint override ignored: %q", vbServerEndpoint())
	}
	if vbSignEndpoint() != "https://storage.corefinite.com" {
		t.Errorf("public endpoint override ignored: %q", vbSignEndpoint())
	}
	if vbAccessKey() != "r2-ak" || vbSecretKey() != "r2-sk" {
		t.Error("credential override ignored")
	}
	// The shared values the OTHER subsystems read are untouched. This is the
	// assertion that would have caught a global S3_BUCKET swap.
	if got := os.Getenv("S3_BUCKET"); got != "vaultchat-media" {
		t.Errorf("shared S3_BUCKET was disturbed: %q", got)
	}
}

// Defaults, and the no-recursion contract between the two endpoint helpers.
func TestVaultBeamEndpointPrecedenceAndDefaults(t *testing.T) {
	for _, k := range []string{
		"VAULTBEAM_S3_BUCKET", "VAULTBEAM_S3_ENDPOINT", "VAULTBEAM_S3_PUBLIC_ENDPOINT",
		"VAULTBEAM_S3_REGION", "S3_BUCKET", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_REGION",
	} {
		t.Setenv(k, "")
	}
	if vbBucket() != "vaultchat-media" {
		t.Errorf("default bucket changed: %q", vbBucket())
	}
	if vbRegion() != "auto" {
		t.Errorf("default region changed: %q", vbRegion())
	}
	// Both empty: the helpers must terminate, not call each other forever.
	if vbSignEndpoint() != "" || vbServerEndpoint() != "" {
		t.Error("empty config should yield empty endpoints")
	}

	// Only a public endpoint configured: the server helper falls back to it,
	// preserving the pre-existing behaviour of vbServerEndpoint().
	t.Setenv("S3_PUBLIC_ENDPOINT", "https://storage.corefinite.com")
	if vbServerEndpoint() != "https://storage.corefinite.com" {
		t.Errorf("server endpoint should fall back to public: %q", vbServerEndpoint())
	}
	// Only an internal endpoint configured: the sign helper falls back to it.
	t.Setenv("S3_PUBLIC_ENDPOINT", "")
	t.Setenv("S3_ENDPOINT", "http://minio:9000")
	if vbSignEndpoint() != "http://minio:9000" {
		t.Errorf("sign endpoint should fall back to internal: %q", vbSignEndpoint())
	}
}
