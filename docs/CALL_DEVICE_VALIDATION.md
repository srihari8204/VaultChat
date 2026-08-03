# A5 — device validation for `CALL_ENGINE_V2` and `CALL_SESSIONS`

Two physical phones on **different networks** (one on Wi-Fi, one on mobile data
— not two devices on the same router, which quietly tests nothing but the LAN
path). Everything below is ordered so the cheapest test that can fail does so
first.

This does **not** repeat the OEM survival matrix in `CALLS_README.md`. That
matrix tests the Android native layer, which the engine did not change: it calls
the same `lib/CallService` through `lib/call/native/android.ts`. Re-run it once,
at Stage 5, to confirm that claim.

---

## What is actually being validated

The engine build and the legacy build speak an **identical wire** — same events,
same payload field names, same re-send cadences, same E2EE envelope. That was
the design constraint that let this ship behind a flag, and it is the one claim
local testing cannot check, because it needs two builds and two networks.

So the cross-build cases in Stage 3 are not a nice-to-have. They are the whole
reason the flag exists: a staged rollout means a fleet where **both builds are
live at once**, and every call in that period is a mixed call.

## Builds you need

| Build | `CALL_ENGINE_V2` | `CALL_SESSIONS` | Used in |
|---|---|---|---|
| **L** legacy | `false` | `false` | baseline + cross-build |
| **E** engine | `true` | `false` | stages 1–5 |
| **S** sessions | `true` | `true` | stage 6 only, after migration 066/067 is applied |

Install L on one phone and E on the other. Swap them between runs — direction
matters, and several failure modes only appear one way round.

---

> ### ⚠️ The WebRTC library changed underneath all of this
>
> `react-native-webrtc@124` was replaced by `@livekit/react-native-webrtc@144`
> (see `docs/SFU_SPIKE.md`). The JS API is identical, but the native media stack
> is **twenty libwebrtc milestones newer**, and that is where ICE behaviour, SDP
> tolerances and hardware encoder selection can shift.
>
> **This means Stage 0 no longer isolates the engine.** Both builds now sit on
> new libwebrtc, so a "legacy vs legacy" baseline failing tells you the library
> regressed, not that the engine is fine. Pick one:
>
> * **Preferred — two passes.** Check out the commit *before* the swap
>   (`git log --oneline -- package.json`, the C1a commit), run Stages 0–3 on
>   `CALL_ENGINE_V2`, then return to HEAD and run the whole plan again. Two
>   passes, one variable each, and a regression names its own cause.
> * **Faster — one pass, accepting ambiguity.** Run the plan once at HEAD. If
>   something fails, `git revert` the swap commit and re-run that stage to find
>   out which change owns the failure.
>
> Either way **VaultBeam is now in scope**, because it rides the same library.
> Transfer a few hundred MB in both directions and watch for a stall at the
> 4 MiB backpressure ceiling — the API is verified compatible, the behaviour of
> the SCTP stack under load is not.

## Stage 0 — baseline (10 min)

Run **L ↔ L** first. If anything here fails, it is not the engine and the rest
of this document is measuring the wrong thing.

- [ ] voice call connects, both directions
- [ ] video call connects, both directions
- [ ] hang up from each side; the other device's screen closes
- [ ] the call appears in the Calls tab with a plausible duration

---

## Stage 1 — engine to engine (30 min)

**E ↔ E.** Fastest way to find a gross engine defect.

- [ ] voice connects; audio both ways
- [ ] video connects; video both ways
- [ ] mute → peer stops hearing you; unmute restores
- [ ] speaker toggle changes the route; **plug in headphones, toggle speaker off,
      confirm audio returns to the headset and not the earpiece** — this is the
      specific reason `setSpeaker` passes `null` rather than `false`
- [ ] flip camera front↔back, twice, mid-call
- [ ] the duration timer counts up and matches wall-clock after 2 minutes
- [ ] **background the app for 60s, return** — timer shows the true elapsed
      time, not 60s less. (It derives from a start timestamp precisely because
      JS timers are throttled in the background; a counter under-counted here
      and wrote the wrong duration to the call log.)
- [ ] end from each side in turn; both screens close

**Fail here →** the engine is broken in a way that has nothing to do with
interop. Capture `adb logcat` around the failure before going further.

---

## Stage 2 — call setup edge cases (20 min)

Still **E ↔ E**. These are the paths the reducer's invariants encode, and the
cheapest place to catch a regression in them.

- [ ] callee **declines** → caller sees the call end, callee logs a missed call
- [ ] caller **cancels while ringing** → callee's ring stops, and it logs as
      missed on the callee
