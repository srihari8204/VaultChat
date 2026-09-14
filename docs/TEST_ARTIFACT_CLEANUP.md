# Test-run artifact cleanup — 2026-09-14

Inventory and cleanup of the artifacts left on production (`65.21.229.167`,
`vaultchatprod01`) and in Cloudflare R2 by the end-to-end test run of
2026-09-13. Everything below was verified directly, not taken from the
hand-off note.

Production Postgres is the **`vaultchat-postgres-1` container**, not the host
`postgres` package (the host instance holds only `vaultchat_stale_20260722`
and is unrelated). All queries below ran as `vaultchat` inside that container.

---

## 1. What existed

### 1.1 Test user account — **LEFT IN PLACE, needs an operator decision**

| field | value |
|---|---|
| id | `24d4e63a-2773-472b-b588-dc862aefe42e` |
| vault_id | `vba36395d7ef4` |
| created | 2026-09-13 17:54:57Z |
| auth_provider | `google` |
| onboarding_complete | `t` |
| email_verified_at | 2026-09-13 17:54:57Z |
| mpin_hash | present (`argon2id`) |
| external mailbox | `vcdevice-tester2@uberip.com` (disposable, third-party) |

The database has **exactly two users**: this test account and the real device
user `470a57b3-de6e-4908-8f78-c2d4caaa0d62` / `vc17e9bf86935`.

Full reference sweep (every `user_id` / `sender_id` / `created_by` style column
in `public`, counted against this uuid):

| table | rows |
|---|---|
| `refresh_tokens` | 3 |
| `one_time_prekeys` | 20 |
| `messages` | 7 |
| `user_security_questions` | 5 |
| `auth_attempts` | 3 |
| `chats` | 1 (creator) |
| `chat_members` | 1 |
| `identity_keys` | 1 |
| `signed_prekeys` | 1 |

No rows in `devices`, `user_sync_devices`, `security_events`, `attachments`,
`calls`, `stories`. No Redis keys matched the uuid (`dbsize` 10).

### 1.2 Live-risk surface of that account

**All three refresh tokens are unrevoked and valid until 2026-10-13.**

| id | created | expires | revoked_at | user_agent | ip |
|---|---|---|---|---|---|
| 3 | 2026-09-13 17:55:58Z | 2026-10-13 17:55:58Z | *null* | `curl/8.11.0` | 172.20.0.13 |
| 5 | 2026-09-13 18:02:28Z | 2026-10-13 18:02:28Z | *null* | `curl/8.11.0` | 172.20.0.13 |
| 10 | 2026-09-13 18:55:39Z | 2026-10-13 18:55:39Z | *null* | `curl/8.11.0` | 172.20.0.13 |

- **Published key bundle: yes.** One `identity_keys` row, one `signed_prekeys`
  row (key_id 1), **20 unconsumed `one_time_prekeys`**. The account is a live,
  fetchable E2EE peer.
- **Push tokens: none.** `devices` is empty for this user, so there is no push
  fan-out to it.
- **MPIN: disclosed in plain text** in an agent report, and `auth_attempts`
  shows three successful `mpin` logins for this uuid.

Combined: a known MPIN + a live account + three unexpired refresh tokens +
an account recoverable through a **disposable mailbox nobody controls**.
See "Operator to-do" item 1.

### 1.3 Test chat and messages — **LEFT IN PLACE**

Chat `7468ae81-9549-4f78-a870-9808b8648d68`, `direct`, created 2026-09-13
17:56:40Z by the test account. Two members: the test account (`owner`,
`favourite = t`, `unread_count` 1) and the real device user (`member`).

Eight `messages` rows — 7 from the test account (one of which, id 3, is a
`system` row already soft-deleted) and 1 reply from the real device user
(id 8, 18:56:19Z). **`message_bodies` holds zero rows for this chat** — the
delete-on-delivery sweep already purged the ciphertext; only the envelopes
remain.

### 1.4 `otp_codes` — **LEFT IN PLACE**

