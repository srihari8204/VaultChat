# Implementation plan — VaultChat Calls SFU platform

**Status: NOT APPROVED for implementation.** Three decisions in `design.md` §1 are open
(D-1 E2EE model, D-2 what "1000+ voice" means, D-3 app size). D-1 in particular determines
whether Phases 4–5 can exist, so building Phase 1 before it is answered risks rework.

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

- [ ] Provision LiveKit properly: host networking, TURN, real certificates, API keys
- [ ] Add the LiveKit client SDK (`@livekit/react-native` + `livekit-client`)
- [ ] Client redeems `POST /calls/{id}/sfu-token`; handle the 503-without-keys path by
      staying on mesh rather than failing the call
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

## Phase 4 — Recording *(blocked on D-1: impossible under frame E2EE)*

- [ ] Deploy LiveKit Egress on **separate machines** (it transcodes; the SFU does not)
- [ ] Capacity + cost model **before** building
- [ ] Output to existing S3/MinIO; retention policy
- [ ] Consent/notification UX — participants must know a call is recorded

## Phase 5 — Live streaming (RTMP → YouTube) *(blocked on D-1)*

- [ ] RTMP egress path
- [ ] YouTube Live key handling (a credential — never in client storage)
- [ ] Local stream recording

## Phase 6 — Voice-only / low-data mode

Independent of everything above; **can be pulled forward**, and has the highest value per
unit of work for the India-focused user base.

- [ ] Opus 16–24 kbps adaptive
- [ ] Audio-priority degradation (drop video, keep audio) — partly in `lib/call/quality.ts`
- [ ] Low-data toggle in call settings

---

## Cross-cutting

- [ ] Multi-region SFU, or restate the <300 ms target as regional (`design.md` §7)
- [ ] `call_mesh_full` metric already exists — use it as the evidence trail for SFU demand
- [ ] Keep the legacy mesh path until SFU passes the OEM matrix; rollback is one constant
