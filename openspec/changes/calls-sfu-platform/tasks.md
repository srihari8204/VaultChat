# Implementation plan — VaultChat Calls SFU platform

**Status: PARTIALLY APPROVED.**

- **D-1 (E2EE model) — DECIDED**: Option C. 1:1 stays E2EE and is never routed to the SFU;
  group calls are transport-encrypted; 1:1 recording is explicitly out of scope. Phases 1–5
  are unblocked on this axis.
- **D-2 (what "1000+ voice calls" means) — OPEN**: affects capacity planning for Phase 2,
  not its design. Does not block Phase 1.
- **D-3 (app size, 105 MB vs 25–40 MB target) — OPEN**: tracked separately; should be
  answered before the LiveKit SDK is added.
  *(2026-08-10: overtaken by events — the SDK is in and release builds are arm64-only at
  ~83.5 MB, which is the de-facto ABI-split answer. Revisit only if universal APKs return.)*

---

**Reconciliation, 2026-08-10.** Several items below were completed outside this change's
bookkeeping, during the calls-reliability work (branch `calls/reliability-and-broadcast`).
Evidence per item is annotated inline. Two findings that reshape the plan:

1. **The broadcast pipeline was built without waiting for this change** — migrations
   079–082 (`broadcast_sessions` + social tables), `internal/routes/broadcasts.go`,
   `internal/livekit/egress.go`, per-host `bc_<uid>` rooms. It deliberately routes AROUND
   `CALL_SESSIONS` (still `false`), so Phase 0's flag-enable is a prerequisite for SFU
   *group calls*, not for broadcast. The two paths must not be conflated when Phase 1 lands.
