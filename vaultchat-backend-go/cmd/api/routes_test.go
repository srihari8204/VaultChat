package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"vaultchat/backend-go/internal/services"
)

// Without a token, a served authenticated path answers 401 and a path this
// process does not serve answers 404, so the status alone shows ownership.
func TestServicesOwnTheirPaths(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-test-secret-test-secret")
	cases := []struct {
		services string
		served   []string
		notHere  []string
	}{
		{"all",
			[]string{"GET /chats", "GET /chats/c1/roster", "GET /user/sos", "POST /broadcasts", "POST /nav/route", "GET /shopbook/shops/mine", "GET /games/tables"},
			nil},
		{"core",
			[]string{"GET /chats", "GET /user/profile", "GET /chats/c1/messages"},
			// POST: core's GET /user/ subtree asks for auth before it 404s.
			[]string{"GET /chats/c1/roster", "POST /user/sos", "GET /contacts/trusted", "POST /broadcasts", "POST /nav/route", "GET /games/tables"}},
		{"golive",
			[]string{"POST /broadcasts"},
			[]string{"GET /chats", "GET /user/profile", "GET /chats/c1/roster"}},
		{"family",
			[]string{"GET /chats/c1/roster", "GET /chats/c1/locations/latest", "GET /user/sos", "GET /contacts/trusted"},
			[]string{"GET /chats", "GET /chats/c1/messages", "GET /user/profile"}},
		{"maps",
			[]string{"POST /nav/route"},
			[]string{"GET /chats", "POST /broadcasts"}},
	}
	for _, c := range cases {
		if err := services.SetForTest(c.services); err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		registerRoutes(mux)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
		status := func(route string) int {
			var method, path string
			for i := range route {
				if route[i] == ' ' {
					method, path = route[:i], route[i+1:]
					break
				}
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
			return rec.Code
		}
		for _, r := range c.served {
			if got := status(r); got != http.StatusUnauthorized {
				t.Errorf("SERVICES=%s: %s = %d, want 401 (served, needs auth)", c.services, r, got)
			}
		}
		for _, r := range c.notHere {
			if got := status(r); got != http.StatusNotFound {
				t.Errorf("SERVICES=%s: %s = %d, want 404 (not this service)", c.services, r, got)
			}
		}
	}
	_ = services.SetForTest("all")
}
