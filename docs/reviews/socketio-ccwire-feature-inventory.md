# Socket.IO to CC-Wire frontend feature inventory

Audit date: 2026-09-15. Source inspection only; this document does not claim deployment or device verification. References are repository-relative and identify the inspected snapshot; parallel implementation may move lines.

## Current ownership

- The sole direct production `socket.io-client` import in app/lib/services/hooks/components is `lib/socket.ts:17`; dependency declared in `package.json:164`.
- `lib/socket.ts:125` starts CC-Wire conditionally but always constructs Socket.IO (`:175`). This is coexistence, not replacement.
- `lib/ccwire/transport.ts:1` explicitly describes a submission supervisor. `submitCCWireMessage` accepts eligible text only, consumes request-correlated MessageAck, fetches the canonical row through HTTP, and falls back sequentially with the same client ID/ciphertext. Type/reply/unsupported metadata remain HTTP. Do not silently remove those semantics.
- `lib/ccwire/client.ts:750` exposes arbitrary decoded frames, but the supervisor does not currently translate these into the app's named inbound events. The existence of protobuf bodies is not frontend parity.
- `lib/ccwire/client.ts:77` defines a 10-second heartbeat interval and 5-second timeout, negotiated from ServerHello. Socket.IO currently has its own heartbeat too.

## Consumer and event map

These are actual source references, including dynamically imported and generic wrappers. Legacy call screens remain in scope while their routes are shipped, regardless of whether the preferred call flow uses LiveKit.

| Consumer | Events / dependency | Reference |
| --- | --- | --- |
| Open chat | `new_message`, `message_edited`, `message_deleted`, `message_delivered`, `message_read`, `typing_start`, `typing_stop`, `presence_changed`, `screenshot_captured`, `media_revoked`, `poll_voted`, `poll_unvoted`, `message_pinned`, `live_location_update`, `live_location_stop` | `app/chat.tsx:1236` |
| Chat list | `connect`, message create/edit/delete, presence, typing; `invitation_created` through dynamically imported `on` | `app/(tabs)/chats.tsx:136`, `:296` |
| Global app | Persistent `call_incoming`, `e2ee_rekey`, `new_message`; emits `webrtc_end` for declined calls | `app/_layout.tsx:476`, `:481`, `:542`, `:726` |
| Durable sync | Persistent new/edit/delete hints schedule delta catch-up; ONLINE state triggers recovery | `lib/syncEngine.ts:16`, `:288` |
| Durable receipts | ONLINE state triggers receipt flush | `lib/receipts.ts:12` |
| Background service | Dynamically imports socket and persistent `new_message` notification listener | `lib/backgroundConnection.ts:58` |
| Viewers | `viewer_list`, `viewer_joined`, `viewer_left`, `viewer_activity`; `connect` re-announces; `chat_view` outbound | `hooks/useChatViewers.ts:58`, `:87`; `lib/socket.ts:491` |
| Stories | `story_posted` | `app/(tabs)/status.tsx:158` |
| Broadcast channels | `channel_join`, `channel_leave`, `channel_post` | `app/broadcast.tsx:78` |
| ShopBook | Dynamic persistent `shopbook:event` | `app/shop-book.tsx:1184` |
| Encryption recovery | `e2ee_rekey` outbound | `lib/chatService.ts:682` |
| Shared call signalling | `webrtc_offer`, `webrtc_answer`, `webrtc_ice`, `webrtc_end`, `screen_share_start`, `screen_share_stop`, `call_chat`, `call_media_key`, `call_emoji` | `lib/call/signal.ts:116`, `:140`, `:323` |
| Call room membership | `join_call`, `leave_call`, `call_roster`, `call_peer_joined`, `call_peer_left`, `call_full`; reconnect rejoin | `lib/call/signal.ts:200`, `:224` |
| Call moderation/session | `call_role_changed`, `call_hand_changed`, `call_session_ended`; outbound `call_incoming` | `lib/call/signal.ts:269`, `:312` |
| Incoming call route | `webrtc_offer`, `webrtc_end` inbound; `webrtc_end` outbound | `app/incoming-call.tsx:133`, `:154`, `:198` |
| Voice call route | answer/ICE/end listeners; ring/offer/answer/ICE/end emissions and answer retries | `app/voicecall.tsx:540`, `:602`, `:646` |
| Video call route | Voice signalling plus screen-share start/stop | `app/videocall.tsx:750`, `:814`, `:854`, `:913` |
| Group call routes | `call_incoming`; roster/peer/full/offer/answer/ICE; join/leave call | `app/group-calls.tsx:83`; `app/group-call-active.tsx:613` |
| VaultBeam direct signalling | `vaultbeam_ready`, `vaultbeam_offer`, `vaultbeam_answer`, `vaultbeam_ice`, `vaultbeam_pull`, `vaultbeam_tier`; dynamic waiter event names | `lib/vaultBeamDirect.ts:111`, `:171`, `:408`, `:424`, `:462` |
| VaultBeam completion | Persistent `vb_complete`, `vb_have`, `vb_abort` | `lib/vaultBeamController.ts:397` |
| Live location composer | Emits `live_location_update`, `live_location_stop` via retained socket reference | `app/location-sharing.tsx:98`, `:133`, `:142`; `app/location.tsx:26` |
| Family foreground presence | Emits/listens location update/stop; listens `new_message`; chat-room membership | `lib/family/presence.ts:419`, `:688`, `:916` |
| Family background presence | Shared emit wrapper | `lib/family/background.ts:25` |
| Family recovery | Dynamic socket connection-state dependency | `lib/family/refresh.ts:187` |
| Space location | `space_location`, `space_location_stop`, `space_location_sharing` | `lib/location/live.ts:58`, `:167`, `:191` |
| Trips | Constants `trip_update`, `trip_end`; `new_message`, `space_trip`, `space_trip_end`; joins chat room | `lib/groups/tripSession.ts:25`, `:210`, `:399` |
| Runs | Constants `run_update`, `run_end`, `run_subscribe`, `run_unsubscribe`; server must authorize run-specific subscription | `lib/spaces/runSession.ts:41`, `:116`, `:134` |
| Connection UI | `useConnectionState` drives banner and message UI | `components/ConnectionBanner.tsx:10`; `components/chat/MessageBubble.tsx:61` |
| Account lifecycle | Disconnect on logout/delete account | `app/(tabs)/profile.tsx:29`; `app/delete-account.tsx:30` |

