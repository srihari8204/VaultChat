# Family Navigation

## Why

Family could show you **where** everyone was and could compute a road distance
to them, but it could not take you there. Tapping Navigate handed off to the
separate `/navigate` mini-app, so the family context — the space, the member,
the saved places — was left behind at the door.

Underneath, the engine had a defect that only shows up on a long journey:
`navigationService.onFix` scanned the WHOLE route shape on every GPS fix
(`nearestIndex`), then walked it again for the maneuver and again for the
remainder. Measured on a synthetic Valhalla-density route, that is
**0.4808 ms/fix at 6000 vertices and linear in route length**.

And it rerouted on a **single** bad GPS sample: one fix under a bridge spent a
Valhalla request and moved the route out from under a driver who had never left
it.

## What Changes

- **Navigation happens inside Family.** `app/family-map.tsx` gains the full
  journey — route overview, start, live progress, follow, off-route, reroute,
  arrival — driven by the EXISTING `navigationService` session. `/navigate` and
  `NavBanner` are untouched and still serve the Navigate mini-app.
- **The per-fix maths becomes constant-time.** `lib/nav/routeProgress.ts`
  replaces the two O(n) scans with a windowed search around the previous index
  plus a prefix-sum distance table: **0.0029 ms/fix, 167x, and flat in route
  length**. A rescan guard catches the case the window gets wrong (reroute,
  resume, first fix far from the start).
- **Off-route becomes a four-state ladder with hysteresis and a cooldown**
  (`on_route` → `temporarily_uncertain` → `off_route` → `reroute_required`),
  so the UI can say "Checking route…" before it accuses anyone, and ONE bad
  sample can never spend a reroute.
- **A Rust core, behind the bridge that already ships.** `services/nav/rust`
  (`nav-core`) is linked into the EXISTING `libvaultcrypto.so` and registered as
  a second Nitro HybridObject. `lib/nav/native/NavCore.ts` selects it and falls
  back to the TypeScript reference implementation, which parity tests prove
  identical.
- **Saved places become one-tap destinations**, and only places that actually
  exist are ever drawn.

## Impact

- Affected specs: `family-navigation` (new)
- Affected code: `lib/nav/{routeProgress,navPresentation,navigationService}.ts`,
  `lib/nav/native/NavCore.ts`, `components/family/{NavigationLayer,FamilyMap}.tsx`,
  `app/family-map.tsx`, `services/nav/rust/**`,
  `plugins/crypto-core-android/**`
- **No backend change. No new endpoints. No migration.** Valhalla usage is
  unchanged (`/nav/route`, `/nav/matrix`).
- One additive client contract: `NavBanner` gains `verdict` and `arrived`.
  Existing consumers ignore them.

## Honest note on the Rust core

The 167x is **algorithmic and lives in TypeScript**. Measured against that
optimised TypeScript, the Rust core saves ~0.3 µs per fix — less than a single
JSI crossing costs. It is wired because the owner asked for the native path to
be real rather than dead code, and it says so in its own header. It is not
load-bearing for performance, and `preferNative(false)` disables it with no
behavioural change.
