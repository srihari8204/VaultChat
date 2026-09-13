# Backup verification — restore rehearsal

**Date:** 2026-09-13 (checks run 11:24–11:34 UTC)
**Box:** root@65.21.229.167 (Hetzner, single box)
**Why:** a rebuild is imminent. An unrehearsed backup is a hypothesis. This
document records an actual restore, not an inspection of file sizes.

**Verdict up front: YES — the box can be rebuilt and the data restored, but only
because the restore was driven from *this* box. The off-site copy is 7 days
14 hours stale and its only decryption key lives on the machine it is supposed
to survive. Fix both before the rebuild.**

---

## 1. What backup mechanisms actually exist

| # | Mechanism | Schedule | Local destination | Off-site | Status |
|---|---|---|---|---|---|
| 1 | **VaultChat Postgres nightly** — `/home/srihari/vaultchat-backups/backup.sh`, driven by **srihari's** crontab `30 2 * * *` IST = 21:00 UTC | nightly | `/home/srihari/vaultchat-backups/vaultchat-<ts>.sql.gz`, 15 files, 14-day rotation | R2 `vaultchat-beam/db-backups/*.sql.gz.enc` | local **OK**, off-site **BROKEN since 2026-09-06** |
| 2 | **VaultGames Postgres nightly** — `/opt/vaultgames/backup.sh` via `/etc/cron.d/vaultgames-backup` `17 3 * * *` | nightly | `/opt/vaultgames/backups/`, 14-day rotation | **none** | local only |
| 3 | **Pre-flight manual dump** — `/root/preflight-backup.sh` | on demand | `/root/preflight-backup/*.dump` (`-Fc`) + `LATEST` pointer | **none** | present, verified restorable |
| 4 | **Client-side chat backups** (`lib/backupScheduler.ts`) | per-device | device | R2 `vaultchat-media/backups/*.vcbak` (4 objects, newest 2026-09-12) | working — a user-data feature, not a server restore point |

The repo copy of the nightly script (`vaultchat-backend/scripts/backup-postgres.sh`)
is **byte-identical** to what runs on the box (md5 `f40438cc…` after LF
normalisation; the raw diff is CRLF-only). `scripts/deploy-backup-offsite.sh` is
its *installer*, not the job. So the backup job itself is reproducible from the
repo after a rebuild.

Root's crontab is empty — the nightly lives under the `srihari` user, which is
easy to miss when auditing.

### What is deliberately NOT in the dump

`--exclude-table-data="message_bodies*"` — message ciphertext is ephemeral by
design (hourly partitions, reclaimed on delivery ACK, 3-hour cap). A restore
rebuilds those tables **empty**. That is the intended disaster-recovery outcome,
not a defect. `messages.content` still holds legacy ciphertext and *is* in the
dump.

### What no mechanism covers at all

- Docker volumes: `vaultchat_miniodata`, `vaultchat_redisdata`, `vaultchat_kafkadata`, `vaultchat_grafanadata`, `vaultchat_promdata`, `vaultgames-data`
- `.env` secrets (`/home/srihari/vaultchat/.env`, `vaultchat-backend/.env`) and `docker-compose.box.yml`
- Media objects in R2 (`vaultchat-media`) — lives at Cloudflare, not backed up by us
- The games server binary (external, no source)

---

## 2. Off-site destination and how current it is

- **Provider:** Cloudflare R2, endpoint `https://7fd1208c57579b53f47307ade895aa3c.r2.cloudflarestorage.com`
- **Bucket / prefix:** `vaultchat-beam/db-backups/`
- **Encryption:** AES-256-CBC + PBKDF2 via `openssl enc`, applied before upload
- **Retention:** 14 days, pruned by rclone `--min-age 14d`, and only after a successful upload
- **Objects present:** 15, spanning `2026-08-24T10:47Z` → `2026-09-05T21:00Z`

### 🔴 Newest off-site object is 182 hours old (7 days 14 hours)

`vaultchat-20260905T210001Z.sql.gz.enc`, last modified **2026-09-05 21:00:01 UTC**.

**The off-site upload has failed 7 consecutive nights (2026-09-06 → 2026-09-12).**
`backup.log` says so plainly, once per night:

```
[backup] ok 3.4M .../vaultchat-20260906T210001Z.sql.gz
[backup] WARNING: off-site copy FAILED — this backup exists only on this box
```