Five rows total, all with `expires_at` in the past:

| id | email | consumed_at |
|---|---|---|
| 1 | `rebuild-probe@corefinite.com` | *null* — unconsumed probe |
| 2 | `arun.prakash1576@gmail.com` | consumed |
| 3 | `arun.prakash1576@gmail.com` | consumed |
| 4 | `tester2@corefinite.com` | **null — the unconsumed first attempt** |
| 5 | `vcdevice-tester2@uberip.com` | consumed |

Row 4 is the artifact named in the hand-off. Row 1 is a second, unnamed
unconsumed probe row found during this sweep.

### 1.5 R2 write-probe — **DELETED**

`vaultchat-beam/db-backups-writeprobe/.writeprobe.txt`, 47 bytes, written
2026-09-13 12:33:38Z. Content read before deletion, confirming it was a probe:
`r2 write probe Sun Sep 13 12:33:38 PM UTC 2026`.

### 1.6 Scratch databases — **ALREADY GONE**

`pg_database` in the container holds only `postgres`, `template0`,
`template1`, `vaultchat` (17 MB), `vaultgames` (7.8 MB). None of
`vaultchat_authtest`, `vaultchat_restorecheck`, `vaultchat_offsitecheck`
still exist — they were dropped before this pass. Nothing to do.

### 1.7 Scratch roles — **DELETED**

`vaultchat_authapp` and `vaultchat_authsys`, created by
`/root/authtest-run.sh` for the (now-dropped) `vaultchat_authtest` database
with the literal password `authtest_only_not_a_secret`.

### 1.8 `/home/srihari/vaultchat` — **LEFT IN PLACE, and still load-bearing**

550 MB, of which 17 MB is `.git` (HEAD `c9c3f24 feat(shopbook): put the
shop's identity on the bill, and restyle it`). Superseded for deployment by
`/home/srihari/vaultchat-clean` (11 GB, 15 running containers), **but not
retired**: `vaultchat-kafka-1` is a running container whose compose project
working dir is the old tree, with config files

```
/home/srihari/vaultchat/docker-compose.yml,
/home/srihari/vaultchat/docker-compose.prod.yml,
/home/srihari/vaultchat/docker-compose.box.yml
```

`/root/authtest-setup.sh` also `cd`s into
`/home/srihari/vaultchat/vaultchat-backend/migrations`.
`vaultchat-logs.service` and the `srihari` crontab looked like references in a
first grep pass but are false positives — they point at `vaultchat-clean` and
`vaultchat-backups` respectively.

### 1.9 `*.bak-*` files

25 outside Docker internals. Their distribution matters more than their count:

- **18 live inside `/home/srihari/vaultchat`** — the protected tree.
- **~40 more live under `/var/lib/containerd/.../snapshots/`** — Docker image
  layer internals, never to be touched by hand.
- 5 sit outside both. Of those, only **one** met the "has a newer counterpart"
  bar: `/home/srihari/vaultchat-backups/backup.sh.bak-1789302967`.

---

## 2. What was deleted, with confirmation

### 2.1 R2 write-probe prefix

**Deleted:** `R2:vaultchat-beam/db-backups-writeprobe/` (the prefix and its
single 47-byte `.writeprobe.txt`).

**Why safe:** its content is a literal self-describing write probe; it sits
under its own prefix, not under `db-backups/`; nothing reads it —
`backup.sh` writes only to `REMOTE_PREFIX="db-backups"`.

**Confirmed gone.** `rclone lsd R2:vaultchat-beam` now returns one entry:

```
           0 2000-01-01 00:00:00        -1 db-backups
```

**`db-backups/` verified intact: 16 objects**, oldest
`vaultchat-20260824T104718Z.sql.gz.enc`, newest
`vaultchat-20260913T124243Z.sql.gz.enc`. No backup object was touched.

(The `GetBucketVersioning … 403 AccessDenied` line rclone printed is benign —
R2 does not expose that call to this token; rclone fell back to unversioned
and the delete succeeded.)

