## Context

`lib/games/useTableVoice.ts` is the single voice hook behind all four games.
It builds its ICE list in one place — a `useRef` seeded with a hardcoded public
STUN server, overwritten once by a best-effort fetch of the games server's
`/config.js`:

```ts
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
...
const iceServers = useRef<any[]>(DEFAULT_ICE);
useEffect(() => {
  fetch(`${GAMES_HTTP}/config.js`)... 
    if (Array.isArray(cfg?.iceServers) && cfg.iceServers.length) iceServers.current = cfg.iceServers;
}, []);
```

and consumed in exactly one place:

```ts
const pc = new RTC.RTCPeerConnection({ iceServers: iceServers.current });
```

Measured on 2026-09-06, that fetch returns STUN only. So every game peer
connection is negotiated with no relay.

Meanwhile `lib/iceConfig.ts` already exists and already solves this for the
rest of the app. Its contract is a close fit for a mesh:

- `getIceServers()` **never throws and never returns empty** — it falls back to
  the last good config, then to STUN.
- **Concurrent callers share one in-flight request.** The docstring says it
  outright: "a mesh call bringing up several peer connections at once issues a
  single fetch, not one per peer." A 6-seat rummy table is precisely that.
- It caches on the credential's own expiry, and warns when the server returns
  no TURN — which surfaces a missing `TURN_SECRET` instead of hiding it.

Go Live had this same gap and closed it the same way; `lib/golive/turnWiring.selftest.ts`
exists to keep it closed. This change follows that precedent rather than
inventing a second one.

## Goals / Non-Goals

**Goals**
- A relay candidate is available to game table voice on all four games.
- Keep the games server's published ICE servers in play, not replaced.
- Prove the mesh dials correctly at rummy's 6 seats and ludo's 4.
- No regression when TURN is unreachable — voice still tries over STUN.

**Non-Goals**
- No SFU. `config.js` says `sfu:false` and the games server is distroless and
  not ours to change.
- No ICE-restart or reconnect logic. Land the relay, then measure.
- No change to the mesh protocol, the voice UI, or the game socket.
- No mesh size cap. 6 is the ceiling the games actually offer.

## Decisions

### Decision 1: Merge both lists, do not replace

`iceServers.current` becomes the union of `getIceServers()` and the games
server's list, deduped on the stringified `urls`.

**Why not replace with ours:** the games server is the authority on its own
deployment. If a TURN is ever configured there it should be used — dropping it
would be us deciding for a server we do not own.

**Why not keep theirs alone:** that is the bug.

**Why dedupe:** both lists start with the same public Google STUN. Passing a
duplicate is harmless to WebRTC but produces confusing candidate logs, and the
dedupe is one `Map` keyed on `JSON.stringify(urls)`.

### Decision 2: Both fetches stay best-effort, and independent

The existing `useEffect` gains a second source. Each source applies on its own:
whichever resolves, contributes. Neither can reject the other, and neither
blocks joining voice — the ref already holds a usable `DEFAULT_ICE` from the
first frame, and a player who joins voice before either resolves negotiates
with STUN exactly as today.

**Rejected — await both before allowing voice.** It would make a slow TURN
endpoint delay a feature that currently starts instantly, to protect against a
case (joining voice within the fetch window) that costs at most one retry.

### Decision 3: Prove the wiring structurally, not just the merge

A unit test on a merge function proves the merge and not that anything calls it.
This exact bug class is recorded in `vaultchat-mini-games-pro`: "a chain that is
written end to end and joined nowhere". So, mirroring
`lib/golive/turnWiring.selftest.ts`, a new `lib/games/turnWiring.selftest.ts`
greps `useTableVoice.ts` for the `getIceServers` import and its use inside the
ICE effect.

### Decision 4: Mesh coverage at 6 and 4 is a pure test

`shouldInitiate(you, peer)` is `you < peer` — a total order, so across any
roster every pair has exactly one initiator. That is already true for 6 and 4
seats and needs no code change; what is missing is the assertion. The new test
enumerates a 6-id and a 4-id roster and checks every pair has exactly one
initiator, no self-dial, and that bots are excluded by `rosterFrom`.

**This is a test-only addition — the mesh already scales.** Recording it here
because "does voice work for 6 players" was the question asked, and the honest
answer is "structurally yes, and here is the check that keeps it so".

## Risks / Trade-offs

**Relay bandwidth is net-new on coturn.** A 6-seat table that cannot go direct
relays 5 audio legs per player. Mitigation: relay is last-resort by ICE design —
direct still wins where it is available. This is a capacity note for the owner,
not a blocker, and it is the same server calls already use.

**A phone holding 5 peer connections is real load.** Untested at 6 seats; we
have never had 6 concurrent players. Audio-only connections are cheap next to
the video paths this app already runs, so this is a watch-item, not a redesign.

**Device verification is blocked, and this change cannot close it.** Two-way
game voice audio has never been verified on hardware: the Redmi refuses adb
input under MIUI and its account fails `409 User has no VaultID`, and the
emulator is signed out. This change makes voice *able* to connect; only two
real accounts on two phones can prove it *does*. Stated plainly rather than
implied by a green test suite.

## Migration Plan

Client-only. No migration, no Go deploy, no games-server change, no new
dependency. Ships in the next APK; older builds keep today's STUN-only
behaviour and are not broken by it.

## Open Questions

- Does coturn's current capacity comfortably absorb game-table relay traffic on
  top of calls and Go Live? Owner call — needs a look at the server, not a code
  change.
- `config.js` advertises `sfuMinSeats: 4`, implying the games server was
  designed to switch to an SFU at 4+ seats but has it disabled. Worth asking
  its operator whether it can be enabled; that would retire the mesh for
  exactly the 4- and 6-seat cases this change is about.
