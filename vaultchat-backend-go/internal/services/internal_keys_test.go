package services

import (
	"net/http/httptest"
	"testing"
)

func TestInternalCaller(t *testing.T) {
	call := func(key string) (string, bool) {
		r := httptest.NewRequest("POST", "/internal/notify", nil)
		if key != "" {
			r.Header.Set("X-Internal-Key", key)
		}
		return InternalCaller(r)
	}

	t.Setenv("INTERNAL_EMIT_KEY", "")
	t.Setenv("INTERNAL_SERVICE_KEYS", "")
	if _, ok := call("anything"); ok {
		t.Fatal("with no key configured nothing may pass")
	}
	if _, ok := call(""); ok {
		t.Fatal("a missing header must not match an unset key")
	}

	t.Setenv("INTERNAL_EMIT_KEY", "legacy-key")
	t.Setenv("INTERNAL_SERVICE_KEYS", "golive=live-key, family = fam-key ,bogus=bogus-key,broken")
	for key, want := range map[string]string{"legacy-key": "internal", "live-key": "golive", "fam-key": "family"} {
		if got, ok := call(key); !ok || got != want {
			t.Errorf("key %q: caller=%q ok=%v, want %q", key, got, ok, want)
		}
	}
	for _, key := range []string{"", "wrong", "bogus-key", "live-key "} {
		if _, ok := call(key); ok {
			t.Errorf("key %q must be refused", key)
		}
	}
}
