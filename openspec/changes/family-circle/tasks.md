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
- [x] 4.2 Arrive/leave → E2EE system message into the Circle thread; local guardian notification — the message already shipped; the **receiver half did not**. A crossing is evaluated on the subject's own phone, so their device recorded an alert, but every OTHER device — the guardian who actually wants to know — recorded nothing and saw only an ordinary chat line. Added:

      * `lib/family/events.ts` (pure, self-checked) — the crossing wire format and its parser. Announcements now carry a marker so a receiver recognises a family event instead of regexing English; the parser also accepts the unmarked legacy form, so mixed-version circles keep working both directions. The inbox text stays clean — only the thread message is marked.
      * `lib/family/notify.ts` — the Notifee surface, modelled on `lib/lock/lockNotifications.ts`. Two channels (normal + emergency). Never notifies a user about their own action, which without a guard would fire on every crossing for the very person who walked through it.
      * `presence.ingestCrossings` — turns other members' announcements into inbox alerts + notifications, reusing the message list the key-capture pass already fetches, so there is no extra round trip. `subscribeCircle` now also refreshes on a `system` message, not only `location`.

      Two guards worth keeping if this is ever tuned:

      * **Age policy** (`ingestAction`, self-checked). A receiver ingests from recent history, so the first subscribe after install or any long gap sees a backlog. Replayed naively that is a burst of notifications for hours-old events — how an app earns a mute. Crossings older than 10 min go to the inbox silently; older than 6 h are dropped entirely.
      * **Ingested-id set** (`store.getIngested`/`addIngested`, capped at 200, cleared with the circle). `recordAlert`'s 60 s dedupe cannot cover a screen reopened an hour later. Every examined message is marked — including non-crossings — so a chatty circle isn't re-decrypted on each refresh.

      Scope, deliberately: these are raised **in-process from data already decrypted for the thread** — the same trust boundary the inbox and Today's Highlights already sit behind. `lib/messageNotifications.ts` is content-free by design for the opposite case (a push with nothing decrypted) and that rule is NOT relaxed here. **Kill-safe delivery remains F7.1**: if the process is gone no JS runs, and the user falls back to the generic content-free "new message" notification.

## F5 — SOS burst
- [x] 5.1 Reuse SOS capture; sealed high-priority ping + critical E2EE system message to guardians — hold-to-SOS (`app/family.tsx`) reuses the existing capture: forces sharing on, takes a high-accuracy fix, posts a critical E2EE system message and records a `critical` alert. Two halves closed this pass:

      * **Latency.** The SOS position used to wait for the next 8 s watcher tick. Turning sharing on now resets the publish clock (2.3), so it goes out on the very next fix.
      * **Reaching the guardian.** An SOS previously reached a receiver's *thread* but not their *alert inbox* — the same gap 4.2 fixed for crossings. `presence.ingestFamilyEvents` now parses SOS and check-ins too and raises them on the emergency Notifee channel. This needed the parser to check glyphs BEFORE crossing grammar: a check-in note is free text and "✅ Asha: left work early" would otherwise have been read as a geofence departure. Both orderings are asserted in the self-check.
      * Ingestion also had to widen from `system` to `system` + `text`, since check-ins are sent as ordinary text. That widened the refresh trigger from `location` (rare) to nearly every message, and each refresh is a 60-message fetch — the `refreshing` flag only stops concurrent runs, not repeated ones. A trailing debounce coalesces a chat burst into one pass; the key-miss path stays immediate, since a live position is waiting on it.

      **Two deviations, deliberate:**

      * *"sealed high-priority ping"* — there is no priority lane in the relay, and adding one is a server change well beyond a client fix. The effect is achieved by making the ordinary sealed ping immediate instead, which is what the requirement was for.
      * *"to guardians"* — the message goes to the whole circle, not only guardians. A Circle is a group chat with no per-role addressing (1.1), so guardians receive it as a superset rather than a target. Narrowing it would need either a second thread or server-side role routing; the `guardian` role is still what gates member management.

- [x] 5.2 Guardian tap → in-app navigation to sender (verify no-GMS path) — `navigateTo()` from the roster row and from the member screen's Route action. The no-GMS path is verified by construction: the renderer is Leaflet-in-WebView (3.1) and routing is our own Valhalla proxy, so neither depends on Play Services.

## F6 — Guardian escalation ladder
> Built this pass. Timing lives in `lib/family/escalation.ts` — pure and
> self-checked, because the ladder's whole job is to be right about time on a
> phone that sleeps, is killed, and cold-starts hours later. `escalationService.ts`
> holds the IO: persistence, the ticker, and the audit messages.
>
> **Ownership** is the rule that makes it safe: a ladder runs ONLY on the device
> of the guardian who started it. Both parties see the audit messages, so if both
> ran it every reminder would post twice and two Emergency Connects would fire.
> The member's device holds no ladder at all.

- [x] 6.1 On-device state machine: missed check-in / unanswered call → retry +5min → +15min → Emergency Connect after N misses — `LADDER_STEPS` is the spec's ladder verbatim (+5 retry, +15 retry, +30 emergency); `MISSES_BEFORE_EMERGENCY` derives from it. `nextDueAt` drives the timer, `advance` folds time forward, and both are immutable so the caller persists the returned copy.

      **The collapse rule is the one to preserve.** A device asleep across several steps fires only the FURTHEST one, reporting the rest as `skipped`. Replaying each step on wake would spam stale reminders and — much worse — could raise an Emergency Connect the member had already answered before the ladder was rehydrated. The self-check pins this from both directions (asleep past everything ⇒ one emergency; asleep across both retries ⇒ one retry, `skipped: 1`).

      Also pinned: a backwards clock or `NaN` never fires (an emergency raised by an NTP correction is worse than a late one), a step never double-fires, and an escalated or cancelled ladder never fires again.

