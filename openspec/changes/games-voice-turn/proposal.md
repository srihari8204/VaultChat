## Why

Table voice in all four games negotiates P2P audio using **only** the games
server's ICE list, and that list is STUN-only. Verified live on 2026-09-06:

```
GET https://games.corefinite.com/config.js  → 200
window.GAMES_CONFIG = {"dev":false,"iceServers":[{"urls":"stun:stun.l.google.com:19302"}],"sfu":false,"sfuMinSeats":4}
```

STUN alone cannot traverse symmetric NAT or carrier CGNAT, which is the normal
case for two phones on mobile data. There is no relay candidate to fall back on,
so the peer connection simply never completes and the voice bar sits on
"waiting" forever with no error.

VaultChat **already owns a TURN server** and already has the cached helper that
mints credentials for it — `getIceServers()` in `lib/iceConfig.ts`, used by
1:1/group calls (`lib/call/room.ts`) and by Go Live (`lib/golive/room.ts`).
Game voice is the only WebRTC path in the app that does not use it.

This matters more, not less, as tables fill up. Voice is meant to work for a
**6-seat rummy table and a 4-seat ludo table**; the mesh is full, so a 6-seat
table is 5 peer connections per phone and 15 across the table. With no relay,
the chance that *at least one* of those five fails approaches certainty, and a
single dead leg is what a player experiences as "voice is broken".

`"sfu": false` means the mesh is the only transport available — there is no
server-side mixing to fall back to, and we do not own the games server's source.

## What Changes

- `useTableVoice` builds its ICE list from **both** sources: VaultChat's
  `getIceServers()` (STUN + TURN, credentialed) merged with whatever
  `games.corefinite.com/config.js` publishes, instead of `config.js` alone.
- The games server's list stays in the merge rather than being replaced, so if
  that deployment ever adds its own TURN we use it too.
- A relay candidate is available on every table, for every one of the four
  games, because all four already share this one hook.
- Add a wiring selftest asserting game voice reads `getIceServers`, mirroring
  the existing `lib/golive/turnWiring.selftest.ts` that pins the same rule for
  Go Live.
- Add a mesh selftest at **6 peers (rummy) and 4 peers (ludo)** proving every
  pair has exactly one initiator and no player is left undialled.

## Capabilities

### New Capabilities

_None._ This corrects the transport of an existing capability.

### Modified Capabilities

- `mini-games`: table voice MUST offer a relay (TURN) candidate, and MUST mesh
  every non-bot seat at a table of up to 6 (rummy) / 4 (ludo).

## Impact

**Code**
- `lib/games/useTableVoice.ts` — ICE list construction (the only functional edit).
- `lib/games/voiceMesh.selftest.ts` — 6- and 4-peer mesh coverage.
- `lib/games/turnWiring.selftest.ts` — new, structural.

**Systems**
- Adds game voice as a consumer of the existing coturn deployment. The relay
  only carries audio for tables that cannot go direct, but this is net-new
  bandwidth on that server, so it is a capacity note not a free change.
- No games-server change, no migration, no Go deploy, no new dependency.

**Blast radius**
- All four games share `useTableVoice`, so one edit fixes and risks all four
  equally. Gameplay itself is untouched — the game socket is a separate path.

## Not building

- **No SFU for game tables.** `config.js` reports `sfu:false` and we do not own
  that server's source; `sfuMinSeats:4` hints it was designed for one, but we
  cannot deploy it. Mesh stays.
- **No cap on mesh size.** 6 is the largest table the games offer; that is 5
  connections per device, which is within what the app already does elsewhere.
  If a bigger table ever appears, revisit — do not pre-build for it.
- **No change to the voice UI, controls, or the mic-opens-late behaviour.**
  Capture engaging only once a PeerConnection needs it is correct WebRTC
  behaviour, not a defect.
- **No retry/ICE-restart logic.** Get the relay in first and measure; a restart
  loop layered on a connection that never had a relay would just hide the cause.