### 2.2 Scratch roles `vaultchat_authapp`, `vaultchat_authsys`

**Deleted:** both roles.

**Why safe** — each checked before dropping:

- own **0** objects in `vaultchat`, `vaultgames`, `postgres`, `template1`
  (`pg_class` joined against `pg_get_userbyid(relowner)`);
- hold **0** rows in `information_schema.role_table_grants` in any database;
- appear in **no** `pg_default_acl` entry (all three default ACLs name only
  `vaultchat_app` / `vaultchat_sys`);
- appear in **no** `pg_policies` row;
- have **no** `pg_shdepend` rows and **no** `pg_auth_members` membership;
- are **not** in pgbouncer's `userlist.txt` (which lists only `vaultchat`);
- are referenced only by `/root/authtest-*.sh`, two docs, and the preflight
  roles dump.

**Confirmed gone.** `pg_roles` now:

```
    rolname    | rolcanlogin | rolsuper | rolbypassrls
---------------+-------------+----------+--------------
 vaultchat     | t           | t        | t
 vaultchat_app | t           | f        | f
 vaultchat_sys | t           | f        | t
 vaultgames    | t           | f        | f
```

The real staged RLS roles are untouched and keep their intended attributes —
`vaultchat_app` NOBYPASSRLS, `vaultchat_sys` BYPASSRLS.

### 2.3 `/home/srihari/vaultchat-backups/backup.sh.bak-1789302967`

**Deleted:** one file, 7123 bytes, dated 2026-08-24.

**Why safe:** its live counterpart `backup.sh` exists, is newer
(2026-09-13 18:11) and larger (10734 bytes), and is a strict successor — the
`.bak` is the pre-fix version that read the **dead** `VAULTBEAM_S3_*`
credentials killed in the 2026-09-06 R2 token outage, while the live script
reads the working `S3_*` ones. The live script is proven working: the last
`backup.log` line is
`[backup] off-site ok  R2:db-backups/vaultchat-20260913T124243Z.sql.gz.enc`.

**Confirmed gone.** Directory now holds `backup.sh` and `backup.sh.pre-099`
only.

---

## 3. What was deliberately left, and why

| Artifact | Why left |
|---|---|
| Test user `24d4e63a-…`, its 3 refresh tokens, key bundle and 5 security-question rows | Deleting a user rewrites the **real device user's** chat list. Operator's call. |
| Chat `7468ae81-…`, its 2 `chat_members` rows and 8 message envelopes | Same — one of the 8 messages is the real user's own reply. |
| `otp_codes` rows 1 and 4 (unconsumed probes) | Not on the sanctioned safe-delete list, and they die with the account if the operator removes it. Both already expired, so they are inert either way. |
| `/home/srihari/vaultchat` (550 MB, 17 MB `.git`) | Protected — **and genuinely still live**: `vaultchat-kafka-1` runs from its compose files. Deleting it would stop Kafka. |
| 18 `.bak-*` files inside that tree | Deleting files inside the protected tree is partial destruction of the thing being protected. |
| ~40 `.bak-*` paths under `/var/lib/containerd/.../snapshots/` | Docker image layer contents. Hand-editing them corrupts images. |
| `/home/srihari/Caddyfile.bak-20260817T085832Z`, `/home/srihari/golive.yaml.bak-111917`, `/root/docker-compose.prod.yml.bak-games`, `/home/srihari/vaultchat-backups/docker-compose.box.yml.bak-20260812T231122Z` | Each has **no live counterpart** — the `.bak` is the only copy, so it fails the "has a newer counterpart" test. |
| `/home/srihari/vaultchat-backups/backup.sh.pre-099` | `.pre-` not `.bak-*`; out of the sanctioned scope. |
| Everything under `/root/preflight-backup/` (64 MB) | Pre-wipe safety net. Untouched. |
| `vaultchat_app`, `vaultchat_sys` | Real staged RLS roles. Untouched. |
| All 16 objects in `R2:vaultchat-beam/db-backups/` | Never delete a backup object. |
| `/root/authtest-setup.sh`, `/root/authtest-run.sh` | Now orphaned (their database and roles are gone) but harmless, and they document how the RLS rehearsal was run. |

