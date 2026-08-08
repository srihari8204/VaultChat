# VaultChat Calls — SFU Platform Design

Final architecture for group calls, webinars, screen share, recording and streaming.
The phased task list is in `tasks.md`.

Baseline for every "today" claim: `lib/call/*`, `internal/routes/call_sessions.go`,
`internal/realtime/handlers.go`, `CALLS_README.md`.

---

## 1. Decisions that must be made before Phase 1

These are not preferences. Each one changes what gets built.

### D-1. E2EE vs SFU — **DECIDED 2026-08-08: Option C (split)**

> **1:1 calls stay end-to-end encrypted. Group calls are transport-encrypted
> (DTLS/SRTP) through the SFU. Recording is not required for 1:1.**

Consequences, now settled:

- 1:1 keeps the existing mesh + `callCrypto` path, unchanged. It is never routed
  to the SFU, so its E2EE guarantee is not weakened by any of this work.
- Group calls, webinars, recording and RTMP streaming are all **unblocked** —
  the server can decrypt group media, so Egress can encode it.
- **1:1 calls are not recordable, and that is by design**, not a limitation to
  be fixed later. Adding 1:1 recording would require breaking 1:1 E2EE.
- **Recording is BROADCAST-ONLY** (owner, 2026-08-08). It exists to serve
  webinars and live streaming — not ordinary group calls, and not 1:1. This
  narrows Phase 4 considerably: Egress is provisioned for the webinar path
  alone, so its capacity model is "concurrent broadcasts", not "concurrent
  calls", which is a far smaller and more predictable number.
- **UI obligation**: the call screen must state which protection is in force.
  A user who believes a 12-person call carries the same guarantee as their 1:1
  has been misled by omission. The existing "End-to-end encrypted" label must
  become conditional on call type, not shown unconditionally.
- Frame-level E2EE for group calls (Option A) is not pursued. If it is ever
  revisited, recording and streaming must be removed in the same change.

Original analysis retained below for the record.

---

#### Analysis as written before the decision

Mesh calls today are peer-to-peer with a per-call key ratchet-wrapped once, then
AES-256-GCM per frame (`lib/callCrypto.ts`). **An SFU relays media through our servers.**
Without frame-level encryption, VaultChat's infrastructure can see and record every group
call — in an application that ships a duress vault, sealed attachments and E2EE messaging.

| Option | Group calls | Recording | RTMP streaming | Claim we can make |
|---|---|---|---|---|
| **A. Frame E2EE** (insertable streams) | ✅ | ❌ impossible | ❌ impossible | "E2EE everywhere" |
| **B. Transport only** (DTLS/SRTP) | ✅ | ✅ | ✅ | "encrypted in transit" for groups |
| **C. Split** | 1:1 E2EE, group transport-only | ✅ groups | ✅ groups | Honest, needs clear UI |

**A server cannot record what it cannot decrypt.** Options A and (recording + streaming)
are mutually exclusive — no engineering removes that.

Option A additionally needs a React Native prototype before it can be committed to:
LiveKit supports insertable-stream E2EE, but RN support is the open question and must be
proven, not assumed.

Recommendation: **C**, with group calls labelled in the call UI rather than in a
support article. Deciding at Phase 4 instead of now means rebuilding Phases 1–3.

**→ Adopted. See the decision recorded at the top of D-1.**

### D-2. What "1000+ voice calls" means

- **1000 concurrent 1:1 calls** — a capacity question. ~2000 participants, perhaps 30%
  needing TURN relay, audio at ~40 kbps ≈ **12 Mbps of coturn**. Close to free with what
  exists today.
- **1000 participants in one voice room** — the webinar/stage model. Only 3–5 unmuted
  speakers are ever forwarded, so 1000 subscribers is a bandwidth and connection-count
  problem, not a CPU one.

The product doc implies the second. They are different builds; confirm which.

### D-3. App size

Target is 25–40 MB. The current release APK is **105 MB before the LiveKit SDK**, which
only grows it. This is not reachable by trimming call code — it needs an audit of assets,
fonts, the AI modules and native dependencies, plus **ABI splits or an AAB** (arm64-only
already removes ~35%). Track it as its own workstream; do not let it ride on this change.

