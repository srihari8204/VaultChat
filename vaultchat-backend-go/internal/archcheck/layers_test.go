// Package archcheck enforces the hexagonal dependency rule (openspec:
// hexagonal-architecture) for every module laid out as
// internal/<module>/{domain,app,adapters/...}:
//
//   - domain imports the standard library only;
//   - app imports the standard library and domain packages only — never an
//     adapter or infrastructure package (httpx, redisx, db, ...).
//
// Adapters may import anything. A module joins the check by having the
// folders; nothing needs registering here.
package archcheck

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const module = "vaultchat/backend-go/"

func imports(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), f, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range parsed.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			out[p] = f
		}
	}
	return out
}

// Standard-library paths have no dot in their first element.
func stdlib(p string) bool {
	return !strings.Contains(strings.SplitN(p, "/", 2)[0], ".") && !strings.HasPrefix(p, module)
}

func TestHexagonalLayers(t *testing.T) {
	modules, _ := filepath.Glob("../*")
	checked := 0
	for _, m := range modules {
		if st, err := os.Stat(filepath.Join(m, "domain")); err == nil && st.IsDir() {
			checked++
			for p, f := range imports(t, filepath.Join(m, "domain")) {
				if !stdlib(p) {
					t.Errorf("%s: domain may import the standard library only, not %q", f, p)
				}
			}
		}
		if st, err := os.Stat(filepath.Join(m, "app")); err == nil && st.IsDir() {
			for p, f := range imports(t, filepath.Join(m, "app")) {
				if !stdlib(p) && !(strings.HasPrefix(p, module) && strings.HasSuffix(p, "/domain")) {
					t.Errorf("%s: app may import the standard library and domain only, not %q", f, p)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no internal/<module>/domain found — the check is not looking where the modules are")
	}
}
