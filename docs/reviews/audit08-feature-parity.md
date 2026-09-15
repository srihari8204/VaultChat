# Audit 08: application event parity

No new transport-specific missing handler, acknowledgement contract or Socket.IO option was found in the reviewed production paths. A shared initial-handshake unsubscribe race was fixed after reporting it to the coordinator.

## Source trace

The server's `eventPeer` adapters feed both carriers into `registerChatHandlersPeer` and `registerSignalHandlersPeer`; the former also registers run relays. CC-Wire decodes one bounded object payload and invokes that exact callback. It does not maintain a competing event-name allowlist. The application facade supports the operations used by production consumers: `on`, `off`, `once`, `emit`, `connected`, connection lifecycle and cleanup. An AST-assisted scan of 29 socket-related production files found no three-argument emit callback, `emitWithAck`, `timeout`, `volatile`, `onAny` or `offAny` dependency. Dynamic event names and imported emit helpers were additionally traced in trip/run/location modules.

| Feature | Traced preservation |
| --- | --- |
| Calls and group calls | Offer/answer/ICE/end, rekey, incoming call, call media keys, screen-share events, call chat/emoji, join/leave and roster handlers use the shared authorized callbacks. Facade subscriptions remember call rooms. Sealed signalling payloads remain application-owned. |
| VaultBeam | Named offer/answer/ICE/end/pull/ready/tier/have relays remain registered. Peer data-channel payload transfer remains a separate media/data path. |
| Groups and chat | Chat membership authorization, join/leave, typing, reactions, channel join/leave and viewer requests use the shared callbacks. Named server responses such as viewer lists are forwarded generically. |
| Presence and family/location | Presence-change fanout reaches CC-Wire user sessions. Live location updates/stops, trip updates/ends, run subscriptions and encrypted blobs retain their shared membership/entitlement checks. Family and space server notifications use the same generic event reception. |
| Mutations and receipts | Edit/delete/read/delivery/pin/media-revoke and related server notifications flow through shared user/room fanout. Durable receipts remain owned by their HTTP/SQLite path; generic events deliberately have no semantic acknowledgement. |
| Stories, shop and other feature updates | User, room and broadcast emit helpers include both carriers, so server-originated named events do not require another adapter registration. Existing REST feature actions remain REST actions. |
| Games | `lib/games/useQuickMatch.ts` explicitly constructs the games raw WebSocket. This is a different service/protocol, not a forgotten Socket.IO consumer. Game invitations carried in messages still follow chat delivery. |
| LiveKit | Call/SFU and table voice sessions use the LiveKit room SDK and its media/signalling connection. They remain independently owned; this migration does not replace them. |

`eventPeer.To` excludes the originating CC-Wire session when relaying to its room. Socket.IO-originated room events also reach CC-Wire. Both disconnect paths send call peer-left events and clean their room/roster ownership. Normal CC-Wire reconnect and capability-removal rollback retain the facade reference; the previously fixed established-legacy recovery also retains its original object/listeners.

The admin console's special Socket.IO admin-room connection is separate from the authenticated mobile application flow; this audit does not claim to migrate that console.

## Executed checks

- `go test ./internal/realtime -run '^TestAppEvents' -count=1` — passed. Covers negotiation, shared authorization/identity rewriting and fanout, payload/queue bounds, subscriptions/revocation, presence across transport sessions, large payloads, slow-handler heartbeat isolation and disconnect cancellation.
- `node node_modules/tsx/dist/cli.mjs lib/call/signalFailClosed.selftest.ts` — passed; source/pure checks for retaining sealed signalling.
- `node node_modules/tsx/dist/cli.mjs lib/family/presenceLifecycle.selftest.ts` — passed; source lifecycle checks for sharing/background handoff.
- `node node_modules/tsx/dist/cli.mjs lib/chatListResync.selftest.ts` — passed; source wiring checks for reconnect/foreground catch-up.

`lib/ccwire/transport.selftest.ts` was also rerun with a new executable pending-candidate unsubscribe regression; it passed, including the prior reconnect/rollback/reference-preservation checks.

## Risks and verification limits

- Fixed shared listener-unsubscribe corner: a persistent listener removed after candidate construction but before initial readiness previously remained attached, because the global `socket` was still null. `applyPersistent` now retains its actual target so unsubscribe detaches from that candidate. Logout clears the target. The focused regression verifies attachment during pending readiness and no callback after unsubscribe, both before and after ready. This applies to legacy and CC-Wire construction through the same function.
- The facade intentionally drops ephemeral emissions while disconnected; it does not supply a generic offline queue or Socket.IO acknowledgement API. No reviewed current consumer relies on an omitted acknowledgement API. Durable work must continue through its existing persisted owner.
- The checks establish shared code routing and selected executable behavior, not every UI action on two real devices. Multi-device calls, GPS sharing, shop workflows and LiveKit/games media were not executed. No deployment or device verification is claimed.
