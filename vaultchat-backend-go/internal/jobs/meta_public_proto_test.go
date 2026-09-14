// meta_public_proto_test.go — the allow-list has a third copy, in a .proto.
//
// proto/ccwire/v1/envelope.proto says of its PublicMeta message:
//
//	"The cross-language assertion in msgEnvelope.selftest.ts (which reads the
//	 Go source) MUST be extended to read this .proto as a third source of
//	 truth — otherwise CC-Wire becomes the drift path the selftest exists to
//	 prevent."
//
// lib/metadataPrivacy.selftest.ts does that from the TypeScript side. This does
// it from the Go side as well, deliberately, because the two run in different
// places: `go test ./...` on a backend change does not run tsx, and a Go
// developer adding a field to MetaPublicKeys is exactly the person who will not
// notice a TypeScript suite. One assertion that only one of the two languages
// can execute is an assertion half the contributors do not have.
//
// Everything here is read-only over source files. No behaviour is exercised.
package jobs

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// protoPath is relative to this package directory.
const protoPath = "../../../proto/ccwire/v1/envelope.proto"

// stripProtoComments removes `//` line comments so an assertion tests the
// SCHEMA and not the prose describing it. envelope.proto names its
// deliberately-absent fields only in a comment, so an un-stripped search for
// "reply_to" matches the sentence forbidding it and passes on a file that has
// since declared it. Same helper, same reasoning, as stripLineComments in
// internal/realtime/payload_bounds_test.go: naive on purpose, and only ever
// used to make a search stricter, never to accept something.
func stripProtoComments(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

func readProto(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.FromSlash(protoPath))
	if err != nil {
		t.Fatalf("cannot read %s: %v — the allow-list's third source of truth is gone", protoPath, err)
	}
	return string(b)
}

// protoBlock returns the body of `message <name> { ... }`.
func protoBlock(src, name string) string {
	re := regexp.MustCompile(`message\s+` + name + `\s*\{([\s\S]*?)\n\}`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		return ""
	}
	return m[1]
}

var protoFieldRe = regexp.MustCompile(`(\w+)\s*=\s*\d+\s*;`)

// snakeToCamel maps a proto field name onto the JSON meta key it stands for.
func snakeToCamel(s string) string {
	out := make([]byte, 0, len(s))
	up := false
	for i := 0; i < len(s); i++ {
		if s[i] == '_' {
			up = true
			continue
		}
		c := s[i]
		if up && c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		up = false
		out = append(out, c)
	}
	return string(out)
}

// The .proto is EXACTLY this list — not a superset. envelope.proto: "It is not
// a superset and must never become one." A PublicMeta field no server code
// reads is a metadata leak that shipped as a schema change nobody reviewed as
// one, which is the failure mode MetaPublicKeys exists to make impossible.
func TestProtoPublicMetaMatchesMetaPublicKeysExactly(t *testing.T) {
	src := stripProtoComments(readProto(t))
	body := protoBlock(src, "PublicMeta")
	if strings.TrimSpace(body) == "" {
		t.Fatal("message PublicMeta not found in envelope.proto")
	}
	var got []string
	for _, m := range protoFieldRe.FindAllStringSubmatch(body, -1) {
		got = append(got, snakeToCamel(m[1]))
	}
	if len(got) == 0 {
		t.Fatal("parsed no fields out of message PublicMeta — the parse, not the schema, is broken")
	}
	want := append([]string(nil), MetaPublicKeys...)
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(want, ",") != strings.Join(got, ",") {
		t.Fatalf("envelope.proto PublicMeta drifted from jobs.MetaPublicKeys\n  go:    %v\n  proto: %v", want, got)
	}
}

// The negative half of the contract. Each of these five is justified as absent
// in envelope.proto's own comment; the comment is stripped above so this tests
// the message body rather than the sentence forbidding the field.
func TestProtoEnvelopeStillRefusesTheFieldsItWasBuiltWithout(t *testing.T) {
	raw := readProto(t)
	body := protoBlock(stripProtoComments(raw), "Envelope")
	if strings.TrimSpace(body) == "" {
		t.Fatal("message Envelope not found in envelope.proto")
	}
	for field, why := range map[string]string{
		"sender_uid":     "the server stamps it on delivery; a client field re-creates the typing_start spoof",
		"client_ts":      "a client clock the server would have to either trust or ignore",
		"content_length": "derivable from sealed, and a precise ciphertext length is a side channel on short messages",
		"reply_to":       "a conversation graph the server has no need to build",
		"content_type":   "MIME is content; META_PUBLIC_KEYS keeps it private",
	} {
		if strings.Contains(body, field) {
			t.Errorf("Envelope declares %s — %s", field, why)
		}
		// The prohibition is worth little if the reasoning is deleted with it:
		// the next person to want the field would find no record of the refusal.
		if !strings.Contains(raw, field) {
			t.Errorf("%s vanished from envelope.proto's NOT PRESENT block", field)
		}
	}
}

// MessageClass is the one server-visible classification CC-Wire allows, and its
// whole design is that it is COARSE: "there is no distinction between a photo
// and a video, or between a poll and a text". messages.type, the live column,
// is the opposite (see docs/METADATA_PRIVACY.md) — so if this enum ever grows
// per-media kinds it will have adopted the live schema's leak rather than
// replacing it.
func TestProtoMessageClassStaysCoarse(t *testing.T) {
	src := stripProtoComments(readProto(t))
	re := regexp.MustCompile(`enum\s+MessageClass\s*\{([\s\S]*?)\n\}`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatal("enum MessageClass not found in envelope.proto")
	}
	values := regexp.MustCompile(`(MESSAGE_CLASS_\w+)\s*=`).FindAllStringSubmatch(m[1], -1)
	var got []string
	for _, v := range values {
		got = append(got, v[1])
	}
	sort.Strings(got)
	want := []string{
		"MESSAGE_CLASS_CONTROL",
		"MESSAGE_CLASS_NORMAL",
		"MESSAGE_CLASS_SILENT",
		"MESSAGE_CLASS_SYSTEM",
		"MESSAGE_CLASS_UNSPECIFIED",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("MessageClass changed shape — a finer-grained class is a new metadata leak\n  got:  %v\n  want: %v", got, want)
	}
}
