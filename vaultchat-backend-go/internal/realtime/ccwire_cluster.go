package realtime

import (
	"context"
	"encoding/json"
	"time"
	"vaultchat/backend-go/internal/redisx"
)

// Socket.IO's Redis adapter cannot deliver to native sessions. This channel
// carries the already-authorized audience only; receivers never republish it.
type ccwireClusterEvent struct {
	Node    string          `json:"node"`
	UID     string          `json:"uid,omitempty"`
	Chat    string          `json:"chat,omitempty"`
	Rooms   []string        `json:"rooms,omitempty"`
	Exclude string          `json:"exclude,omitempty"`
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
}

func (h *Hub) publishCCWire(uid, chat string, rooms []string, exclude, event string, payload any, parents ...context.Context) {
	if !appEventsEnabled() || !ClusterEnabled() {
		return
	}
	p, err := json.Marshal(payload)
	if err != nil || len(p) > maxAppEventPayload {
		return
	}
	raw, err := json.Marshal(ccwireClusterEvent{nodeID, uid, chat, rooms, exclude, event, p})
	if err != nil {
		return
	}
	parent := context.Context(bg)
	if len(parents) > 0 && parents[0] != nil {
		parent = parents[0]
	}
	ctx, cancel := context.WithTimeout(parent, time.Second)
	defer cancel()
	_ = redisx.Client.Publish(ctx, keyPrefix+"ccwire:events:v1", raw).Err()
}

func (h *Hub) startCCWireCluster() {
	if !appEventsEnabled() || !ClusterEnabled() {
		return
	}
	ctx, cancel := context.WithCancel(bg)
	sub := redisx.Client.Subscribe(ctx, keyPrefix+"ccwire:events:v1")
	readyCtx, readyCancel := context.WithTimeout(ctx, time.Second)
	_, err := sub.Receive(readyCtx)
	readyCancel()
	if err != nil {
		cancel()
		_ = sub.Close()
		return
	}
	h.cwBusClose = func() { cancel(); _ = sub.Close() }
	go func() {
		defer sub.Close()
		for {
			message, err := sub.ReceiveMessage(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(100 * time.Millisecond):
				}
				continue
			}
			if len(message.Payload) > maxAppEventPayload+4096 {
				continue
			}
			var e ccwireClusterEvent
			if json.Unmarshal([]byte(message.Payload), &e) != nil || e.Node == nodeID || e.Event == "" {
				continue
			}
			var value any
			if json.Unmarshal(e.Payload, &value) != nil {
				continue
			}
			if e.UID != "" {
				h.ccwireDeliverLocal(e.Chat, e.UID, e.Event, value)
			} else {
				h.ccwireRoomsLocal(e.Rooms, e.Exclude, e.Event, value)
			}
		}
	}()
}
