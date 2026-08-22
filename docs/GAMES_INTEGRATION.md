# VaultGames integration — VaultChat side

Companion to the games-side handover brief. Everything here is a change in
**this** repo; the games server at `https://games.corefinite.com` was already
done for all of it.

> **Status: deployed to production 2026-08-22** (`vaultchatprod01`,
> 65.21.229.167). Items 1 and 3 are live and verified against
> `api.corefinite.com`. Item 2 has every precondition proven and one command
> left to run. Item 4 is decided, with nothing to build.
>
> Still outstanding: **the Android APK**. The notification handler is native
> Kotlin, so until a new build ships, `/games/notify` accepts and forwards
> events that phones will ignore.
>
> Both the games server and VaultChat run on the **same host** — `/opt/vaultgames`
> and `/home/srihari/vaultchat` — which is worth knowing before reasoning about
> blast radius.

---

## 1. Real display names in game lobbies — DONE

**Symptom.** Every player who launched a game from inside VaultChat appeared in
the games database as their vaultId — `v337da54a1d30`, `vb2770fa1e774` — and
that string is what showed in lobbies, leaderboards and "your turn" pushes.

**The brief's diagnosis did not apply to this codebase.** It pointed at
`user.displayName || user.vaultId` in the TypeScript route and concluded the
auth middleware was not populating `req.user.displayName`. What actually runs is
the **Go** port, which never reads `req.user.displayName` at all — it queried the
database directly:

```sql
SELECT COALESCE(vault_id,''), COALESCE(name,'') FROM users WHERE id = $1
```

**Real root cause.** `users.name` is the *legacy* plaintext column and it is NULL
for every account created through vault onboarding — those write
`first_name_cipher` / `last_name_cipher` and nothing else. So `COALESCE(name,'')`
returned `''` for effectively every player and the fallback shipped the vaultId
as the display name. Fixing the middleware would have changed nothing.

This is the same trap that made every incoming call ring as "VaultChat user";
`callerIdentity` in `calls.go` carries a long note about it.

**Fix.** `gamesLaunchToken` now resolves the name through `vault.IdentityFromRow`
— the same path the chat member list and the ops screens use — with
`users.name` kept as the fallback for legacy Google/phone accounts.

**Scale of it, measured on production after deploying:**

```
with_vaultid | legacy_name_empty | has_name_cipher | fixed_by_this_change | still_falls_back
          11 |                11 |              11 |                   11 |                0
```

Every single account holding a VaultID had an empty `users.name`, so the old
code shipped a hex id for **100% of players**, not just the seven the brief
happened to spot. All 11 have name ciphers, so all 11 are fixed and none still
fall back.

**Verify.** Launch a game from the app; the lobby shows a name, not a hex id.
Existing players are renamed by the games server on their next launch, since the
name rides in the launch token.

---

## 2. The games host's copy of the launch-token private key — READY, NEEDS YOU

`/opt/vaultgames/keys/ed25519.key` on the games host is the **private**
launch-token signing key. It should only ever exist on the VaultChat side.

**Every precondition has been checked on the live host. All pass:**

| # | check | result |
|---|---|---|
| 1 | `secrets/games-signing.key` derives to the public key of record | **OK** |
| 2 | `/opt/vaultgames/keys/ed25519.key` derives to the *same* key — a duplicate, not a distinct key | **OK** |
| 3 | the `go-api` container has that key mounted and readable at `/run/secrets/games-signing.key` | **OK** |
| 4 | the running games server does not read it | **OK** — `config.go:100` reads it only `if dev`, prod runs dev off, and the container mounts only `/data`, so the keys directory is not even visible to it |

So the copy is provably redundant and deleting it cannot break launches. What
remains is one destructive command:

```bash
shred -u /opt/vaultgames/keys/ed25519.key
```

`ed25519.pub` **stays** — the games server needs the public half to verify
launch tokens.

`scripts/games-key-check.sh` performs the same checks and then the deletion in
one step (`--shred`), refusing if any check fails. Both of its failure paths
(missing key, mismatched key) were exercised.

