// The screen-share geometry an HLS viewer cannot obtain for itself.
//
// WHY THIS IS WORTH A TEST
// ------------------------
// A low-latency viewer subscribes to the publisher's own track and is handed its
// real dimensions by the SFU — measured on device 2026-08-25, an Honor sharing
// its screen arrives as exactly 1200x2664. An HLS viewer receives a fixed
// LANDSCAPE composite instead, whatever the publisher was doing, so it cannot
// tell a shared landscape game from a shared portrait phone. Those want opposite
// treatment: one wants the viewer's panel turned, the other wants it left alone.
//
// This binding is the only way that fact reaches a public viewer, and it fails
// the same silent way the egress payload once did — a webhook that binds nothing
// still answers 200, and the only symptom is that PUBG looks like a strip across
// the middle of the screen. So the binding is asserted, not assumed.
package routes

import (
	"encoding/json"
	"testing"
)

// What LiveKit actually sends when a phone starts sharing its screen. protojson
// emits lowerCamelCase, and these field names are single words, so this is also
// what the proto spelling would look like.
const screenSharePublished = `{
  "event": "track_published",
  "room": {"name": "golive_2f5d466c-de81-4680-a40b-a00ede7f6768"},
  "participant": {"identity": "cb1caeda-e862-4578-9fab-9acd248ee77d"},
  "track": {"sid":"TR_x","type":"VIDEO","source":"SCREEN_SHARE","width":1200,"height":2664}
}`

func TestTrackPayloadBinds(t *testing.T) {
	var ev goliveEvent
	if err := json.Unmarshal([]byte(screenSharePublished), &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if ev.Track == nil {
		t.Fatal("track did not bind — a public viewer would never learn the share's shape")
	}
	if ev.Track.Width != 1200 || ev.Track.Height != 2664 {
		t.Errorf("got %dx%d, want 1200x2664 (the measured Honor share)",
			ev.Track.Width, ev.Track.Height)
	}
	if !ev.Track.isScreenShare() {
		t.Error("a SCREEN_SHARE video track was not recognised as one")
	}
	if got := roomOf(ev); got != "golive_2f5d466c-de81-4680-a40b-a00ede7f6768" {
		t.Errorf("roomOf = %q — the UPDATE matches on this, so it must survive", got)
	}
}

// ONLY the video of a screen share may speak for the panel.
//
// A camera reports CAPTURE geometry rather than display geometry — the same
// handset publishes 1280x720 while drawing 720x1280, because the sensor is
// landscape and the rotation rides on the frames — so treating a camera as a
// shape would turn every viewer's phone sideways for an ordinary face. Shared
// AUDIO carries a screen-ish source and no geometry at all, so accepting it
// would clear a perfectly good shape mid-share.
func TestOnlyScreenShareVideoCounts(t *testing.T) {
	for _, tc := range []struct {
		name string
		json string
		want bool
	}{
		{"screen share video", `{"source":"SCREEN_SHARE","type":"VIDEO","width":1200,"height":2664}`, true},
		{"screen share, type omitted", `{"source":"SCREEN_SHARE","width":1200,"height":2664}`, true},
		{"lowercase source", `{"source":"screen_share","type":"video","width":8,"height":9}`, true},
		{"camera", `{"source":"CAMERA","type":"VIDEO","width":1280,"height":720}`, false},
		{"microphone", `{"source":"MICROPHONE","type":"AUDIO"}`, false},
		{"shared audio", `{"source":"SCREEN_SHARE_AUDIO","type":"AUDIO"}`, false},
		{"screen share audio track", `{"source":"SCREEN_SHARE","type":"AUDIO"}`, false},
	} {
		var tr goliveTrack
		if err := json.Unmarshal([]byte(tc.json), &tr); err != nil {
			t.Fatalf("%s: unmarshal: %v", tc.name, err)
		}
		if got := tr.isScreenShare(); got != tc.want {
			t.Errorf("%s: isScreenShare() = %v, want %v", tc.name, got, tc.want)
		}
	}
	// A nil track is the ordinary shape of every event that is not about a
	// track. It must answer false rather than panic inside the switch.
	var nilTrack *goliveTrack
	if nilTrack.isScreenShare() {
		t.Error("a nil track claimed to be a screen share")
	}
}

// The events that are NOT about a screen share must leave the stored shape
// alone. This is the binding half of that guarantee; the UPDATE's own WHERE
// clause is the other half.
func TestNonShareEventsCarryNoGeometry(t *testing.T) {
	for _, body := range []string{
		`{"event":"participant_joined","room":{"name":"golive_x"},"participant":{"identity":"u"}}`,
		`{"event":"egress_updated","egressInfo":{"egressId":"EG_a","roomName":"golive_x","status":"EGRESS_ACTIVE"}}`,
		`{"event":"track_published","room":{"name":"golive_x"},"track":{"source":"CAMERA","type":"VIDEO","width":1280,"height":720}}`,
	} {
		var ev goliveEvent
		if err := json.Unmarshal([]byte(body), &ev); err != nil {
			t.Fatalf("unmarshal %s: %v", body, err)
		}
		if ev.Track.isScreenShare() {
			t.Errorf("event would have written a share shape: %s", body)
		}
	}
}
