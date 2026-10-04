# Family location: sealing the upload, or opting out of server retention

**Status: design note, 2026-10-04 (round 4). Nothing here is built.** It needs a
product decision (fix_status §5) before any code. Written because the open item
"a design for sealing the location-store upload, or an opt-out of server
retention" cannot be closed by code alone.

## What happens today (verified in the code)

- The app publishes each fix twice: the sealed E2EE relay (`live_location_update`,
  the server cannot read it) **and** `POST /chats/{id}/locations`
  (`vaultchat-backend-go/internal/routes/spaces_locations.go`), which stores
  **plaintext** lat/lng/accuracy/speed/heading/battery per point in
  `space_locations` (migration 103, an owner-directed reversal on 2026-08-14).
- Reads are gated in SQL per space type. For a **family** space every active
  member sees every active member (`locCanSee`).
- `POST /locations/stop` stops new uploads, but **nothing is deleted**: the
  history and last-known point stay (`spaces_locations.go:334`).
- **No sweep deletes `space_locations`.** Migration 103 says "retention is a
  sweep", but no job in `internal/jobs` runs one, so every family member's
  movement history is kept indefinitely.
- What the server does with the stored plaintext for a family space: it serves
  `/locations/latest` and `/locations/history` to members (the family rule is
  plain membership). Road distances come from the client calling `/nav/*` with
  (coarse) positions it already holds, and attendance is derived on device.
  So **the family read path only relays positions between members**; for
  school/office/transport, the ops map, run drivers and run-delay checks build
  on the same store (to be re-checked before C, below, is extended past family).

## Options

| | A. Retention sweep only | B. Per-member "don't keep my history" | C. Seal family uploads |
|---|---|---|---|
| Change | Job deleting `space_locations` rows older than N days (same shape as `sweepScreenUsage`) | Member flag (migration); ingest updates only the latest point, never history rows; `stop` also deletes own history | Client encrypts each point with the space's sender key (the chat E2EE keys); server stores `{ts, ciphertext}`; reads return blobs |
| Server can read positions | yes, last N days | latest only, for opted-out members | never (family); unchanged for other types |
| Lost | history older than N days | that member's history (for everyone) | server-side point validation (`locValidPoint` speed/age), any future server feature on family positions; new members cannot read history sealed before they joined unless keys are re-shared |
| Size | ~20 lines + test | migration + ~60 lines + app toggle | new ingest/read shape, app crypto, key rotation on member change; days |
| Risk | low | low | medium (key distribution, the relay already proves the crypto) |

## Recommendation

1. **Do A now regardless** of B/C: an unbounded history of where every family
   member has been is the largest stored-privacy exposure in the product, and no
   feature needs more than a short window. Suggested N = 30 days for family,
   decided per space type (product).
2. Then **C for the family type only**: it is the one type where the server
   needs nothing it would lose, and it restores the pre-2026-08-14 promise for
   the most sensitive data. Keep B as the cheaper fallback if C is not staffed.

## Decisions needed (product)

- Retention window per space type (A).
- Whether family positions may be server-readable at all (C) — this re-reverses
  the 2026-08-14 directive for family spaces only.
- Whether "stop sharing" should also delete the stored history (today it does not).

## Not decided here / not built

No migration, no job, no endpoint. When a choice is made, the work is a normal
OpenSpec change (`openspec-propose`), naming the migration number and the files
to copy to prod.
