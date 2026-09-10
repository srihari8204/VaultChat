# Tasks

> **Reconciled against shipped code (2026-09-10).** Family Space shipped ahead of
> this checklist — `app/family*.tsx`, `components/family/FamilyMap.tsx` and
> `lib/family/*` (10 modules) implement F1–F5. Each box below now carries the
> evidence that closed it, or the reason it is still open. Two boxes are closed
> as **resolved differently** and one as **N/A**; those are decisions, not work.
> F6 and F7 are genuinely unbuilt — no code exists for either.

## F1 — Circle foundation (client + relay)
- [x] 1.1 Circle create/join on top of groups, roles (member/guardian), invite-link reuse — `lib/family/circle.ts`. **Deviation:** a Circle rides an ordinary group (`createGroupChat`), not a `type='family'` discriminator; its id *is* the chat id. Roles map onto group roles (owner/admin → guardian, member → member), so no new server surface exists at all. `circleInviteCode()` reuses `createInviteLink` with `expiresInHours: 0, maxUses: 0`.
- [x] 1.2 `family-setup.tsx` (create/join + consent prompt) and mini-app registry entry — screen shipped; registry entry is `familyspace` in `app/(tabs)/mini.tsx`. Consent is threefold: the setup hero states the server never sees a location, `DEFAULT_FAMILY_SETTINGS.sharing` is `false`, and always-on location is a separate explicit prompt. **Deviation:** ships unflagged, not "flagged off".
- [x] 1.3 Membership/roles migration **N/A** — the task is conditional ("IFF groups schema doesn't cover it"). It does: `chat_members` already carries per-member `role` and `left_at`. No migration was written and none is needed.
- [x] 1.4 Presence publisher: sealed payload with battery/motion/speed; publish on the existing socket at an adaptive interval; default sharing OFF — `FamilyPing` carries `bat`/`chg`/`spd`/`ts` via `sealJSON` on `live_location_update`; `DEFAULT_FAMILY_SETTINGS.sharing` is `false`. Adaptive publishing is `lib/family/cadence.ts` (see 2.3).
- [x] 1.5 Relay verification — **verified this pass.** `vaultchat-backend-go/internal/realtime/handlers.go:78-101` and `vaultchat-backend/server.js:832-855` both (a) persist nothing, (b) log nothing (`grep live_location | grep -i log` is empty in both), (c) gate on cached `chat_members` membership before relaying, (d) pass `blob` through opaque and stamp only the server-known `userId`. *ponytail: both relays still tolerate a legacy plaintext `latitude`/`longitude` path for cross-version rollout. No family client can reach it — `presence.ts` only ever emits `blob` — but the relay is not structurally ciphertext-only until that branch is dropped.*

## F2 — Presence + roster (no map yet)
- [x] 2.1 Decrypt incoming pings on-device; roster with last-seen, battery, staleness — `presence.subscribeCircle` → `openJSON`; roster rows in `app/family.tsx` render `ago(ts)`, distance, "moving", battery chip; `STALE_MS = 90_000` drives dimming.
- [x] 2.2 "Location off" state for members who haven't opted in — roster row falls back to `'Location off'` when no presence exists for that member.
- [x] 2.3 Adaptive interval tied to motion state; hard stop when sharing toggled off — hard stop already shipped (`setSharing(false)` clears the key, stops the background task, emits `live_location_stop`). Adaptive half added as `lib/family/cadence.ts`: a pure, self-checked module that classifies `stationary`/`walking`/`driving` from speed with enter/exit hysteresis (so a phone on a boundary cannot flap) and scales the publish interval 1x/2x/8x off the user's configured moving cadence.

      Two properties worth keeping in mind if this is ever tuned:

      * **It throttles the socket emit, not the GPS watcher.** Every fix still reaches the geofence engine and the history store at full resolution, so safe zones are exactly as accurate as before and no fix is dropped. This is also literally what 1.4 asks for ("publish … at an adaptive interval").
      * **`MAX_PUBLISH_MS` is a correctness bound, not a tuning knob.** A receiver dims a member once their last fix is older than `STALE_MS` (90 s), so any publish gap at or past that would paint a healthy, actively-sharing member as stale on everyone else's map. It is pinned to two thirds of the stale window (60 s) and the self-check asserts every state/base combination stays inside it. The background publisher independently settled on the same 60 s.

      The background task is deliberately NOT throttled: it already runs at `timeInterval: 60_000` / `distanceInterval: 75` with `pausesUpdatesAutomatically`, so it is coarser than anything this would impose, and it is headless (fresh JS context per invocation) so a publish clock there would need persisted state for no gain.

      *ponytail: this saves the radio, not the GPS chip. Driving `watchPositionAsync` itself from the motion state would save more, but re-arming it mid-session risks a fix gap, so it wants a change that can be field-tested on hardware.*

