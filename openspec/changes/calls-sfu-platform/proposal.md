## Why

VaultChat calls are **full mesh, capped at 5 participants**
(`vaultchat-backend-go/internal/realtime/handlers.go:361`, `MESH_MAX_PARTICIPANTS`).
The product target is **64-participant group calls plus 1000+ audience webinars**, which
mesh cannot reach — not slowly, but at all.

In a full mesh every participant holds a peer connection to every other, so each device
runs `N-1` connections and, decisively, `N-1` **outbound video encodes**:

| Participants | Connections per device | Outbound encodes |
|---|---|---|
| 5 (today) | 4 | 4 |
| 64 (target) | 63 | 63 |

The binding constraint is the encoder, not bandwidth. Raising `MESH_MAX_PARTICIPANTS`
produces a call that collapses around 8 people with thermal throttling — every
participant's video degrading at once rather than a clean refusal. The cap is correct for
the architecture; the architecture has to change.

**Most of the server side already exists and is switched off.** This change is
predominantly wiring, not building:

| Piece | State | Location |
|---|---|---|
| Role model `host · cohost · speaker · audience` | Built, DB-backed | migration 066, `lib/callSession.ts:26` |
| `POST /calls/{id}/sfu-token` — role-scoped LiveKit JWT | Built; 503 without keys | `internal/routes/call_sessions.go:58` |
| LiveKit config + compose service (`sfu` profile) | Built | `livekit/livekit.yaml`, `docker-compose.yml:302` |
| Mesh engine, ICE, quality tiers, screen-share track swap | Built | `lib/call/*` |
| **LiveKit client SDK** | **Absent** | — |
| **Any client call to `sfu-token`** | **Absent** | — |

The gap is one-sided: the server can mint credentials that nothing redeems. `sfu-token`
already reads the role fresh per mint and issues audience tokens with `canPublish=false`
and an empty publish-source list, so an audience member's camera is refused *by the media
server* rather than hidden by the UI. The webinar permission model is already the strong
kind — it was deliberately built before the SFU (see the comment at
`call_sessions.go:564`).

## What Changes

- **Dual-mode media routing.** Calls of ≤5 stay peer-to-peer mesh (lower latency, no
  server media cost); calls above the cap route to the LiveKit SFU. `WireMode` in
  `lib/call/signal.ts` is the existing seam.
- **LiveKit client SDK** added and wired to `sfu-token`.
- **Selective subscription + simulcast.** Publish one stream; subscribe to visible tiles
  plus active-speaker audio. This — not raw participant count — is what makes 64 work.
  Simulcast layer count becomes device-tier dependent.
- **Webinar mode** on the existing roles: audience is subscribe-only, raise-hand and
  promote already have endpoints, `call_chat` / `call_emoji` are already on the wire.
- **Screen-share tuning** (content hints, resolution/FPS profiles) on the existing
  track-swap plumbing.
- **Recording and RTMP streaming** via LiveKit Egress — *conditional on the E2EE decision
  below*.
- **Voice-only low-data mode** (Opus 16–24 kbps, audio-priority degradation).
- **`CALL_SESSIONS` must be enabled** (`constants/flags.ts:172`, currently `false`). The
  session/role/history layer is dormant, and SFU roles cannot be authoritative without it.

## Impact

- Affected specs: `calls-media-routing` (new)
- Affected code: `lib/call/*`, `app/voicecall.tsx`, `app/videocall.tsx`,
  `app/group-call-active.tsx`, `internal/routes/call_sessions.go`, `docker-compose.yml`,
  `constants/flags.ts`
- New infrastructure: LiveKit SFU nodes; **separate Egress nodes** for recording/streaming
  (Egress transcodes — it is the expensive component, not the SFU)
- **Three decisions block Phase 1 and are recorded in `design.md` §1.** The E2EE question
  determines whether recording and streaming can exist at all, so deferring it means
  rework in Phases 4–5, not just delay.