**One caveat worth acting on separately:** both copies live on the same physical
disk on the same host. Deleting the games-host copy reduces *exposure* — a
compromise of the games app no longer yields a signing key — but it does not
improve durability. There is no off-box backup of
`/home/srihari/vaultchat/secrets/games-signing.key`. Make one.

**Rotation** is still worth doing — the private half has been sitting on a
second machine — but it is a separate exercise: generate a new pair on this
side, hand over the new public key for `VAULTCHAT_GAMES_PUBLIC_KEY_PEM`, and
swap at a quiet hour, because tokens in flight (15-minute TTL) fail during the
change.

---

## 3. `POST /games/notify` + `POST /games/device-token` — DONE

The unlock for asynchronous play. Both live in
`vaultchat-backend-go/internal/routes/games_notify.go` and are registered from
`RegisterGames`.

### `POST /games/notify` — unauthenticated, signature-verified

The caller is a server with no VaultChat session, so the EdDSA signature *is*
the authentication. Verified against `GAMES_NOTIFY_PUBLIC_KEY_FILE` — a
**second, separate** keypair from the launch-token one.

| check | behaviour |
|---|---|
| bad/absent signature | `401`, nothing sent |
| non-EdDSA `alg` (e.g. HS256 forgery) | `401` — `WithValidMethods` |
| missing `exp` | `401` — `WithExpirationRequired`, so a no-exp token cannot replay forever |
| expired | `401` |
| `jti` already seen | `200 {deduped:true}` so the games server stops retrying |
| unknown/deleted recipient | `200 {delivered:false, reason:"unknown_recipient"}` |
| recipient has no device | `200 {delivered:false, reason:"no_device_token"}` |
| not configured | `503` — retry later is correct |
| push transport failed | `502`, and the `jti` claim is **released** so the retry is not swallowed |

`jti` dedupe is a Postgres primary key, not an in-memory set — retries are
exactly the situation where the process may have restarted. The row is claimed
*before* the push and released if the push fails, the same claim/release shape
`golive_webhook.go` uses for egress restarts.

`game` and `room` are validated as `[A-Za-z0-9_-]{1,64}` on the way in and again
in the app. They are interpolated into a URL; the WebView's origin allowlist is
the second line of defence and must not be the only one.

Title and body cross Google's servers in the clear — a deliberate difference
from chat push, which carries only a `chatId`. Game state is not end-to-end
encrypted anywhere; it lives in plaintext on the games server by design, so
there is no VaultChat secret here for content-free delivery to protect.

### `POST /games/device-token` — auth required

`{fcmToken, platform, unregister?}`. It shares `registerFcmDevice` with
`POST /call/token` rather than owning a second upsert, so a phone registered for
calls and for games holds **one** `devices` row and gets **one** copy of
everything. Unregister is scoped to the caller's own rows.

In practice the app already registers at startup via `registerForCalls`, so
games push works without the client calling this at all — it exists so the games
mini-app can register and revoke on its own.

### The tap lands on the table

```
games server → POST /games/notify → FCM data-only (type:"games_turn")
  → VaultCallMessagingService.showGameTurn        (notification, Games channel)
  → CallModule.getInitialCallIntent → action "open_game" + game/room
  → app/_layout.tsx → router.push('/games', {game, room})
  → app/games.tsx → https://games.corefinite.com/<game>.html?room=<room>
```

Not suppressed in the foreground, unlike chat notifications: the games server
already refuses to notify a player currently connected to it, so a push that
arrives is by definition for someone not looking at that table.

Notification channel is `IMPORTANCE_DEFAULT`, not HIGH — a turn in an
asynchronous board game does not deserve a heads-up banner. Tagged by room, so
two waiting games are two lines and a repeat nudge replaces rather than stacks.

---

## 4. Should games coins be real VaultChat coins? — DECIDED: NO, leave as-is

**Nothing was built for this, on purpose.** The decision is the deliverable.

Today the games server owns its own balance, every player starts at 1000, and
the hub says plainly that coins are demo-only and not real money. That is
already correct and already honest, which is the bar the brief itself set for
this option.