- [x] 6.2 "I'm OK" cancels ladder; every action logged as an E2EE system message (audit) — every action (request, retry, cancel, Emergency Connect) is posted with `sendMessage(..., 'system')` **and** recorded as a local alert, so the audit survives even if the thread is cleared. The circle thread is the durable record; the local store is only a resume cursor and keeps just active ladders.

      "I'm OK" is a **message, not a local call**. The member posts the confirmation; the guardian's device cancels its own ladder when it ingests that line (`presence.ingestFamilyEvents` → `onMemberConfirmedOk`). That falls out of ownership — the member's device has no ladder to cancel — and it means the answer works from whichever device the member is holding. The cancel runs *before* the age gate, so a stale confirmation still stops a ladder even when it is too old to announce.

- [x] 6.3 Guardian-initiated "request check-in" (v1 scheduling model) — v1 ships the guardian-initiated request only, which `design.md` §41 lists as the acceptable v1 answer to the open scheduling question. It is on the member long-press sheet, guardian-only, with a confirmation naming what will happen. `requestCheckin` is **idempotent per subject**: asking twice while a ladder is running returns the existing one rather than stacking a second set of reminders on the same person. The member answers from the check-in sheet.

      *ponytail: the timer half only runs while the guardian's app runs. A ladder resumes correctly after a cold start (advance collapses whatever came due), but a guardian whose app stays killed across the whole window sees the escalation late, on next launch. Kill-safe delivery is F7.1 — the spec anticipates exactly this, calling server-side high-priority push the backstop for the on-device timer.*

## F7 — Emergency Connect + compliance
> The client half of the alert is built; the rest of F7 is **not client work**
> and cannot be closed from a repo alone. What remains needs a server push
> change, an Apple entitlement grant, a Play Console submission, and two
> physical phones. Each box below says which.

- [ ] 7.1 Full-screen critical alert via existing Notifee FGS + native FCM path (kill-safe delivery) — **client half done, server half open.**
      `notify.notifyEmergencyConnect` raises the full-screen alarm (ALARM category, `fullScreenAction`, `loopSound`, `lightUpScreen`, ongoing, Acknowledge action). Both routes are wired: the requesting guardian gets it when their own ladder runs out, other guardians get it by ingesting the 🚨 audit line. The age gate from 4.2 keeps a stale backlog from sounding a siren on first open.

      Every option is copied verbatim from `lib/lock/lockNotifications.ts:showLockAlarm` — the one alarm surface in this repo already proven on device. Inventing a shape would be a bad trade here: notifee cannot be typechecked in this environment and a rejected payload fails **silently**, which for this notification means the emergency is simply never shown.

      **Still open: kill-safe delivery.** Nothing above runs if the guardian's process is gone, and the requirement is explicitly "even when the guardian's app is killed". That needs the backend to send a high-priority FCM when an Emergency Connect audit message is posted — a change in `vaultchat-backend/server.js` *and* `vaultchat-backend-go`, plus a client data-message handler. It is server work, deliberately not attempted here.

- [x] 7.2 Android: optional auto-answer video + sealed location burst (confirm UX/OS constraints) — **resolved as tap-to-answer**, which `design.md` §40 lists as the acceptable outcome ("…or make it tap-to-answer").
      Auto-answer was rejected on two grounds. Technically, Android 10+ blocks background activity starts; the sanctioned replacement is exactly the full-screen intent 7.1 now uses, so a killed app cannot reliably force a call to answer anyway. And on consent: silently opening a camera and microphone on someone's phone is not a thing to ship because a state machine decided a member was late. The full-screen alarm hands the guardian a one-tap route in instead.
      The **sealed location burst** half ships: an SOS forces sharing on and the publish clock reset (2.3) puts the position out on the very next fix.

- [ ] 7.3 iOS: repeating critical alarm; graceful degrade when Critical Alerts entitlement absent — **blocked on the entitlement, not on code.** A repeating critical alarm requires `critical: true` in notifee's iOS options, which is inert without `com.apple.developer.usernotifications.critical-alerts`. Today iOS takes default notification treatment, which IS the graceful-degrade branch the spec asks for — but "records that the critical channel was unavailable" is not implemented, and no iOS-specific notifee option is set anywhere in this repo, so there is no proven shape to copy (see 7.1). Do this together with 7.4's entitlement, on a machine that can build for iOS.

- [ ] 7.4 Compliance: Play background-location declaration, `USE_FULL_SCREEN_INTENT`, iOS Critical Alerts entitlement request — **partly satisfied; the rest is not a code task.**
      Already declared: `ACCESS_BACKGROUND_LOCATION` (`app.json:68`) and `USE_FULL_SCREEN_INTENT` (`app.json:56`, via `plugins/withVaultChatCalls.js`).
      Open, and deliberately NOT done here: the Play Console background-location declaration is a submission form, not a manifest entry. And the iOS Critical Alerts entitlement **must not be added to `app.json` before Apple grants it** — an unapproved entitlement fails provisioning and gets the build rejected, so adding it speculatively would break the iOS build rather than advance the task.

- [ ] 7.5 Battery + kill-safety field test; flip the feature flag on after two-device verification *(requires physical devices)* — cannot be run in this environment. Note that the escalation ladder's collapse behaviour and the 4.2 age gate are the two things this test should probe hardest, since both only show themselves across a real sleep/kill cycle.