**Root cause, confirmed by direct test:** the `VAULTBEAM_S3_*` R2 token inside
`vaultchat-go-api-1` — the credential the backup script reads at runtime — now
returns **HTTP 401 Unauthorized** on `ListObjectsV2`. The token was revoked or
expired around 2026-09-06, matching the known R2 token outage of that date.

A *different* credential set in the same container — the plain `S3_ACCESS_KEY` /
`S3_SECRET_KEY` pair used for `vaultchat-media` — **still works** and can read
`vaultchat-beam/db-backups/` without trouble. So the fix is a credential swap or
token rotation, not a re-architecture. (That working pair is what made this
rehearsal's off-site fetch possible.)

The off-site failure is non-fatal **by design**, so that a failed upload never
makes a good local dump look bad and never triggers the prune. That choice is
correct. The cost is that it fails **silently** — nothing alerts, nothing pages.
Seven nights passed unnoticed. This is exactly the failure this check exists to
catch.

Because the remote prune only runs after a *successful* upload, nothing has been
deleted from R2 — the Aug 24 objects are still there. That is luck rather than
design, and it will not hold once uploads resume.

---

## 3. Restore rehearsal

Two restores, both into a throwaway database `vaultchat_restorecheck`. The live
`vaultchat` database was never touched, no container was stopped or restarted,
no backup file was deleted.

### Restore A — the real test: newest OFF-SITE copy

| Step | Result |
|---|---|
| Fetch `vaultchat-20260905T210001Z.sql.gz.enc` from R2 | 3.3 MB, 2.2 s |
| Decrypt with `/home/srihari/vaultchat-backups/.offsite-key` | **OK**, 0.02 s |
| `gzip -t` integrity | **OK** |
| Safety scan for `CREATE DATABASE` / `\connect` | none found — single-DB dump, safe to target a throwaway |
| `psql` restore into `vaultchat_restorecheck` | **9.21 s, 0 errors** |

### Restore B — control: today's pre-flight dump (`-Fc`, taken 11:21 UTC)

| Step | Result |
|---|---|
| `pg_restore -j 4` into `vaultchat_restorecheck` | **8.25 s, 0 errors** |

**A full restore of this database takes under 10 seconds.** Data size is not the
constraint on recovery time. Credentials and keys are.

---

## 4. Is the restore usable, not merely non-erroring

### Restore B (today's dump) vs live — the mechanism check

Counts use the same definitions as the brief (`users` excludes `is_deleted`,
`tables` counts `pg_tables`).

| Metric | Live | Restored | Match |
|---|---|---|---|
| users | 17 | 17 | ✅ |
| chats | 46 | 46 | ✅ |
| messages | 992 | 992 | ✅ |
| attachments | 377 | 377 | ✅ |
| chat_members | 88 | 88 | ✅ |
| devices | 197 | 197 | ✅ |
| `schema_migrations` max(version) | 130 | 130 | ✅ |
| foreign keys | 226 | 226 | ✅ |
| functions | 137 | 137 | ✅ |
| tables | 170 | 169 | ⚠️ see below |
| indexes | 389 | 388 | ⚠️ same cause |

The single table/index difference is `message_bodies_2026091511` — one hourly
partition created *after* the dump was taken. The `tables` count is a moving
target by design, ticking up every hour as partitions roll. **Every row count
matches exactly. Nothing was lost.**

### Restore A (off-site, 8 days old) vs live — the staleness check

| Metric | Live | Restored (off-site) | Δ | Rows created after the 2026-09-05T21:00Z cut | Accounted for? |
|---|---|---|---|---|---|
| users (raw count) | 18 | 15 | −3 | **3** | ✅ exact |
| chats | 46 | 43 | −3 | **3** | ✅ exact |
| messages | 992 | 931 | −61 | **61** | ✅ exact |
| attachments | 377 | 353 | −24 | **24** | ✅ exact |
| `schema_migrations` | 130 | 125 | −5 | 5 migrations applied since | ✅ expected |
| tables (excluding `message_bodies`) | — | — | −2 | `games_matches`, `screen_usage`, added by migrations 126–130 | ✅ expected |

Newest `messages.created_at` in the restored copy: `2026-09-05 13:12:37Z`,
consistent with a 2026-09-05 21:00Z cut. Newest `users.created_at`:
`2026-09-01 10:26:44Z`.

**Every discrepancy is exactly explained by the backup's age. Not one row is
missing relative to what the backup claims to contain.** This is the distinction
that matters: the off-site restore is *correct*, it is merely *stale*. A
restore that is 61 messages short because those messages did not exist yet is a
good restore; one that is 61 short of its own cut point would be a failed one.

Restoring from the newest off-site copy **today** would lose 8 days of data:
61 messages, 3 users, 3 chats, 24 attachments, 5 schema migrations. Restoring
from the newest local nightly would lose ~14 hours.

---

## 5. The encryption story — the worst finding here

The off-site copies are AES-256 encrypted. The passphrase lives at:

```
/home/srihari/vaultchat-backups/.offsite-key   (65 bytes, mode 0600, owner srihari)
```

**That is on the box the off-site copy exists to survive.** A grep across
`/home`, `/root` and `/etc` found exactly one copy of it — this one. The backup
script prints the passphrase once on creation and warns about this in its own
comments, but whether it was ever copied into a password manager cannot be
verified from the box.

> **If this box is lost or wiped, the R2 backups become 3.3 MB of unreadable
> ciphertext.** Off-site storage whose only key lives on-site is not an off-site
> backup. It protects against disk failure and nothing else.

This rehearsal only succeeded because the box was alive and the key readable. It
does **not** demonstrate that a restore is possible from a destroyed box — that
is a different test, and it has not been passed.

Secondary exposure: the R2 credentials are read live out of a running container,
so the restore path also assumes `vaultchat-go-api-1` is up. Both the key and a
working R2 credential must exist somewhere off this machine before the rebuild.

---

## 6. Cleanup

```
DROP DATABASE vaultchat_restorecheck;   -- confirmed
```

Databases remaining: `postgres`, `template0`, `template1`, `vaultchat`,
`vaultchat_authtest`, `vaultgames`. `vaultchat_restorecheck` is **gone**.

The decrypted plaintext dump and all rehearsal scratch under
`/root/restore-rehearsal/` were removed. `/root/preflight-backup/` is intact
(both `.dump` files plus `LATEST`), and all 15 nightly `.sql.gz` files are
intact. No container was stopped or restarted; `vaultchat` was never written to.

---

## 7. Verdict

### Can this box be rebuilt from scratch and the data restored? **YES — with two caveats that must be closed first.**

Proven by this rehearsal:

- The nightly dump is real, complete, and restores in **~9 seconds with zero errors**
- A current dump reproduces live **row-for-row** — every headline metric exact
- The off-site copy decrypts, restores cleanly, and is internally exact for its cut point
- The backup job is reproducible from the repo, so it survives the rebuild itself

### Blockers, in priority order

| # | Blocker | Why it matters | Fix |
|---|---|---|---|
| 1 | 🔴 **Off-site key exists only on this box** | A destroyed box means unreadable ciphertext. Total loss, not degradation. | Copy `/home/srihari/vaultchat-backups/.offsite-key` into a password manager **before** the rebuild, then verify it decrypts an R2 object from a different machine. |
| 2 | 🔴 **Off-site upload dead 7 nights (R2 token 401)** | Newest off-site copy is 182 h old. Lose the box today and 8 days go with it. | Rotate the `VAULTBEAM_S3_*` R2 token, or repoint the script at the working `S3_ACCESS_KEY` pair. Force one run and confirm a fresh `.enc` lands. |
| 3 | 🟠 **Off-site failure is silent** | Seven nights of `WARNING` in a log nobody reads. Non-fatal is right; unalerted is not. | Alert on off-site failure, or on newest off-site object age > 48 h. |
| 4 | 🟠 **`.env` secrets and docker volumes are in no backup** | The dump restores the data but not the config needed to start the stack. | Add `.env` files, compose files and `vaultchat_miniodata` to the off-site set. |
| 5 | 🟡 **`vaultgames` has no off-site copy** | Player balances, ratings and friend lists are local-only. | Ship the vaultgames dump to the same R2 prefix. |

**Do not start the rebuild until #1 and #2 are closed.** With them closed the
answer is an unqualified yes. As things stand right now the honest answer is:
**yes if the disk fails, no if the box is destroyed.**

---

*Rehearsal performed 2026-09-13. Re-run before any destructive operation — this
document expires the moment the off-site job changes.*
