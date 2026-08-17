// The egress payload binding, which is what decides whether a Go Live broadcast
// ever leaves 'starting'.
//
// This exists because of a silent production failure. LiveKit v1.13.5 marshals
// webhook bodies with protojson (lowerCamelCase: "egressInfo"/"egressId"), the
// receiver declared only proto names ("egress_info"/"egress_id"), and so the
// payload never bound. The handler answered 200 to every delivery while doing
// nothing, the SFU logged "sent webhook ... 200 OK", and the broadcast sat at
// 'starting' forever — invisible to viewers, because the live listing filters on
// status = 'live'. Nothing anywhere reported an error.
//
// A 200 is therefore NOT evidence this works. Binding is, so it is asserted.
package routes

import (
	"encoding/json"
	"testing"
)

func TestGoliveEventEgressBindsBothSpellings(t *testing.T) {
	// What LiveKit v1.13.5 actually sends.
	camel := `{"event":"egress_updated","egressInfo":{"egressId":"EG_a","roomName":"golive_x","status":"EGRESS_ACTIVE"}}`
	// What older builds sent, and what this receiver used to expect.
	proto := `{"event":"egress_updated","egress_info":{"egress_id":"EG_a","room_name":"golive_x","status":"EGRESS_ACTIVE"}}`

	for name, body := range map[string]string{"camelCase": camel, "protoNames": proto} {
		var ev goliveEvent
		if err := json.Unmarshal([]byte(body), &ev); err != nil {
			t.Fatalf("%s: unmarshal: %v", name, err)
		}
		eg := ev.egress()
		if eg == nil {
			t.Fatalf("%s: egress() is nil — the payload did not bind, so "+
				"'starting' would never become 'live'", name)
		}
		if eg.EgressID != "EG_a" {
			t.Errorf("%s: EgressID = %q, want EG_a", name, eg.EgressID)
		}
		if eg.RoomName != "golive_x" {
			t.Errorf("%s: RoomName = %q, want golive_x", name, eg.RoomName)
		}
		// The status gate is what holds a not-yet-watchable stream back, so an
		// unbound status would flip 'live' too early rather than never.
		if eg.Status != "EGRESS_ACTIVE" {
			t.Errorf("%s: Status = %q, want EGRESS_ACTIVE", name, eg.Status)
		}
	}
}

// An event with no egress payload must yield nil rather than a zero-value
// struct: the handler's nil check is the only thing stopping a participant event
// from being treated as an egress update.
func TestGoliveEventEgressNilWhenAbsent(t *testing.T) {
	var ev goliveEvent
	if err := json.Unmarshal([]byte(
		`{"event":"participant_joined","room":{"name":"golive_x"},"participant":{"identity":"u1"}}`), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.egress() != nil {
		t.Error("egress() must be nil for an event carrying no egress payload")
	}
}
