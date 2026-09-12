package main

import (
	"os"
	"strings"
	"testing"
)

// P0-2 — CAN YOU TELL WHAT PRODUCTION IS RUNNING?
//
// Before this, no. The deployed box builds from a checkout hundreds of commits
// behind its own git HEAD, with hundreds of modified files copied over it, so
// neither `git rev-parse` on the box nor a tag in this repo describes the
// binary. The only honest identifier is a hash of the source that compiled.
//
// These tests guard the two halves of that contract, because both fail SILENTLY
// — a broken one does not crash anything, it just makes /build say "unknown"
// forever, and nobody finds out until the next incident.

func TestBuildInfoSaysUnknownRatherThanGuessing(t *testing.T) {
	// The vars are empty in a `go test` build, which is exactly the case this
	// asserts: a binary built outside the Dockerfile must SAY so.
	info := buildInfo()
	if !strings.Contains(info["source"].(string), "unknown") {
		t.Errorf("a binary with no injected provenance should say unknown, got %q", info["source"])
	}
	if info["builtAt"] != "unknown" {
		t.Errorf("builtAt should fall back to unknown, got %q", info["builtAt"])
	}
}

func dockerfileAndScript(t *testing.T) (string, string) {
	t.Helper()
	d, err := os.ReadFile("../../Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	s, err := os.ReadFile("../../../scripts/fingerprint-go.sh")
	if err != nil {
		t.Fatal(err)
	}
	return string(d), string(s)
}

func TestDockerfileInjectsProvenance(t *testing.T) {
	df, _ := dockerfileAndScript(t)

	// The -X flags must name these exact symbols. A rename on either side
	// leaves the linker silently writing nothing.
	for _, want := range []string{"-X main.buildSource=", "-X main.buildTime="} {
		if !strings.Contains(df, want) {
			t.Errorf("Dockerfile no longer injects %s — every deploy would report 'unknown'", want)
		}
	}

	// The fingerprint must cover go.mod/go.sum as well as the .go files: a
	// dependency bump changes the binary without changing a single source file,
	// and a fingerprint that misses it reports the same id for different code.
	for _, want := range []string{"*.go", "go.mod", "go.sum", "sha256sum"} {
		if !strings.Contains(df, want) {
			t.Errorf("the source fingerprint no longer covers %s", want)
		}
	}

	// Tests must stay OUT of it, or the id changes when only a test did and
	// "prod matches my checkout" stops being answerable.
	if !strings.Contains(df, "-not -name '*_test.go'") {
		t.Error("the fingerprint no longer excludes test files")
	}
}

// The script and the Dockerfile must run the SAME pipeline, or comparing a
// local fingerprint against production compares two different things — which is
// worse than having no fingerprint, because it looks like an answer.
//
// Every step matters, not just the file set: the sort order, the CR stripping
// and the truncation each change the result, so a difference in any one of them
// makes the two sides permanently unequal while both still look correct on
// their own.
func TestFingerprintScriptMatchesTheDockerfile(t *testing.T) {
	df, sh := dockerfileAndScript(t)

	steps := []string{
		`find . -type f \( -name '*.go' -not -name '*_test.go' \) -o -name 'go.mod' -o -name 'go.sum'`,
		`LC_ALL=C`,
		`tr -d '\r' < "$f" | sha256sum | cut -d' ' -f1`,
		`cut -c1-16`,
	}
	for _, step := range steps {
		if !strings.Contains(df, step) {
			t.Errorf("the Dockerfile no longer does: %s", step)
		}
		if !strings.Contains(sh, step) {
			t.Errorf("fingerprint-go.sh no longer does: %s", step)
		}
	}
}
