# Calls — the plan to make VaultChat calls production-grade

Written 2026-08-16 after a day of on-device testing, then **revised** the same day
when the owner proposed a better architecture than the one first written here.

The owner's position is the premise: **VaultChat cannot ship with calls as they
are.** That is correct.

---

## The decision

> **LiveKit SFU for ALL calls — 1:1 and group. coturn kept for VaultBeam
> file transfer only. Mesh retired.**

This replaces the original plan (keep P2P mesh for 1:1, SFU only past 5
participants). It is better, and the reason is below.

### Why the E2EE objection does not apply

The obvious argument against an SFU is that it terminates SRTP, so the server sees
media — unacceptable for this product. **That is not true here.** The installed SDK
ships per-frame encryption for React Native:

```
@livekit/react-native 2.12.0
  src/e2ee/RNE2EEManager
  src/e2ee/RNKeyProvider
```

Frames are encrypted before they reach the SFU, which forwards bytes it cannot
read — the same guarantee the mesh gives today. This was the one fact that could
have killed the design; it was checked, not assumed.

The frame key is distributed over the EXISTING E2EE channel. `sendMediaKey(to,
chatId, sealed)` in `lib/call/signal.ts` already does exactly this and is reused —
no new trust, no new key agreement.

### What it buys

- **One code path.** Today's bugs cluster precisely where mesh and SFU logic meet.
- **No per-pair NAT traversal.** Every client dials one known server. This is the
  most likely cause of the 1–2 minute audio delay measured on device: ICE pair
  hunting across 7–14 relay candidates.
- **Group calls work at all.** Mesh dies past ~5 — each phone runs N-1 peer
  connections and N-1 outbound encodes.
- **Rooms give join/leave semantics**, which is what hold and call-waiting need.
  This removes the separate multi-session engine refactor from the plan.

### What it costs — stated plainly

- **Bandwidth.** Every call traverses the server, not just relayed ones. Roughly
  40% relay today, so this is a real increase. Capacity/cost model before building
  (already an open task in `calls-sfu-platform`).
- **Key management is ours.** The SFU cannot help distribute frame keys. The
  existing sealed-key path carries it.
- **It does not fix the call MODEL.** Ghost rings, hold and the lock-screen ring
  live in signalling and OS integration, not transport.

---

## Status — 2026-08-16, second session

**Step 2 is written and compiles; it has NOT been on a device yet.** Every call —
1:1 and group — now joins a LiveKit room instead of negotiating peer-to-peer:

- `startOutgoing` / `acceptIncoming` join the room. The sealed offer still rings
  (it is the doorbell and it establishes the signalling cipher); no mesh answer
  is ever sent, so the peer connection never negotiates and is closed once the
  room is up. Its cipher stays — in-call chat, reactions and screen-share
  notices ride it.
- **1:1 media key is minted by the ANSWERING side.** The lowest-uid rule was
  wrong here: the caller mints while the callee is still ringing and not yet
  listening, so the key was sent to a device that could not receive it. The
  caller now waits for that key, and its arrival doubles as "they answered" —
  so nobody publishes into an empty room during the ring.
- **Frame E2EE was inert.** `enableFrameCrypto` attached cryptors by walking
  `getSenders()` at join time, before anything was published, and only on the
  publisher connection. Zero cryptors attached → `active` false → every SFU
  call would have been refused; and remote frames, which arrive on LiveKit's
  SEPARATE subscriber connection, were never covered at all. It now attaches on
  every publish and every subscribe, across both transports, and refuses to
  publish if nothing attached.
- Tracks are published from the capture the engine already owns — a second
  capture fails on Android and would leave the mute/camera controls pointing at
  a track nobody is sending. Screen share swaps the published track; hold
  silences the room.
- **`callerIdentity` was the "VaultChat user" bug.** It read `users.name`, which
  is NULL for every vault-onboarded account, so the FCM ring and the LiveKit
  token both carried the literal fallback. Names now resolve through
  `vault.IdentityFromRow`, like every other screen. Same for the call roster.
  The `namecols_test.go` guard now covers both call files.

Still open: ConnectionService/CallKit (step 3), server-authoritative ring state
(step 1), and retiring the mesh entry points (step 4).

## Work, in dependency order

### 1. Server-authoritative call state — ~2 days
One row per call: `ringing | answered | ended`, server as arbiter. Ringing stops
because the SERVER stops it, not because a client stopped asking.

Fixes: the ghost second ring after hanging up (the caller re-emits 9× over 27s and
the callee's hangup does not stop the loop), "call not triggered", and most
disconnect-before-connect races. **Do this first** — everything else is easier once
both devices agree what state a call is in.

### 2. LiveKit for all calls, with RNKeyProvider E2EE — ~4–5 days
Replace the mesh path in `lib/call/engine.ts`. Room per call. Frame key sealed and
delivered over the existing E2EE channel.

Subsumes the multi-session engine refactor: `let session: Session | null` (one
module-wide session, the reason hold cannot work today) becomes room membership.

### 3. ConnectionService (Android) / CallKit (iOS) — ~3–5 days
Register as a calling app. The OS then owns the ring UI, lock screen, audio focus
and cellular interop — and grants full-screen intent without a prompt
(`FSI_REQUESTED_BUT_DENIED` was measured on device).

`CALLS_README.md` records that `react-native-callkeep` was rejected over peer-dep
conflicts. **Revisit that** — hand-rolling this layer is what the remaining bugs
are made of.

### 4. Retire mesh; coturn → VaultBeam only — ~1 day

**Total ≈ 10–13 days**, landing as one coherent piece. Symptom-by-symptom patching
is what failed on 2026-08-15/16: ~25 builds, six genuine fixes, and two occasions
where a fix caused a worse fault than it cured.

---

## Not architectural — fix regardless

- **`users.name` is EMPTY for all six accounts.** That is why "VaultChat user"
  survived three rounds of display fixes: there is no name to render. Profile setup
  does not persist it. Upstream of every call screen.
- **PiP lives in the GENERATED manifest.** `expo prebuild` drops
  `supportsPictureInPicture` and PiP dies silently. Move it into
  `plugins/withVaultChatCalls.js`.
- **Duplicate iptables REDIRECT** for udp/443 → 3478 (rule appears twice).
  Harmless, untidy.

---

## Verified WORKING on device (2026-08-16, both phones, build 066eed69)

- Audio on a cross-network call (mobile data ↔ WiFi) — **after** fixing
  `setForceSpeakerphoneOn(false)` → `null`; `false` forces the route and fought
  `auto: true`. **Delay of 1–2 minutes before audio is audible remains UNDIAGNOSED.**
- Notification tap-storm → one ring screen
- Back on a live call → PiP; back on a non-connected call → hangs up and leaves
  (the first version trapped the user with no exit but killing the app)
- Clean teardown, no stuck notification; ring-out → missed call
- One notification per call, with avatar
- TURN healthy: 3478/5349/443 reachable, valid `turn.corefinite.com` cert, and the
  udp/443 → 3478 redirect DOES exist (an earlier claim that it did not was wrong)
- Cross-network media reaches `local: relay  remote: relay (via TURN relay)`

**The transport is sound. What is missing is the call model on top of it.**