---

## 4. Operator to-do — decisions only a person can make

1. **Revoke the test account before launch. This is the one that matters.**
   Its MPIN is public in an agent report, it has **three unexpired refresh
   tokens** (good until 2026-10-13), a **published key bundle with 20 unused
   one-time prekeys**, and its recovery path runs through
   `vcdevice-tester2@uberip.com` — a **disposable third-party mailbox that
   VaultChat does not control**. Anyone who can read that inbox can drive the
   account's email flows; anyone with the leaked MPIN can authenticate
   directly. Minimum action, which does **not** disturb the real user's chat
   list:

   ```sql
   UPDATE refresh_tokens
      SET revoked_at = now(), revoked_reason = 'test-account cleanup'
    WHERE user_id = '24d4e63a-2773-472b-b588-dc862aefe42e'
      AND revoked_at IS NULL;              -- 3 rows

   UPDATE users
      SET mpin_hash = NULL, discoverable = false
    WHERE id = '24d4e63a-2773-472b-b588-dc862aefe42e';

   DELETE FROM one_time_prekeys
    WHERE user_id = '24d4e63a-2773-472b-b588-dc862aefe42e';   -- 20 rows
   ```

   Do this even if the full deletion in item 2 is deferred.

2. **Decide the fate of the test account and its chat.** Full deletion
   (`users` row + `chats` / `chat_members` / `messages` for
   `7468ae81-…`) removes the conversation from the **real** device user's
   chat list on their next sync. Either accept that, or set `is_deleted`
   on the user and leave the chat — but that is a product decision, not a
   cleanup one.

3. **Retire or keep `/home/srihari/vaultchat`.** It cannot simply be deleted
   while `vaultchat-kafka-1` runs from its compose files. Either move Kafka's
   compose definition into `/home/srihari/vaultchat-clean` and then archive
   the old tree, or accept 550 MB and leave it. Note its `.git` at `c9c3f24`
   is the only history for some of what is in it.

4. **`/root/preflight-backup/irrecoverable/roles.sql` will resurrect the
   scratch roles** — lines 20–23 recreate `vaultchat_authapp` and
   `vaultchat_authsys` with their SCRAM verifiers. If that file is ever
   replayed wholesale, drop those two roles again afterwards. Do not edit the
   safety net to prevent this; just remember it.

5. **Off-site backups have a seven-day hole.** `R2:db-backups/` jumps from
   `vaultchat-20260905T210001Z` straight to `vaultchat-20260913T124243Z` —
   2026-09-06 through 09-12 exist **only on this box**, a consequence of the
   2026-09-06 R2 token outage. `backup.log` shows the matching
   `off-site copy FAILED` warnings. Uploading those local nightlies, or
   accepting the gap, is an operator call.

6. **Four orphan `.bak-*` files have no live counterpart**
   (`Caddyfile.bak-20260817T085832Z`, `golive.yaml.bak-111917`,
   `/root/docker-compose.prod.yml.bak-games`,
   `docker-compose.box.yml.bak-20260812T231122Z`). They are each the only copy
   of that config. Someone who knows whether those configs still matter should
   either fold them into the live tree or delete them.

---

# 5. Revocation executed — 2026-09-13 20:43:34Z

Operator to-do item 1 is **done**. Item 2 (fate of the account and its chat)
is deliberately **still open** — nothing below deletes a `users` row, a chat,
or a message.

## 5.1 Review of the proposed SQL — one gap found

The block in item 1 was checked against the live Go handlers before running.
Three of its effects hold, but it was **incomplete**:

