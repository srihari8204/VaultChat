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
