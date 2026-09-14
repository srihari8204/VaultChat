package routes

import (
	"os"
	"strings"
	"testing"
)

// VAULTBEAM BITMAPS — LOST UPDATES.
//
// Both mask writers read the whole mask, set bits in Go and wrote the whole
// mask back. Two batches in flight: both read M, one wrote M|lo, the other
// M|hi, last writer won. The dropped blocks read as un-uploaded, `state` never
// reached 'ready', and the transfer wedged short of 100% — users lost transfers.
//
// The union now happens in the UPDATE itself, and the post-update value comes
// back via RETURNING so the completion decision is never made from a stale copy.
//
// THE RACE IS NOT EXERCISED — two concurrent statements need a live Postgres.
// Source-level assertions on the shape of the fix.

func vbSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("vaultbeam.go")
	if err != nil {
		t.Fatal(err)
	}
	return stripLineComments(string(b))
}

func TestVaultbeamMasksAreUnionedInSQL(t *testing.T) {
	src := vbSource(t)

	for _, col := range []string{"uploaded_mask", "recv_mask"} {
		if !strings.Contains(src, "SET "+col+" = `+vbMaskOrSQL(\""+col+"\")+`") {
			t.Errorf("%s is no longer ORed server-side", col)
		}
		if !strings.Contains(src, "RETURNING "+col) {
			t.Errorf("%s is no longer read back from the UPDATE", col)
		}
	}
	// The old shape: assigning a Go-side mask straight over the column.
	for _, bad := range []string{"SET uploaded_mask = $1,", "SET recv_mask = $1 "} {
		if strings.Contains(src, bad) {
			t.Errorf("a whole-mask overwrite is back: %q", bad)
		}
	}
	// bytea "|" needs equal widths, so the union must zero-extend the narrow
	// side. Truncating instead would drop exactly the bits at issue.
	if !strings.Contains(src, "decode(repeat('00'") || strings.Contains(src, "substring($1::bytea") {
		t.Error("vbMaskOrSQL no longer pads the narrower operand (or truncates one)")
	}
}

func TestVaultbeamReadyIsDecidedAfterTheUpdate(t *testing.T) {
	src := vbSource(t)
	body := src[strings.Index(src, "func vbRelayUploaded("):]
	body = body[:strings.Index(body, "func vbRelayGrow(")]

	update := strings.Index(body, "RETURNING uploaded_mask")
	count := strings.Index(body, "done := vbCountSet(merged")
	if update < 0 || count < 0 || count < update {
		t.Fatal("the uploaded count is no longer taken from the post-update mask")
	}
	// vb_ready must fire once. Both racers can observe a full mask; only the
	// one whose state flip actually changed a row may announce it.
	emit := strings.Index(body, `"vb_ready"`)
	guard := strings.Index(body, "ct.RowsAffected() > 0")
	if emit < 0 || guard < 0 || guard > emit {
		t.Error("vb_ready is no longer gated on this request being the one that flipped state")
	}
}
