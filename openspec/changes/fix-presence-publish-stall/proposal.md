# Fix: Space location publishing stalls ~60–90s after start (locked AND unlocked)

## Why

Two-phone testing on 2026-09-06 (Honor ELI-NX9 + Redmi Note 8 Pro, build
91a4aa58, both md5-verified) proves the user-reported defect "location does
not share when locked" — and shows it is WORSE than the report: publishing
dies about 60–90 seconds after `startPresence`, even with the screen ON and
the app focused. The lock screen is when people notice, not when it breaks.

Evidence, reproducible at will:

1. Clean cold start on both phones → both publish; each phone's roster shows
   the other as `LIVE · 0 m away` within 45 s.
2. With NO further interaction (Honor awake, app foreground the whole time),
   the other phone's view ages linearly: `LIVE` → `2m ago` → `3m ago` →
   `4m ago`. Nothing arrives again until the app is relaunched/refocused.
3. The Redmi lands in a second observable broken state, photographed by the
   owner: the share switch ON while the adaptive diagnostics row reads
   **"Not sharing location · every 60s · not publishing"** — the `notSharing`
   plan tier, i.e. the presence module's internal `sharing` flag is false
   while the UI state (and persisted settings) say true. A cold start clears
   it; some later lifecycle transition re-creates it.
4. Ruled out on-device: doze (app whitelisted, `mState=ACTIVE`), network
   (mobile data up, ping 52 ms while dozing), permissions (FINE + BACKGROUND
   granted on both), the foreground service (LocationTaskService alive with
   `startForegroundCount=4` throughout the silence).
5. `dumpsys location` shows vaultchat's fused registrations at
   `@+5s HIGH_ACCURACY` — the OPENING tier — recurring long after the first
   fix should have stepped the watcher down to a Balanced tier. With Wi-Fi
   disabled (both test phones), HIGH accuracy is effectively GPS-only, which
   indoors produces no fixes; but the 20–45 s keepalive re-asserts `lastLoc`
   and should have kept the other phone at `LIVE` regardless — so by t+90s at
   least one of the keepalive guards (`sharing`, `myKey`, `lastLoc`,
   `watcher`) has gone falsy.

History that bears on this: presence.ts's own comments record TWO prior
on-device bugs with this exact "~60 s then dead" signature (the create/remove
watcher ordering, and the desired-vs-armed replan comparison), each "fixed"
where the last probe landed. The generation guard added 2026-08-28 voids
SUPERSEDED calls but cannot stop a newer call that carries a stale
`share=false` value. The failure is a lifecycle interaction, and black-box
probing has now hit its limit.

## What Changes

- Instrument `lib/family/presence.ts` (`startPresence`, `armWatcher`,
  `replan`, `startKeepalive`/keepalive tick, `setSharing`) and
  `lib/family/background.ts` (task wake, publish gate) with `console.warn`
  tracing — warn, because release builds strip `console.log`, and the REDMI's
  logcat is readable (the Honor's is EMUI-suppressed; run the log capture on
  the Redmi).
- Reproduce the 90-second stall with the instrumented build and identify
  which guard/path dies: watcher re-arm failure loop, keepalive guard,
  module `sharing` flip, or socket/flush stall.
- Fix the root cause (smallest change at the failing site), keeping the
  invariants: never publish plaintext, never fabricate a coordinate,
  per-group privacy gates, one key per sharing session.
- Add a selftest pinning the state machine transition that failed, if the
  root cause is in pure logic; otherwise record the device matrix that
  proves it (lock 5 min → other phone stays LIVE; app swiped away → other
  phone stays LIVE; warm deep-link relaunch → still publishing).

## Impact

- Affected specs: family-circle (live presence), spaces (run broadcast rides
  the same engine/key).
- Affected code: `lib/family/presence.ts`, `lib/family/background.ts`,
  possibly `app/family.tsx` effect wiring.
- Risk: this is THE core safety loop of Spaces; every change must re-run the
  two-phone matrix before it is called fixed. "tsc green" has already been
  proven insufficient for this path three times.

## RESOLVED — root cause and fix (2026-09-06)

**Root cause.** `stopPresence()` contained a conditional FULL session teardown:
whenever `isBackgroundRunning()` was momentarily false it set
`sharing=false; myKey=null; circleIds=[]`, cleared the privacy/places maps and
broadcast `live_location_stop`. But that check is false in perfectly normal
operation: `startBackgroundPresence()` deliberately STOPS the task before
restarting it on every handoff (the stale-registration fix), and a handoff
runs inside every `startPresence` and `setSharing(true)`. `stopPresence` is
called from every screen blur and every presence-effect cleanup — a cold
start alone produces 2-3 rapid cycles (mount → circles-loaded → focus tick) —
so a teardown regularly landed inside the stop→start window and killed the
session while the UI switch kept its own `share=true`. The 2026-08-28
generation guard could not help: it only voids superseded `startPresence`
calls, and `stopPresence` mutates module state from outside any generation.
Compounding it, the stationary keepalive — the design's own safety net —
died silently on its `!watcher` guard, so ANY watcher death (including the
historically measured first-re-arm delivery loss) became permanent silence:
no component owned "sharing ON ⇒ publisher recoverable".

**Fix (lib/family/presence.ts only).**
1. `stopPresence()` now does exactly what its doc always claimed: foreground
   watcher teardown only. The session (`sharing`/`myKey`/`circleIds`/maps)
   is untouchable there; if sharing and the background task is not running
   it ATTEMPTS the handoff instead of ending the session. The only real stop
   remains `setSharing(false)` (unchanged: announces live_location_stop,
   stops the background task, drops the key, clears the ledger).
2. The keepalive tick is now the watchdog owner of the invariant: it
   re-asserts the last REAL fix regardless of watcher state (same cadence,
   nothing invented) and re-arms a dead watcher via the existing armWatcher
   path — after re-checking the foreground permission, so a mid-session
   revocation goes silent rather than replaying the past.
3. `armWatcher` is single-flight (`arming` flag) and `handOffToBackground`
   is serialised (promise chain), so concurrent re-arms/handoffs can no
   longer interleave remove/create or stop/start into a dead final state.

**Pinned by** `lib/family/presenceLifecycle.selftest.ts` (22 source
invariants, wired into `test:space`), covering: no session teardown in
stopPresence, explicit-stop semantics intact, watchdog recovery + permission
re-check + no fabricated coordinates, single-flight/serialisation, the
generation guard, and background.ts's locked-state pillars (foreground
service, killServiceOnDestroy:false, pausesUpdatesAutomatically:false,
in-wake flushAll).

**Manual device matrix still owed (owner):** sharing unlocked >2 min · lock
several minutes · unlock · network loss/recovery · location recovery ·
toggle OFF/ON · server-side continuity.
