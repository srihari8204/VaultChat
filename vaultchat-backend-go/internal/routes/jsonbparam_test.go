package routes

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestNoGoMapAsSQLParameter catches the single most expensive recurring bug in
// this codebase: passing a Go map to a jsonb column.
//
// pgx cannot encode map[string]any as a query parameter. It compiles, it passes
// review, and it fails at EXECUTE time with:
//
//	unable to encode map[string]interface {}{...} into text format
//	for unknown type (OID 0): cannot find encode plan
//
// It has shipped to production three times:
//
//  1. migration 069's shopbook params — jsonb sent as bytea
//  2. chatsAudit — every audit entry carrying a detail payload was lost
//     SILENTLY, because an audit write deliberately swallows its own errors
//  3. runRiderState — the INSERT sat inside the rider-state transaction, so
//     marking a child PICKED UP rolled back and answered 500. Every run, every
//     child, for as long as the feature existed
//
// Each one was invisible in a different way: silent, silent, and a 500 nobody
// connected to the button that caused it. A reviewer cannot reliably spot this,
// so it is checked mechanically instead.
//
// THE FIX IS ALWAYS THE SAME: json.Marshal it and pass the string. Postgres
// accepts text for a jsonb column; it will not accept a Go map.
func TestNoGoMapAsSQLParameter(t *testing.T) {
	// Functions whose arguments become SQL parameters.
	sqlCalls := map[string]bool{
		"Exec": true, "Query": true, "QueryRow": true,
		"chatsExecU": true, "chatsQRow": true, "chatsQueryU": true,
		"chatsExecAffected": true,
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}

	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}

		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}

			// Match tx.Exec(...), db.Pool.QueryRow(...), chatsExecU(...).
			name := ""
			switch fn := call.Fun.(type) {
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			case *ast.Ident:
				name = fn.Name
			}
			if !sqlCalls[name] {
				return true
			}

			for _, arg := range call.Args {
				// Direct: tx.Exec(ctx, sql, someID, map[string]any{...})
				if isGoMapLiteral(arg) {
					report(t, fset, arg.Pos(), name)
					continue
				}
				// Wrapped: chatsQRow(ctx, uid, sql, []any{..., map[string]any{...}}, &dest)
				if lit, ok := arg.(*ast.CompositeLit); ok {
					for _, el := range lit.Elts {
						if isGoMapLiteral(el) {
							report(t, fset, el.Pos(), name)
						}
					}
				}
			}
			return true
		})
	}
}

// isGoMapLiteral reports whether an expression is a map[...]... composite
// literal — the thing pgx cannot encode.
func isGoMapLiteral(e ast.Expr) bool {
	lit, ok := e.(*ast.CompositeLit)
	if !ok {
		return false
	}
	_, isMap := lit.Type.(*ast.MapType)
	return isMap
}

func report(t *testing.T, fset *token.FileSet, pos token.Pos, call string) {
	t.Helper()
	p := fset.Position(pos)
	t.Errorf(`%s:%d passes a Go map as a SQL parameter to %s().

pgx cannot encode a map into a jsonb column. This does not fail at compile
time — it fails when the query runs, with "cannot find encode plan", and it
has taken down three separate features in this codebase already.

Marshal it first and pass the string:

    b, err := json.Marshal(detail)
    ...
    tx.Exec(ctx, q, ..., string(b))`, p.Filename, p.Line, call)
}
