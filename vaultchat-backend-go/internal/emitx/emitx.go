// Package emitx delivers socket emits from Go-served routes. Two modes,
// decided at boot by whether a LOCAL realtime hub is wired:
//
//   - Local (Go owns sockets, Step 5 done): main.go registers the realtime
//     Hub's methods into the Local* hooks below; emits go in-process.
//   - Bridge (Node still owns sockets): fire-and-forget POST to
//     NODE_INTERNAL_URL/internal/emit with the shared key. A dead bridge
//     degrades to "no live push" like a dropped socket — never a failure.
//
// The hooks are plain func vars so emitx never imports internal/realtime
// (which imports httpx/db — a cycle otherwise). nil hooks ⇒ bridge mode, so
// existing behavior is unchanged until main.go wires them.
package emitx

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"vaultchat/backend-go/internal/workx"
)

// Local hooks, wired by main.go from the realtime Hub when Go owns sockets.
var (
	LocalToUids     func(uids []string, event string, payload any)
	LocalToRooms    func(rooms []string, event string, payload any)
	LocalBroadcast  func(event string, payload any)
	LocalFanOutChat func(ctx context.Context, chatID, event string, payload any, senderID string)
)

var client = &http.Client{Timeout: 3 * time.Second}

func post(body map[string]any) { postTo("/internal/emit", body) }

func postTo(path string, body map[string]any) {
	base := os.Getenv("NODE_INTERNAL_URL")
	key := os.Getenv("INTERNAL_EMIT_KEY")
	if base == "" || key == "" {
		return
	}
	data, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", base+path, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Key", key)
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[emitx] bridge unreachable: %v", err)
		return
	}
	resp.Body.Close()
}

// ToUids emits an event to every device of each user (rooms user:<uid>).
func ToUids(uids []string, event string, payload any) {
	if len(uids) == 0 {
		return
	}
	if LocalToUids != nil {
		LocalToUids(uids, event, payload)
		return
	}
	go post(map[string]any{"userIds": uids, "event": event, "payload": payload})
}

// ToRooms emits an event to explicit socket rooms (chat:<id>, call:<id>, …).
func ToRooms(rooms []string, event string, payload any) {
	if len(rooms) == 0 {
		return
	}
	if LocalToRooms != nil {
		LocalToRooms(rooms, event, payload)
		return
	}
	go post(map[string]any{"rooms": rooms, "event": event, "payload": payload})
}

// Broadcast emits to EVERY connected socket (admin announcements).
func Broadcast(event string, payload any) {
	if LocalBroadcast != nil {
		LocalBroadcast(event, payload)
		return
	}
	go post(map[string]any{"broadcast": true, "event": event, "payload": payload})
}

// ChatNewMessage / ChatEvent deliver a chat-route write: locally via the
// realtime Hub's FanOutToChat (block-list + ghost filtering + admin mirror)
// when Go owns sockets, else through Node's identical /internal/chat-event
// path. A dropped bridge call degrades like a dropped socket.
func ChatNewMessage(chatID string, payload any) {
	if LocalFanOutChat != nil {
		submitFanOut(chatID, "new_message", payload, senderOf(payload))
		return
	}
	go postTo("/internal/chat-event", map[string]any{"kind": "new_message", "chatId": chatID, "payload": payload})
}

func ChatEvent(chatID, event string, payload any) {
	if LocalFanOutChat != nil {
		submitFanOut(chatID, event, payload, "")
		return
	}
	go postTo("/internal/chat-event", map[string]any{"kind": "chat_event", "chatId": chatID, "event": event, "payload": payload})
}

// fanOutTimeout bounds one local fan-out. It runs up to three db.SysPool
// queries on a pool of 8 connections, and it used to get
// context.Background() — a context that can never expire — from a raw `go`
// spawn per message. A stalled DB then parked one goroutine (and its pool
// slot) per send, with nothing capping either.
const fanOutTimeout = 30 * time.Second

// submitFanOut runs the local fan-out on the shared bounded pool instead of a
// per-message goroutine. workx caps concurrency, queues the overflow, and runs
// the task INLINE when even the queue is full — so an overloaded node pushes
// back on the caller rather than dropping accepted work or claiming a delivery
// that never happened.
func submitFanOut(chatID, event string, payload any, senderID string) {
	workx.Submit(func() {
		ctx, cancel := context.WithTimeout(context.Background(), fanOutTimeout)
		defer cancel()
		LocalFanOutChat(ctx, chatID, event, payload, senderID)
	})
}

// senderOf extracts payload.senderId (drives block-list suppression) from the
// publicMessage map the chats route passes, mirroring Node's
// `payload?.senderId ?? null`.
func senderOf(payload any) string {
	if m, ok := payload.(map[string]any); ok {
		if s, ok := m["senderId"].(string); ok {
			return s
		}
	}
	return ""
}

// Push is the notification to raise on a device whose app is not running.
// Optional: an event with no Push is socket-only.
type Push struct {
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Data  map[string]any `json:"data,omitempty"`
}

// NotifyUsers emits an event to specific users AND wakes the ones who are not
// connected.
//
// Distinct from ToUids, which is socket-only. The membership flow needs this
// because its whole audience is people the socket fan-out cannot reach: an
// invitee is not in the chat room (that is the point of being invited), and
// somebody who is invited while the app is closed learns nothing from an emit
// into the void.
//
// Node decides per user whether a push is warranted — it suppresses one for
// anybody with a live socket, since they have already been told in-app. Doing
// that here would need socket state Go does not have in bridge mode.
//
// Always local-plus-bridge, never local-only: even when Go owns sockets, the
// push itself is still sent by Node.
func NotifyUsers(uids []string, event string, payload any, push *Push) {
	if len(uids) == 0 {
		return
	}
	if LocalToUids != nil {
		LocalToUids(uids, event, payload)
	}
	body := map[string]any{
		"userIds": uids,
		"event":   event,
		"payload": payload,
		// Tell Node not to emit twice when Go already did.
		"socket": LocalToUids == nil,
	}
	if push != nil {
		body["push"] = push
	}
	go postTo("/internal/notify", body)
}