`UPDATE users SET mpin_hash = NULL` alone does **not** neutralise the MPIN.
`POST /auth/security-questions/verify` (`auth.go:1894`) needs only **3 correct
answers out of the 5 stored rows** to mint a `recoveryTicket`, and
`POST /auth/mpin/recover` (`auth.go:1961`) exchanges that ticket for a
**brand-new `mpin_hash` plus a fresh token pair** — silently undoing the null.
`GET /auth/security-questions/{userId}` is unauthenticated, so an attacker is
handed the question codes to answer. A fourth statement was therefore added to
delete the 5 `user_security_questions` rows: with none stored, the handler's
`byCode` map is empty and `correct` is structurally 0 for any input.

Two paths named in the hand-off were checked and found **already dead**, so
nothing was done about them:

- **The disposable mailbox does not yield a session.** `/auth/verify-otp` and
  `/auth/google` both resolve accounts through
  `authFindOrCreateUser` → `WHERE email = $1` (`auth.go:451`), and
  `users.email` is **NULL for both users** (the encrypted-PII onboarding design
  keeps the address in `email_cipher` / `email_lookup`). An OTP to
  `vcdevice-tester2@uberip.com` would create a *separate new* account, not
  re-enter this one.
- **The onboarding path cannot take over either.** `/auth/profile/init`
  returns `409 already_exists` when `email_lookup` matches (`auth.go:1575`).

`revoked_reason = 'test-account cleanup'` was kept as proposed after checking
the 30-second reuse grace in `/auth/refresh` (`auth.go:822-844`): the grace
applies only to `revoked_reason = 'rotated'`, and the legacy `token_lookup IS
NULL` branch (which would have accepted any reason other than `'revoked'` for
30s) cannot match these rows — all 6 carry a non-null `token_lookup`. The
revocation is therefore immediate, with no grace window.

## 5.2 Statements run

One transaction, every statement scoped to the test uuid:

```sql
BEGIN;
UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'test-account cleanup'
 WHERE user_id = '24d4e63a-2773-472b-b588-dc862aefe42e' AND revoked_at IS NULL;   -- UPDATE 6
UPDATE users SET mpin_hash = NULL, discoverable = false, updated_at = now()
 WHERE id = '24d4e63a-2773-472b-b588-dc862aefe42e';                               -- UPDATE 1
DELETE FROM user_security_questions
 WHERE user_id = '24d4e63a-2773-472b-b588-dc862aefe42e';                          -- DELETE 5
DELETE FROM one_time_prekeys
 WHERE user_id = '24d4e63a-2773-472b-b588-dc862aefe42e' AND used_at IS NULL;      -- DELETE 16
COMMIT;
```

**6, not 3, refresh tokens** were revoked: the three from the original test run
plus three minted by this pass's own baseline probes (ids 16-18), which proved
the MPIN was live before it was removed.

`one_time_prekeys` was narrowed to `used_at IS NULL` — the 4 already-consumed
rows are kept so existing session history stays readable. `identity_keys` and
`signed_prekeys` were **left in place**: deleting the identity key would break
the session the real user's client already has pinned to this peer.

## 5.3 Proof, before and after

| check | before | after |
|---|---|---|
| `POST /auth/mpin/verify` with the leaked `739184` | **HTTP 200** + `{accessToken, refreshToken}` | **HTTP 401** `invalid_mpin` |
| `POST /auth/refresh` with a captured token | (token issued) | **HTTP 401** `Invalid refresh token` |
| `POST /auth/security-questions/verify` | 5 answer rows stored | **HTTP 401** `insufficient_answers … (got 0)` |
| `GET /user/24d4e63a-…/keybundle` | `oneTimePreKey: {keyId 5}`, `remainingOtpk: 16` | no session obtainable; 0 unused prekeys in DB |

The 401 on the MPIN is `invalid_mpin`, **not** the `423 locked` rate-limit
response — a genuine credential rejection, not a lockout artifact.

