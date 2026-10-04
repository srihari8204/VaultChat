# Screen audit remediation (2026-10-04)

## Why

A static review of all 193 screens (`2026-10-04_screen_ratings.md`, mean 6.0/10) found
screens that report success they never achieved, routes nothing links to, controls whose
setting nothing reads, a vault that cannot be unlocked with an in-app PIN, and load
failures shown as empty lists. `2026-10-04_screen_remediation_plan.md` orders the fixes.

## What Changes

- Delete mock and legacy routes that make false claims, or rewrite them against real services.
- Fix the security and data-loss findings: vault PIN parity, relock on resume, chat-lock
  hardening, plaintext caches, view-once leaks, encrypted-notes overwrite, archive size guard.
- Fix the broken core flows listed in plan Phase 2 (SOS order, Spaces runs, chat, media,
  Shop Book, finance, groups, location, calls, games).
- Show load failures as errors with retry, and confirm destructive actions, on the screens touched.

## Already built vs new

- Built and reused: `services/security/pinStore` (scrypt PIN record), `lib/chatLock`,
  `components/finance/ui.tsx` `ErrorState`, the existing Go/Node endpoints, theme tokens,
  the coverage selftests (`a11yCoverage`, `themeCoverage`, `orphanRoutes`, `screenBackCoverage`).
- New: only small helpers and screens' missing UI; each non-trivial logic change adds a selftest.

## Not building

- No backend changes are deployed from this change. Round 3 wrote the server changes some
  fixes needed (not deployed); the deploy order and the rest are in `2026-10-04_fix_status.md` §4.
- No app-wide a11y requirement over every touchable (plan Phase 3); a per-file ratchet
  (`lib/uiDebtRatchet`) only stops new debt. The full pass stays with `interaction-integrity`
  and `glass-screen-polish`. (Round 3 did split `app/chat.tsx` and `app/shop-book.tsx`.)
- No new dependencies.

## Capabilities

### New Capabilities
- `screen-integrity`: what every screen may claim and how it reports failure.

## Impact

App screens under `app/`, a few `lib/` and `services/` modules, `admin/*.html`.
Progress and updated ratings are tracked in `2026-10-04_fix_status.md`.