---

## 2. Media routing

```
≤ MESH_MAX_PARTICIPANTS (5)     → mesh, peer-to-peer      (unchanged)
>  MESH_MAX_PARTICIPANTS        → LiveKit SFU
webinar (any size)              → LiveKit SFU, role-scoped
```

Keeping small calls on mesh is deliberate: P2P is lower latency and costs no server media.
The `WireMode` type in `lib/call/signal.ts` already models "which wire shape does this
call speak", which is where the second mode attaches. `1:1 is a mesh with N=1` stays true.

Mode is decided **server-side at call creation**, not by the client, so a client cannot
opt itself into the SFU to escape a role restriction.

## 3. Why 64 works with an SFU and not with mesh

| | Mesh, 64 | SFU, 64 |
|---|---|---|
| Uploads per device | 63 encodes | **1** (+ simulcast layers) |
| Downloads per device | 63 | **only what is rendered** (~9–16 tiles) |
| Server media cost | none | forwards ~64 up, ~700 down per room |

Nobody renders 64 live videos on a phone; Zoom does not either. The deliverable is "64
participants, 9–16 visible tiles, active-speaker audio", and that must be stated in the
spec so it is not mistaken for 64 simultaneous video renders.

**Simulcast is device-tier dependent**: 3 layers (240/480/720) on capable hardware, **2 on
low-end Android**. Encoding three layers on a budget device is a thermal problem, not a
configuration choice.

## 4. Webinar

Audience scale comes from asymmetry, not capacity: an audience member subscribes and never
publishes. The enforcement already exists and is the strong kind — `sfu-token` mints
`canPublish=false` with an empty publish-source list, read fresh from `call_participants`
on every mint, short TTL, so a participant demoted a second ago cannot present a token
minted while they were a speaker.

Raise-hand, promote/demote, `call_chat` and `call_emoji` are already implemented.

## 5. Screen share

The track swap exists (`engine.ts` holds `screenStream` and `cameraTrack`). What is missing
is intent: **sharpness and smoothness are opposing goals**, so the content type must drive
the encoder.

| Content | Profile |
|---|---|
| Documents, code, slides | 1080p @ 5–15 fps, `contentHint: 'detail'` |
| Video, gameplay | 720p @ 30 fps, `contentHint: 'motion'` |

Hardware H.264 where the device exposes it; VP8/VP9 fallback.

## 6. Recording and streaming

Both are **LiveKit Egress**, a separate server component that **transcodes** — unlike the
SFU, which only forwards. Egress is the expensive part of this entire architecture and
needs its own machines and its own capacity model. Output lands in the existing S3/MinIO.

Note: `app/call-recording.tsx` today is **local audio recording** (expo-av +
AsyncStorage). It is not call recording and does not become it; cloud recording is new
work gated on D-1.

## 7. Latency

Target is <300 ms. An SFU adds a hop, so this is a **placement** problem: a single-region
SFU cannot deliver <300 ms to distant users regardless of tuning. Either deploy LiveKit
per region, or state the target as regional and accept 400 ms+ outside it.

## 8. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| D-1 deferred | Phases 4–5 rebuilt | Decide before Phase 1 |
| Two unvalidated call systems at once | Cannot attribute a regression | Phase 0 validates mesh on hardware first |
| Simulcast on low-end Android | Thermal throttling | Device-tier layer policy |
| Guest mode ("join without login") | Conflicts with the identity/key model — a guest has no keys | Separate design; not in this change |
| Egress cost underestimated | Recording/streaming unaffordable at scale | Model it before Phase 4, not during |
| Single-region SFU | <300 ms target missed | Regional deployment or restated target |

## 9. What this change does not do

- Does not raise `MESH_MAX_PARTICIPANTS`. Mesh stays at 5 by design.
- Does not change 1:1 calls. They remain P2P and E2EE.
- Does not add guest/anonymous join.
- Does not solve app size (D-3 is tracked separately).
