// Package emitx bridges socket emits from Go-served routes to the Node
// process, which owns all sockets until Step 5 (realtime migration). Fire-and
// -forget POST to NODE_INTERNAL_URL/internal/emit with the shared key; a dead
// bridge degrades to "no live push" exactly like a dropped socket would —
// never a request failure.
package emitx

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

var client = &http.Client{Timeout: 3 * time.Second}

func post(body map[string]any) {
	base := os.Getenv("NODE_INTERNAL_URL")
	key := os.Getenv("INTERNAL_EMIT_KEY")
	if base == "" || key == "" {
		return
	}
	data, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", base+"/internal/emit", bytes.NewReader(data))
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
	go post(map[string]any{"userIds": uids, "event": event, "payload": payload})
}

// ToRooms emits an event to explicit socket rooms (chat:<id>, call:<id>, …).
func ToRooms(rooms []string, event string, payload any) {
	if len(rooms) == 0 {
		return
	}
	go post(map[string]any{"rooms": rooms, "event": event, "payload": payload})
}