2. **Server versions moved**: livekit-server v1.8.4 → v1.13.5, egress → v1.14.0 (its own
   release line — tags do NOT track the server's). `/rtc/v1` now answers 401; the client
   SDK's connection blocker is gone. First room creation observed 2026-08-10 18:44
   (`RM_E7pUmUd53q6J`). Egress → playable HLS remains UNPROVEN — that five-step chain
   (egress → MinIO objects → Content-Type → Cloudflare segment-caching → playlist
   freshness) is the narrow remaining gap, tracked as its own follow-up.

**Phase 0 still gates Phase 1** — the mesh engine must pass hardware before a second media
path is introduced.

- [x] **Phase 6 — voice-only / low-data mode. DONE** (commit `d3191fa`): audio-priority
      `audioOnly` tier, low-data ceiling, Opus 16–24 kbps. Taken first because it is
      independent of every decision above.

Strangler order, behind a `CALLS_SFU` flag (`constants/flags.ts`, default **off**), matching
the pattern used by `VB_SEAMLESS_RESUME` and `CALL_ENGINE_V2`. Phases 1+ change nothing
with the flag off; rollback at any point is one constant.

---

## Phase 0 — Validate and enable what already exists (prerequisite)

Nothing below is safe to build on an unvalidated base.

- [ ] Run the **OEM matrix** from `CALLS_README.md` against `CALL_ENGINE_V2` (currently
      `true`, never tested on hardware): background audio, ring while KILLED, lock-screen
      ring on MIUI / ColorOS / Vivo / Honor / Samsung / stock
- [ ] Include a **3-person group call** — `group-call-active.tsx` had the thinnest legacy
      implementation, so the engine flip carries the most risk there
- [ ] Enable **`CALL_SESSIONS`** (`constants/flags.ts:172`) and verify the session, role
      and history paths end to end. **SFU roles cannot be authoritative without it**
- [ ] Decide D-3 (ABI splits / AAB) before adding an SDK to a 105 MB APK

**Gate:** mesh calls pass on hardware; `CALL_SESSIONS` on in staging with no history
regression.

## Phase 1 — SFU media routing (core)

- [x] Provision LiveKit properly: host networking, TURN, real certificates, API keys
      *(2026-08-10: v1.13.5 live behind nginx at `wss://api.corefinite.com/livekit`,
      real certs, `/rtc/v1` → 401. Caveat: `use_external_ip: false` + hardcoded IPv4
      `node_ip` predate the upgrade; `turn.enabled: false` — calls ride our coturn.)*
- [x] Add the LiveKit client SDK (`@livekit/react-native` + `livekit-client`)
      *(client 2.19.2 / rn 2.12.0 / webrtc 144.1.2, pinned via npm overrides,
      drift-guarded by `scripts/check-sdk-versions.js` — which checks the three client
      packages against each other but NOT against the server; that gap hid the
      v1.8.4/2.19.2 mismatch for the feature's whole life.)*
- [x] Client redeems `POST /calls/{id}/sfu-token`; handle the 503-without-keys path by
      staying on mesh rather than failing the call
      *(`lib/call/sfuToken.ts` — throws `SfuUnavailable`, callers fall back to mesh.)*
- [ ] Add the SFU `WireMode` in `lib/call/signal.ts`; **server decides the mode at call
      creation**, never the client
- [ ] Publish one stream; **selective subscription** to visible tiles + active-speaker audio
- [ ] Device-tier simulcast policy (3 layers capable / 2 low-end)
- [ ] Raise the effective group ceiling to 64 **for SFU calls only**; mesh stays at 5

**Gate:** a 64-participant call with 9–16 rendered tiles, on real devices including one
budget Android, without thermal collapse.

## Phase 2 — Webinar (host + 1000 audience)

Cheapest phase — the permission model exists.

- [ ] Audience join path: subscribe-only, no publish
- [ ] Verify the SFU **refuses** an audience publish attempt (the guarantee, not the UI)
- [ ] Wire raise-hand → promote to speaker to the existing endpoints
- [ ] Surface `call_chat` / `call_emoji` in webinar UI
- [ ] Load-test 1000 subscribers with 3–5 active speakers

**Gate:** a demoted speaker cannot publish with a token minted while they were a speaker.

## Phase 3 — Screen share quality

- [ ] Content-hint driven profiles (`detail` for documents, `motion` for video)
- [ ] 1080p @ 5–15 fps vs 720p @ 30 fps selection
- [ ] Hardware H.264 where exposed, VP8/VP9 fallback
- [ ] Verify on a mid-range device that text stays legible at 1080p

## Phase 4 — Recording *(unblocked by D-1 Option C — BROADCAST ONLY)*

Scope narrowed by the owner 2026-08-08: recording serves **webinars and live streams
only**. Not 1:1, and not ordinary group calls.

- [ ] **1:1 calls are NOT recordable** — assert this in code, not just docs, so a later
      change cannot quietly route a 1:1 through Egress
- [ ] Gate Egress on the call being a BROADCAST, so an ordinary group call cannot be
      recorded either — capacity is then "concurrent broadcasts", a much smaller number

- [~] Deploy LiveKit Egress on **separate machines** (it transcodes; the SFU does not)
      *(2026-08-10: deployed and running — v1.14.0 — but on the SAME host as the SFU.
      Fine for current scale (5 users); the separate-machine requirement stands for the
      1000-viewer target. Partial, deliberately.)*
- [ ] Capacity + cost model **before** building
- [~] Output to existing S3/MinIO; retention policy
      *(pipeline exists: egress → HLS → MinIO → Caddy → nginx → Cloudflare, with
      `cf-cache-status: HIT` observed on the single rendition. No retention policy yet,
      and end-to-end playback of a live broadcast is still unproven. No ABR ladder.)*
- [ ] Consent/notification UX — participants must know a call is recorded

## Phase 5 — Live streaming (RTMP → YouTube) *(unblocked by D-1 Option C)*

- [ ] RTMP egress path
- [ ] YouTube Live key handling (a credential — never in client storage)
- [ ] Local stream recording

## Phase 6 — Voice-only / low-data mode — ✅ DONE (`d3191fa`)

- [x] Opus 16–24 kbps adaptive (`audioBitrate`)
- [x] Audio-priority degradation — `audioOnly` tier below `low`; video is suspended via
      `track.enabled=false`, so recovery needs no renegotiation
- [x] Low-data toggle in call settings (`lib/callPrefs.ts`, Call reliability screen)
- [x] 14 new policy checks in `lib/call/quality.selftest.ts`

---

## Cross-cutting

- [ ] Multi-region SFU, or restate the <300 ms target as regional (`design.md` §7)
- [ ] `call_mesh_full` metric already exists — use it as the evidence trail for SFU demand
- [ ] Keep the legacy mesh path until SFU passes the OEM matrix; rollback is one constant
