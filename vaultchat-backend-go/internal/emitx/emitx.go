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
		go LocalFanOutChat(context.Background(), chatID, "new_message", payload, senderOf(payload))
		return
	}
	go postTo("/internal/chat-event", map[string]any{"kind": "new_message", "chatId": chatID, "payload": payload})
}

func ChatEvent(chatID, event string, payload any) {
	if LocalFanOutChat != nil {
		go LocalFanOutChat(context.Background(), chatID, event, payload, "")
		return
	}
	go postTo("/internal/chat-event", map[string]any{"kind": "chat_event", "chatId": chatID, "event": event, "payload": payload})
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
