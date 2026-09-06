## Context

`docs/GAMES_PROTOCOL.md` (written against the shipped server clients on
2026-08-24) settles what the games server can and cannot do:

> 13-card **Points** rummy. There is no pool (101/201) and no deals variant on
> this server: the wire protocol has no pool score, no elimination and no deal
> count, and the engine only ever settles a single deal at a time.

The server is distroless and not ours. So the question is not "how do we ask the
server for Pool" — it is "what can be built on a single-deal engine". Three
facts from the same doc say the answer is *quite a lot*:

- `tables[]` carries `maxPlayers` — the 2–6 seat limit, already on the wire.
- `settlement: { [playerId]: { delta } }` and `players[].points` arrive at the
  end of every deal.
- `start` re-deals the same table with the seats it has (today's rematch).

A deal is therefore a primitive we can compose. Pool and Deals are, in rules
terms, exactly that composition: repeat a deal, carry the score forward, and
stop on a condition.

## Goals / Non-Goals

**Goals**
- Ship the seat-count filter now — the data is already in hand.
- Give Pool and Deals a design that survives a disconnect and cannot be gamed
  by one client.
- Keep the games server the only authority on cards, turns and validity.

**Non-Goals**
- No changes to the deal itself; no local rummy engine, ever.
- No real-money play.
- No fifth game.

## Decisions

### Decision 1: Two phases, and they are not the same size

**Phase A (filter + variant naming) is client-only and independent.** It ships
without a migration, a Go deploy, or Phase B. It is a pure function over a list
the app already holds, and it should not be held hostage to the match layer.

**Phase B (Pool/Deals) needs a backend.** Treating them as one change would let
a genuinely large feature ride in behind a trivial one.

### Decision 2: Matches run on PRACTICE tables only

This is the decision most likely to be missed, and it is a correctness issue,
not a preference.

On a staked table the server settles **coins on every deal** — that is what
`settlement.delta` is. Pool rummy's actual rule is that money moves **once, at
the end of the match**; the per-deal points are just bookkeeping. Layering a
pool over a staked table would therefore charge a player *per deal by the
server* and *per match by us* — the same loss taken twice, and the second one
invisible to the server that took the first.

`pointValue === 0` marks a practice table, where the server moves no coins. The
codebase already has this predicate: `allowsBots()` in `lib/games/rummyTable.ts`
gates bots on exactly the same condition for a closely related reason (a staked
table seating a bot puts the house in the pot).

**Rejected — net the coins at the end.** It would mean reconciling our match
score against settlements the server has already applied, and being wrong there
costs a player real balance. Not worth it for play coins.

### Decision 3: The backend holds the score, not the device

A pool score decides who is eliminated, so it is adversarial state. Two reasons
a device cannot hold it:

1. **A disconnect loses a deal.** `vaultchat-golive-egress-fragility` and the
   games reconnect banner both exist because connections here drop routinely. A
   player who misses a deal's settlement carries a lower total than everyone
   else — and in Pool, that is the difference between eliminated and playing.
2. **Every seat must agree.** There is no game-over event from the games server
   (`vaultchat-mini-games-pro`), so if each device totals what it saw, nothing
   reconciles the disagreement.

So: a match row and per-deal score rows in VaultChat's Postgres, written through
the Go API, read by every client. This is the same shape as the existing
`games_live_tables` work (migration 125), and it should reuse that pattern
rather than invent one.

**The elimination rule is advisory at the games server.** We can refuse to deal
an eliminated player in *our* UI, but the games server will still seat them if
they send `start`. For play coins that is acceptable; it is stated here so
nobody later mistakes it for a security boundary.

### Decision 4: The filter is a pure function, tested as one

`filterBySeats(tables, mode)` joins `metrics()`, `ranked()`, `allowsBots()` and
the other pure helpers in `lib/games/rummyTable.ts`, and gets cases in the
existing selftest. `maxPlayers > 2` (not `=== 6`) defines multi-player, because
the protocol documents a **2–6** range and a hardcoded 6 would silently hide
3-, 4- and 5-seat tables.

### Decision 5: Name the variant even though there is only one

Naming "Points rummy" while it is the only variant looks redundant. It is not:
the whole reason this change exists is that a player arriving from RummyCircle
expects three variants. Saying which one they are in is what makes the absence
of the others legible instead of feeling broken — and once Phase B lands, the
label is already where it needs to be.

## Risks / Trade-offs

**Phase B is a multi-day feature and must not be quoted as a toggle.** Migration,
Go endpoints, deploy, and match states in a 2000-line board file. The proposal
splits the phases so Phase A is not blocked behind it.

**The backend deploy is blocked in this environment.** The auto-mode classifier
refuses prod writes; `vaultchat-mini-games-pro` records three failed attempts
across two sessions. Phase B's backend half needs the owner or a Bash
permission rule for scp/ssh. Phase A has no such dependency.

**A match spans deals but a table does not.** Players may leave between deals,
and the games server will happily re-seat a table with a different set of
people. The match record must therefore be keyed on the match, with its own
roster, and reconcile against whoever the server actually seats — not assume
the table's seats are the match's players.

**Practice-only limits the appeal.** Pool and Deals arrive without stakes. That
is the honest consequence of Decision 2, and it is better than a format that
quietly charges twice.

## Migration Plan

**Phase A** — client-only, ships in the next APK. No migration, no deploy.

**Phase B** — a migration for the match tables plus a Go deploy, following
`scripts/deploy-games.sh` (pre-flight ledger check, backup, staged copy,
checksum verify, ON_ERROR_STOP, ledger row, container rebuild). Prod ledger is
at 125; the next free number is 126. Clients without the feature keep playing
Points rummy and are unaffected.

## Open Questions

- Does the owner want Pool/Deals at all, given they must be practice-only? That
  is a product call and Phase B should not start before it is answered.
- Deals rummy distributes **chips** at the start, which is a third currency
  beside points and play coins. Are chips per match and discarded after, or do
  they touch the wallet? Practice-only makes "per match, discarded" the obvious
  answer, but it should be stated before it is built.
- With ~19 registered players and typically zero concurrent
  (`vaultchat-mini-games-pro`), a 6-player pool match may never fill. Is a
  bot-filled pool acceptable, or does that make the format pointless?