## F3 — Map surface
- [x] 3.1 Spike + pick renderer — **resolved differently.** Neither option was taken: `components/family/FamilyMap.tsx` runs **bundled Leaflet inside a WebView** (base64-inlined JS+CSS from `components/nav/leafletAsset`, no CDN). It satisfies the no-GMS requirement that motivated the MapLibre/PMTiles column while adding zero native dependencies.
- [x] 3.2 Add the native dependency; `expo prebuild`; update store listings — **N/A, and that is the payoff of 3.1.** The Leaflet-in-WebView choice means there is no new native module, no prebuild, and no store-listing SDK change to make.
- [x] 3.3 `family.tsx` map: markers from decrypted pings, freshness dimming, tap→`navigateTo` — markers with initials + stable colour, self halo, `stale` at 55% opacity, marker tap posts `sel:<id>` back to RN; roster navigate button calls `navigateTo(lat, lng, name)`.

## F4 — Geofences (on-device only)
- [x] 4.1 On-device geofence engine (define/edit/delete places), evaluation never leaves device — `lib/family/geofence.ts` (pure, self-checked, 40 m exit hysteresis) + `app/family-places.tsx` (add by GPS / address / `lat,lng`, per-place on-off, edit, delete, 50–5000 m). Definitions live in AsyncStorage under `vc_family_places_*`; nothing is uploaded.
- [ ] 4.2 Arrive/leave → E2EE system message into the Circle thread; local guardian notification — **half done.** The system message ships (`fixPipeline.processFix` → `announce` → `sendMessage(cid, text, 'system')`) and a typed local alert is recorded. **Open: there is no notification.** `recordAlert` writes to the in-app inbox and tab badge only, so a crossing that happens while the app is backgrounded surfaces nothing until the user next opens Family Space. Needs the Notifee local-notification path, and shares that plumbing with F7.1.

## F5 — SOS burst
- [ ] 5.1 Reuse SOS capture; sealed high-priority ping + critical E2EE system message to guardians — **half done.** Hold-to-SOS (`app/family.tsx`) forces sharing on, takes a high-accuracy fix, posts `🆘 …` as an E2EE system message and records a `critical` alert. **Open on two counts:** the burst is not a distinct high-priority ping (it just flips normal sharing on, so the first position still waits for the next 8 s tick), and it is addressed to the whole circle rather than to guardians specifically.
- [x] 5.2 Guardian tap → in-app navigation to sender (verify no-GMS path) — `navigateTo()` from the roster row and from the member screen's Route action. The no-GMS path is verified by construction: the renderer is Leaflet-in-WebView (3.1) and routing is our own Valhalla proxy, so neither depends on Play Services.

## F6 — Guardian escalation ladder
> **Not started.** Verified absent: no ladder, timer, or check-in scheduler exists
> in `lib/` or `app/`. (`grep escalat|checkinLadder|requestCheckin` matches only
> `services/security/*`, which is the duress/threat engine — unrelated.)
> The check-in *presets* in `app/family.tsx` are one-shot messages with no
> follow-up state, so F6 starts from the state machine, not from the UI.
- [ ] 6.1 On-device state machine: missed check-in / unanswered call → retry +5min → +15min → Emergency Connect after N misses
- [ ] 6.2 "I'm OK" cancels ladder; every action logged as an E2EE system message (audit)
- [ ] 6.3 Guardian-initiated "request check-in" (v1 scheduling model)

## F7 — Emergency Connect + compliance
> **Not started**, except the two manifest declarations noted in 7.4. Family
> alerts are device-local and in-app only today (see 4.2), so nothing in this
> section has kill-safe delivery.
- [ ] 7.1 Full-screen critical alert via existing Notifee FGS + native FCM path (kill-safe delivery) — the plumbing exists for **calls** (`plugins/withVaultChatCalls.js`) but is not wired to any family event.
- [ ] 7.2 Android: optional auto-answer video + sealed location burst (confirm UX/OS constraints)
- [ ] 7.3 iOS: repeating critical alarm; graceful degrade when Critical Alerts entitlement absent
- [ ] 7.4 Compliance — **partially satisfied already:** `ACCESS_BACKGROUND_LOCATION` (`app.json:68`) and `USE_FULL_SCREEN_INTENT` (`app.json:56`) are both declared. Still open: the Play Console background-location declaration form, and the iOS Critical Alerts entitlement request (no entitlement found in `app.json`).
- [ ] 7.5 Battery + kill-safety field test; flip the feature flag on after two-device verification *(requires physical devices)*