The keybundle could not be re-fetched over HTTP after the change because the
captured access token expired naturally (`token_expired`) and **a new one can
no longer be minted — which is the point of the exercise.** The property is
proven structurally instead: the handler selects
`FROM one_time_prekeys WHERE user_id = $1 AND used_at IS NULL … LIMIT 1`
(`user.go:2413`) and reports `remainingOtpk` from the same predicate, and the
database now holds **0** such rows, so the response can only omit
`oneTimePreKey` and report `remainingOtpk: 0`.

Post-state:

```
 id        | discoverable | has_mpin | live_tokens | unused_otpk | secq
 24d4e63a… | f            | f        | 0           | 0           | 0
 470a57b3… | t            | t        | 1           | 19          | 5
```

## 5.4 The real user is untouched

- **Tokens live.** 1 unrevoked refresh token (id 19, `okhttp/4.12.0`), valid to
  2026-10-13. Its rotation chain (13→14→15→19, all `revoked_reason = 'rotated'`)
  is the client's own normal activity and predates this change.
- **Chat intact.** `7468ae81-…` still exists, `direct`, **2** `chat_members`
  rows, **8** messages. The real user's own row is unchanged
  (`role = member`, `favourite = t`, `unread_count = 0`).
- **Key bundle intact.** 1 `identity_keys` row, 1 `signed_prekeys` row,
  **19** unused one-time prekeys.
- **Their credentials untouched.** `discoverable = true`, `mpin_hash` present,
  5 `user_security_questions` rows — all as before.

One honest note: the **baseline** keybundle fetch in this pass consumed one
one-time prekey from each account (20 → 19 for the real user). That is exactly
what any peer starting a session does, it is not damage, and clients replenish.
All later verification used the database directly and consumed nothing.

## 5.5 Local scratchpad secrets deleted

All under
`…\Temp\claude\c--Users-ADMIN-Desktop-Vaultchat-backup\5f36c7e8-…\scratchpad\`,
each confirmed gone:

| file | held |
|---|---|
| `user2_identity_PRIVATE.json` | the account's **private** keys — `ikPriv`, `signPriv`, `spkPriv`, per-prekey `priv` |
| `user2_bundle.json` | its published public bundle |
| `mkbundle.ts`, `decrypt.ts` | the scripts that generated and used that material |
| `auth.json` | a live access **and** refresh token for the account |
| `tok.txt` | another access token for the account |
| `mpin_before.json` | the token pair captured by this pass's baseline probe |

`auth.json` and `tok.txt` were **not** in the hand-off list and a literal-uuid
grep missed them — the uuid sits base64-encoded inside the JWT payload, not as
text. They were found by decoding every `eyJ…` string in the tree and matching
the `sub` claim. A repeat of that sweep now returns nothing, and no file
outside the app's own binaries holds `ikPriv`/`spkPriv`.

The MPIN `739184` appears in **no** file on disk — it was disclosed in a
report, never written out. Remaining scratch files (`risk*.sql`, `sweep.sql`,
`samples.log`, `stream.log`, task `.output` logs) contain only the account
uuid and vault_id — identifiers already documented above, not credentials — and
were left alone. (`stream.log`'s many "private" hits are Android
`DialerPrivate` logcat noise.) The repo working tree is clean: the `ikPriv` /
`spkPriv` hits in `services/crypto/e2eeSession.ts` are the app's own type
definitions, which is where that JSON shape comes from.

Nothing under `/root/preflight-backup/` was touched.

## 5.6 What is still open

- **Item 2 stands.** The account row, its chat, its 8 messages, its identity
  and signed prekeys, and its `email_lookup` / `*_cipher` PII all remain. The
  account can no longer be logged into or started as a new E2EE session, but it
  still exists and still appears in the real user's chat list — which is the
  intent.
- `otp_codes` rows 1 and 4 remain, both long expired and inert.
- The disposable mailbox `vcdevice-tester2@uberip.com` is still the address
  behind this row's `email_cipher`. Per 5.1 it grants no route back into the
  account, but it should not be reused for future test accounts.