## Required API compatibility

`getSocket()` returns a concrete Socket.IO Socket today. Most consumers only need `on`, `off`, `emit`; some subscribe to `connect`. Keep one stable event facade across carrier replacement so retained screen references do not become stale. Do not emulate the entire Socket.IO implementation.

- `lib/socket.ts:363`: `getSocket` lazily connects and shares its in-flight promise.
- `lib/socket.ts:402`: persistent listener registration auto-connects and survives replacement. Preserve returned cleanup functions and listener registration during handshake.
- `lib/socket.ts:437`: asynchronous `on(event, handler)` returns cleanup; `:448` `emit(event, data)` resolves after local emission, not remote acknowledgement. Do not present local enqueue success as durable server acceptance.
- `lib/socket.ts:458`: joined rooms survive reconnect. `:468` reference counts prevent one screen's leave from ejecting another consumer. Keep these semantics on CC-Wire.
- `lib/socket.ts:203`: transport connection and application `ready` are distinct. New ready event must mean authenticated/subscription-capable session, not QUIC socket open.
- `lib/socket.ts:241`: disconnect/error/reconnect events drive connection banners and recovery. `connect` callbacks in chats/viewers/calls need to fire after a new authenticated session.
- `lib/socket.ts:251`: authentication-shaped failure refreshes token once. Preserve terminal logout and avoid unbounded auth-refresh loops.
- `lib/socket.ts:305`: network changes and foreground recovery coalesce connection resets; cleanup on logout must cancel old work and prevent cross-account replay.
- Dynamic `emit(event, data)` exists in VaultBeam and event constants exist in trips/runs. A literal-only grep cannot establish complete parity; inspect those helpers.
- No production use of `emitWithAck`, `.volatile`, or Socket.IO `.timeout(...)` was found in the searched frontend directories. Existing feature retries use their own events/timers. A facade need not copy unused Socket.IO features.

## Connections outside Socket.IO

- `lib/gamesSocket.ts:215` constructs a raw WebSocket for game tables; `lib/games/useQuickMatch.ts:74` constructs another for matchmaking `/live/ws`. These are not Socket.IO consumers. Moving them to CC-Wire requires server-side game protocol/session routing and independent tests, not deleting a library import.
- LiveKit call media (`lib/call/room.ts:468`) and isolated broadcasting (`lib/golive/room.ts:449`) own media connections. Preserve those media/security/server boundaries.
- VaultBeam direct/LAN transfer owns data paths; migrate signalling without routing large file bytes through the bounded chat control queue.
- Push wakes, HTTP sync, uploads and downloads are independent. One shared realtime connection is not one total network connection.

## Missing app parity and safe gates

1. **Inbound bridge:** every event above needs a CC-Wire frame-to-domain-event route, preserving payload shape/IDs/encrypted blobs. Generic compatibility envelopes may preserve behavior temporarily, but JSON bytes inside a protobuf envelope must not be advertised as full typed-protobuf bandwidth optimization.
2. **Server coverage:** every event emitted by REST/background services must fan out to CC-Wire sessions too, including mixed old/new clients. Bidirectional command handlers must reuse authorization and membership checks; never accept sender identity from client payload.
3. **Subscription parity:** chat refcounts, call joins, channels, and run-specific authorization need reconnect restoration. Joining all rooms indiscriminately is not equivalent.
4. **Lifecycle:** bounded dial deadline; one active carrier; WSS fallback; token refresh; logout cancellation; stable listeners; state transitions; reconnect sync.
5. **Recovery:** keep authoritative delta sync and durable receipts/outbox. Missed ephemeral typing/presence is discarded; missed durable updates are reconciled. Blue receipts stay gated on active focused visible chat.
6. **Memory:** queue limits must cap bytes as well as item count. Remove duplicate connection only after parity. Do not queue indefinite typing/ICE/location work during long offline intervals.
7. **Compatibility:** capability negotiation must prevent switching to exclusive CC-Wire on an older backend that lacks event support. Unsupported capabilities must select a known working mode before user operations are lost.
8. **Testing:** per-event schema/dispatch tests, feature regression tests, mixed clients, reconnect/logout/auth expiry, server restart, blocked UDP, app background and cold sync. Two-device receipts must establish grey before chat opening and blue after viewing.
9. **Measurements:** same workload baseline/candidate Android PSS, native/JS memory, connection count, idle wakeups, send latency and cold start. No RAM savings claim from architecture alone.
10. **Removal:** remove Socket.IO dependency only when source consumers route through the validated facade and the backend supports all required events. Old-client server support is a separate deployment decision.

## Audit method and limits

Read `AGENTS.md` and `openspec/config.yaml`; searched source under app/lib/services/components/hooks for socket imports (including require/dynamic import), on/off/emit patterns, lifecycle properties, and constants. This is a frontend migration inventory, not a backend authorization audit, an implementation, or a claim that every legacy route is exercised by current users. Backend and physical-device coverage must be recorded separately.
