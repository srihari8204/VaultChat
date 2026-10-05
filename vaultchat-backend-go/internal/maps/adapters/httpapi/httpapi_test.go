package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/maps/adapters/photon"
	"vaultchat/backend-go/internal/maps/adapters/valhalla"
	"vaultchat/backend-go/internal/maps/app"
)

// The hexagonal move must not change a byte the client sees: these tests run
// the real inbound adapter and outbound adapters against stub engines and pin
// the response bodies the old routes/nav.go produced.

func serve(t *testing.T, engine, geocoder http.HandlerFunc) *http.ServeMux {
	t.Helper()
	t.Setenv("JWT_SECRET", "test-secret")
	v := httptest.NewServer(engine)
	t.Cleanup(v.Close)
	p := httptest.NewServer(geocoder)
	t.Cleanup(p.Close)
	mux := http.NewServeMux()
	Register(mux, &app.Service{Engine: valhalla.Engine{BaseURL: v.URL}, Geocoder: photon.Geocoder{BaseURL: p.URL}})
	return mux
}

func call(t *testing.T, mux *http.ServeMux, method, path, body string) (int, string) {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "u1", "exp": time.Now().Add(time.Minute).Unix(),
	}).SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

func TestMatrixBodyUnchanged(t *testing.T) {
	var sent map[string]any
	mux := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sources_to_targets" {
			t.Errorf("path %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		_, _ = io.WriteString(w, `{"sources_to_targets":[[{"distance":1.2,"time":300}],[{"distance":null,"time":null}]]}`)
	}, nil)
	code, body := call(t, mux, "POST", "/nav/matrix",
		`{"sources":[{"lat":0,"lng":0},{"lat":17.3,"lng":78.4},{"lat":17.4,"lng":78.5}],"target":{"lat":17.5,"lng":78.6},"costing":"rocket"}`)
	if code != 200 || body != `{"costing":"auto","results":[{"distanceM":1200,"durationS":300,"index":1}]}` {
		t.Fatalf("got %d %s", code, body)
	}
	if n := len(sent["sources"].([]any)); n != 2 {
		t.Fatalf("null island must not be sent; engine got %d sources", n)
	}
}

func TestMatrixErrorsUnchanged(t *testing.T) {
	mux := serve(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"error":"no"}`)
	}, nil)
	cases := []struct{ body, want string }{
		{`{"sources":[{"lat":1,"lng":1}]}`, `{"error":"target{lat,lng} required"}`},
		{`{"target":{"lat":1,"lng":1}}`, `{"error":"at least one source required"}`},
		{`{"sources":[{"lat":0,"lng":0}],"target":{"lat":1,"lng":1}}`, `{"error":"no source had a usable coordinate"}`},
		{`{"sources":[{"lat":1,"lng":1}],"target":{"lat":91,"lng":1}}`, `{"error":"target coordinate out of range"}`},
	}
	for _, c := range cases {
		if code, body := call(t, mux, "POST", "/nav/matrix", c.body); code != 400 || body != c.want {
			t.Errorf("%s: got %d %s", c.body, code, body)
		}
	}
	code, body := call(t, mux, "POST", "/nav/matrix", `{"sources":[{"lat":1,"lng":1}],"target":{"lat":2,"lng":2}}`)
	if code != 502 || body != `{"detail":"{\"error\":\"no\"}","error":"routing engine error"}` {
		t.Fatalf("refused: got %d %s", code, body)
	}
}

func TestRoutePassesThroughAndWhitelistsOptions(t *testing.T) {
	var sent map[string]any
	mux := serve(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		_, _ = io.WriteString(w, `{"trip":{"raw":true}}`)
	}, nil)
	code, body := call(t, mux, "POST", "/nav/route",
		`{"from":{"lat":1,"lng":2},"to":{"lat":3,"lng":4},"costing":"auto","costing_options":{"auto":{"shortest":true,"use_tolls":0,"evil":1}}}`)
	if code != 200 || body != `{"trip":{"raw":true}}` {
		t.Fatalf("got %d %s", code, body)
	}
	opts, _ := json.Marshal(sent["costing_options"])
	if string(opts) != `{"auto":{"shortest":true,"use_tolls":0}}` || sent["alternates"] != float64(2) {
		t.Fatalf("engine got costing_options=%s alternates=%v", opts, sent["alternates"])
	}
	if code, body := call(t, mux, "POST", "/nav/route", `{"from":{"lat":"1","lng":2},"to":{"lat":3,"lng":4}}`); code != 400 ||
		body != `{"error":"from{lat,lng} + to{lat,lng} required"}` {
		t.Fatalf("string lat: got %d %s", code, body)
	}
}

func TestRouteEngineDownIs503(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	mux := http.NewServeMux()
	Register(mux, &app.Service{Engine: valhalla.Engine{BaseURL: "http://127.0.0.1:1"}})
	code, body := call(t, mux, "POST", "/nav/route", `{"from":{"lat":1,"lng":2},"to":{"lat":3,"lng":4}}`)
	if code != 503 || body != `{"error":"routing engine unavailable"}` {
		t.Fatalf("got %d %s", code, body)
	}
}

func TestTraceUnchanged(t *testing.T) {
	mux := serve(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"trip":{"summary":{"length":12.3456,"time":901.6}}}`)
	}, nil)
	code, body := call(t, mux, "POST", "/nav/trace", `{"shape":[{"lat":17.3,"lng":78.4},{"lat":17.4,"lng":78.5}]}`)
	if code != 200 || body != `{"distanceM":12346,"durationS":902,"matched":true}` {
		t.Fatalf("got %d %s", code, body)
	}
	code, body = call(t, mux, "POST", "/nav/trace", `{"shape":[{"lat":17.3,"lng":78.4}]}`)
	if code != 200 || body != `{"distanceM":0,"durationS":0,"matched":false}` {
		t.Fatalf("one fix: got %d %s", code, body)
	}
	if code, _ := call(t, mux, "POST", "/nav/trace", `not json`); code != 400 {
		t.Fatalf("bad body: got %d", code)
	}
}

func TestGeocodeUnchanged(t *testing.T) {
	var query string
	mux := serve(t, nil, func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		_, _ = io.WriteString(w, `{"features":[
			{"geometry":{"coordinates":[78.47,17.36]},"properties":{"name":"Charminar","city":"Hyderabad","state":"Telangana","country":"India"}},
			{"geometry":{"coordinates":[1]},"properties":{"name":"broken"}}]}`)
	})
	code, body := call(t, mux, "GET", "/nav/geocode?q=char+minar&lat=17.3&lon=78.4", "")
	if code != 200 || body != `[{"label":"Charminar, Hyderabad, Telangana","lat":17.36,"lng":78.47,"name":"Charminar"}]` {
		t.Fatalf("got %d %s", code, body)
	}
	if query != "limit=8&q=char+minar&lat=17.3&lon=78.4" {
		t.Fatalf("upstream query %q", query)
	}
	if code, body := call(t, mux, "GET", "/nav/geocode?q=a", ""); code != 400 || body != `{"error":"q (2-200 chars) required"}` {
		t.Fatalf("short q: got %d %s", code, body)
	}
}