- [ ] callee's phone is **locked** → ring still arrives
- [ ] **both call each other simultaneously** (glare) — exactly one call should
      survive, not two half-connected screens
- [ ] callee **answers on the 8th ring** (~25s) → still connects. This exercises
      the 3s × 9 re-ring loop that exists so a killed-then-woken device can still
      catch the offer.
- [ ] put the caller in **airplane mode mid-call** → the callee's screen ends
      within a few seconds rather than hanging on a frozen frame

---

## Stage 3 — cross-build (45 min) — **the stage that matters**

Both directions. Run every row twice, swapping which phone holds which build.

| | E calls L | L calls E |
|---|---|---|
| voice connects | ☐ | ☐ |
| video connects | ☐ | ☐ |
| mute is heard correctly | ☐ | ☐ |
| hang-up closes the other screen | ☐ | ☐ |
| duration logged on both devices | ☐ | ☐ |

- [ ] **group call, mixed builds**: one E and one L device in the same group
      call, both see and hear each other
- [ ] group call where an **E device joins a call an L device started**
- [ ] and the reverse

**Fail here →** the wire is not identical after all, and that is a blocker for
any staged rollout, not a bug to fix later. The likely suspects, in order: the
two SDP shapes (`{to, from, offer}` for 1:1 vs `{to, chatId, sdp}` for mesh —
see `lib/call/signal.ts`), the E2EE envelope, and the glare rule.

---

## Stage 4 — group and the new controls (30 min)

**E ↔ E**, three devices if you have them; two if not.

- [ ] group call connects; both/all participants see each other
- [ ] the controls the mesh never had before: **speaker toggle, flip camera,
      duration timer** all work
- [ ] one participant **force-quits the app** → their tile disappears within
      ~15s instead of freezing forever. This is the A1 fix; the old code left
      the branch empty, so a phone that lost signal stayed on the roster as a
      dead tile.
- [ ] in-call **chat**: send both directions, unread badge counts, badge clears
      on open
- [ ] in-call **reactions**: appear on the other device, animate once, do not
      re-animate on unrelated re-renders
- [ ] with a 6th participant, the server's `call_full` is surfaced as a message
      rather than a screen that never receives a roster

---

## Stage 5 — Android survival (60 min)

Re-run the `CALLS_README.md` OEM matrix on **E**, not L. The engine calls the
same native layer, so this is confirming that claim rather than testing new
code — but "should be identical" is exactly the kind of assumption that is
wrong once.

Minimum: one MIUI or ColorOS device (the strictest) plus one stock Android.

- [ ] connected call survives backgrounding (foreground service)
- [ ] **app swiped away / killed** → a peer's call still rings full-screen
- [ ] decline from the lock screen → the caller sees it stop

---

## Stage 6 — call sessions (20 min) — only after migration 066/067

Requires the Go backend deployed with migrations applied. Build **S**.

- [ ] a call still connects **when the backend is unreachable** — this is the
      one that must not fail. The session is opened fire-and-forget precisely so
      that media never waits on REST; if a call fails or is slow when the API is
      down, the non-blocking contract is broken somewhere.
- [ ] call history appears on a **second device** signed into the same account
- [ ] history survives a **reinstall**
- [ ] a call made while **offline** appears locally, and does not vanish when
      the device reconnects and syncs
- [ ] the same call is **not listed twice** after a sync
- [ ] deleting a synced call row keeps it deleted after a refresh
- [ ] group call: host **promotes** a participant; both devices see the change
- [ ] a participant **raises a hand**; the host sees it, and promoting lowers it
- [ ] a non-host taps a tile → no moderation menu appears

---

## Pass criteria

Flip `CALL_ENGINE_V2` to `true` when **Stages 0–5 pass with no open failure**.
Stage 3 in particular has no partial credit: a cross-build defect means the
fleet cannot hold two builds at once, which is the only way this ships.

Flip `CALL_SESSIONS` separately, after Stage 6 and after migrations 066 and 067
are applied to the server that build talks to. The two flags are independent on
purpose — one is a client refactor, the other is a server dependency, and
coupling them would mean a backend problem forcing a client rollback.

## After the flag is on

Delete the legacy bodies — `VoiceCallLegacy`, `VideoCallLegacy`,
`GroupCallLegacy` — roughly 800 lines, plus the flag itself. Not before: while
the flag can still be flipped back, that code is the rollback.

## If something fails

Record which build, which direction, which network, and the `adb logcat` slice.
A WebRTC failure that reproduces in only one direction is usually signalling
(check the SDP shape and the glare rule); one that reproduces in both is usually
media or ICE (check TURN reachability from both networks). A failure that only
appears on mobile data and never on Wi-Fi is almost always TURN — which is why
the two phones must not share a router.