Reasons not to wire the wallet:

- **It is a legal question, not an engineering one.** Real-money gaming in India
  sits under state-level prohibitions, the central online-gaming rules, and 28%
  GST on full face value of deposits. That call is not one to make by mounting a
  webhook, and doing so would create the exposure before anyone had assessed it.
- **Nothing is blocked.** No feature is waiting on it. The brief lists it as a
  decision precisely because the platform works without it.
- **It is the irreversible direction.** Demo coins can become real coins later.
  Real balances that have to be unwound are a refund exercise.

If you overrule this, the shape is already sketched in the games repo's
`gamesRoutes.ts` as `POST /games/coin-webhook`, and it needs all three of:
verify the games server's signature (an unsigned balance update must never be
trusted), dedupe on the result id, and a legal position on RMG **before** it
ships rather than after. Say the word and I will build it.

---

## What was deployed, and how

Prod's checkout at `/home/srihari/vaultchat` is a hand-managed working tree: its
git HEAD is 167 commits behind `origin/hetzner-deploy` while the *files* are
current, so 185 paths show as dirty that are not hand-edits. Before touching
anything it was confirmed that **no `.go` file was newer than the running
image** — i.e. the container was built from exactly that tree — so a rebuild
would ship only this change and nothing else riding along.

1. **Backed up** the files being replaced to
   `/root/vc-backups/games-integration-20260822-121956/`, with the outgoing
   image id.
2. **Copied** the five Go files, migration 115, and `docker-compose.prod.yml`
   (verified byte-identical to prod's copy first, so it added only the two new
   lines), normalising CRLF on arrival.
3. **Installed the notify key** from the games server's own
   `/opt/vaultgames/keys/notify.pub` rather than transcribing it — it matches
   the brief exactly. `600`, owned by `srihari`.
4. **Applied migration 115.** `pg`/`dotenv` are not installed on prod, so
   `migrate.js` cannot run there; instead the DDL and its ledger row were
   applied in **one transaction**, with the checksum recomputed on the host to
   confirm the transferred bytes matched (`d475f2d474d2ea72`). The ledger now
   reads `115 | 115_games_notify_seen.sql | d475f2d474d2ea72`, exactly what
   `migrate.js` would have written.
5. **Rebuilt and restarted** `go-api`. Boot log shows
   `[jobs] sweep-games-notify-seen every 5m0s` and
   `[fcm] enabled=true project=vaultchatprod01`.

### Verified on production

The dedupe guarantee, proved against the real schema (rolled back, no residue):

```
INSERT 0 1      -- first delivery
INSERT 0 0      -- same jti again: no row, which is what RowsAffected keys off
rows stored for a twice-delivered jti: 1
```

The route, exercised through `https://api.corefinite.com/games/notify` with
events signed by the games server's **real** notify private key — so this is the
same signature path a live turn takes, not a mock. A non-existent recipient was
used so no real player was buzzed:

```
PASS  route is mounted (not 404)                 → 400 {"error":"event required"}
PASS  valid signature accepted                   → 200 {"delivered":false,"reason":"unknown_recipient"}
PASS  replay of same jti is deduped              → 200 {"deduped":true}
PASS  expired event rejected                     → 401
PASS  event with no exp rejected                 → 401
PASS  tampered signature rejected                → 401
PASS  event from an unknown signer rejected      → 401
```

The games server logs confirm the other side is pointed at it:
`push notifications enabled webhook=https://api.corefinite.com/games/notify`.

### Still to do

- **Build and install the APK.** Native Kotlin, so it needs a prebuild; a JS-only
  update will not carry it. Until then `/games/notify` reports `delivered:true`
  and the handset ignores the unknown `type`.
- **`shred -u /opt/vaultgames/keys/ed25519.key`** — §2, all checks green.
- **Back up the surviving signing key off-box.**
- **The human end-to-end test:** start a game between two accounts, move, and
  confirm the other phone gets a notification whose tap opens *that* table. Then
  tell the games side.
- **Commit this work** — prod is running files that are not yet committed here,
  which is how the 167-commit drift happened in the first place.
