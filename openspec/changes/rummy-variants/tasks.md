# Tasks

## Phase A — table formats (client-only, ships independently)

- [x] A1.1 Add `filterBySeats(tables, mode)` to `lib/games/rummyTable.ts` —
      pure, beside the existing helpers. `mode` is `'all' | 'heads-up' |
      'multi'`; multi is `maxPlayers > 2`, NOT `=== 6` (the protocol documents a
      2–6 range and a hardcoded 6 hides 3-, 4- and 5-seat tables).
- [x] A1.2 Cases in `lib/games/rummyTable.selftest.ts`: a 2-seat table matches
      heads-up only; a 6-seat matches multi; a 4-seat matches multi; `'all'`
      preserves the server's order; an empty list returns empty, not a throw.
- [x] A1.3 Add the filter control to the rummy table list in
      `components/games/Rummy.tsx`.
- [x] A1.4 Empty-result state: say no table of that size is open and offer the
      unfiltered view — never render a blank list.
- [x] A1.5 Name the variant ("Points rummy") on `TableCard` and in the lobby.
- [x] A1.6 `npm run test:games` — capture the real exit code to a log, never
      read a piped tail.
- [x] A1.7 `npx tsc --noEmit` clean.
- [x] A1.8 Build arm64 APK, confirm `GRADLE_EXIT=0` from the log and a fresh
      APK mtime; install to both phones and verify by **md5**.

## Phase B — Pool and Deals match layer

**Gated on the owner answering the Open Questions in design.md — do not start
the backend before "should this be practice-only?" is answered.**

### B1. Backend

- [x] B1.1 Migration 126: a match record (variant, limit/deal count, table,
      roster, status) and per-deal scores. Follow the `games_live_tables`
      shape from migration 125.
- [x] B1.2 Go: create a match, read it, advance it by one deal's settlement.
      The API is the authority every client reads.
- [x] B1.3 Scope every handler by the caller's own id in the handler itself —
      RLS is inert in prod (the API connects as a superuser).
- [x] B1.4 Reconcile the match roster against whoever the server actually
      seats: players may leave between deals and the table's seats are not the
      match's players.
- [x] B1.5 `go test ./internal/routes ./internal/jobs`.
- [ ] B1.6 Deploy via `scripts/deploy-games.sh`. **Owner-run** — the auto-mode
      classifier refuses prod writes from here.

### B2. Client

- [x] B2.1 Offer Pool 101 / Pool 201 / Deals best-of-2 / best-of-6 when
      starting a rummy match — **practice tables only** (`pointValue === 0`),
      reusing the `allowsBots` predicate's condition.
- [x] B2.2 Running scoreboard across deals, read from the backend, never
      totalled locally.
- [x] B2.3 Pool elimination at the limit: an eliminated player is shown as out
      and is not dealt into later deals of that match.
- [x] B2.4 Deals: end after the agreed deal count, highest chip count wins.
- [x] B2.5 Advance the match when a deal settles, then offer the next deal to
      the players still in it — reuse `isFinishedSnapshot()` from
      `lib/games/history.ts` to decide a deal ended. **`result: "playing"` is
      not a finished game.**
- [x] B2.6 Match-over state and its rematch, distinct from a single deal's.
- [x] B2.7 Reconnect mid-match shows the backend's score, matching every seat.

### B3. Verify

- [x] B3.1 Selftests for the pure scoring: accumulation, the elimination
      threshold, the deal count, and a disconnect that misses a deal.
- [x] B3.2 Structural test that the score is READ from the API and not summed
      client-side — the "written end to end and joined nowhere" bug class.
- [ ] B3.3 Two accounts, two phones, a full pool match. Blocked today: the
      Redmi's account fails `409 User has no VaultID` and MIUI refuses adb
      input.
