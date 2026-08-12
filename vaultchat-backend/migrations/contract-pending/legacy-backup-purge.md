# Legacy backup ciphertext — exposure and purge procedure

**PREPARED, NOT EXECUTED.** Nothing below has been run. Deleting backups is
irreversible and is not something to do as a side effect of a migration.

## Exposure, as measured on `vaultchatprod01` (2026-08-12)

| Set | Count | Contains message ciphertext | Rotation |
|---|---|---|---|
| `vaultchat-*.sql.gz` (nightly) | rolling | **Yes**, until 099 soak completes | `KEEP=14` days, automatic |
| `pre-0NN-*.dump` (ad-hoc, pre-migration) | **6** | **Yes — verified** | **None. Retained indefinitely.** |

The six ad-hoc dumps, all taken 2026-08-11/12, total **6.9 MB**:

```
pre-084-086-20260811-1400.dump
pre-088-20260811-1614.dump
pre-089-20260811-1901.dump
pre-090-20260811-1912.dump
pre-091-20260811-1925.dump
pre-092-20260812-023916.dump
```

Each was confirmed to carry `COPY public.messages` blocks — i.e. real message
bodies — by `grep -c "COPY public.messages "`.

**Why they are not covered by the fix already applied.** `backup.sh` now passes
`--exclude-table-data="message_bodies*"`, which bounds *new* ciphertext. It does
nothing for these, because (a) they predate it, and (b) its rotation
(`find -name 'vaultchat-*.sql.gz'`) does not match `*.dump` — these were never
in scope for it and will never age out on their own.

## What is still exposed after the current fix

1. The six ad-hoc dumps above — full message content, no expiry.
2. Every nightly dump still contains `messages.content` for legacy rows, because
   that column exists until `100_drop_messages_content.sql` runs. This
   self-resolves 14 days after the contract migration, as the last dump
   containing the column rotates out.

Item 2 needs no action beyond waiting. Item 1 needs a decision.

## Purge procedure — run only when the preconditions in README.md hold

These dumps are pre-migration safety copies for migrations 084–092, all of which
are long since applied and soaked. Their restore value is now near zero; their
retention value is negative.

**Step 1 — confirm nothing depends on them.** They are recovery points for
schema changes already in production for over a day. If any is still wanted as
a schema reference, extract the schema and discard the data instead:

```bash
# Schema only — no message rows. Keeps the reference, drops the exposure.
for f in ~/vaultchat-backups/pre-*.dump; do
  pg_restore --schema-only -f "${f%.dump}.schema.sql" "$f" 2>/dev/null \
    || zcat "$f" | grep -v '^COPY ' > "${f%.dump}.schema.sql"
done
```

**Step 2 — record exactly what is being destroyed**, so the deletion is
auditable rather than a gap in a directory listing:

```bash
cd ~/vaultchat-backups
sha256sum pre-*.dump | tee purged-$(date -u +%Y%m%dT%H%M%SZ).manifest
ls -l pre-*.dump >> purged-$(date -u +%Y%m%dT%H%M%SZ).manifest
```

**Step 3 — verify a current, valid backup exists first.** Never purge old
copies while the newest one is unverified:

```bash
newest=$(ls -1t ~/vaultchat-backups/vaultchat-*.sql.gz | head -1)
gzip -t "$newest" && zcat "$newest" | grep -c '^CREATE TABLE'   # expect >= 10
```

**Step 4 — delete, explicitly and narrowly.** No globs wider than the target:

```bash
rm -i ~/vaultchat-backups/pre-084-086-20260811-1400.dump \
      ~/vaultchat-backups/pre-088-20260811-1614.dump \
      ~/vaultchat-backups/pre-089-20260811-1901.dump \
      ~/vaultchat-backups/pre-090-20260811-1912.dump \
      ~/vaultchat-backups/pre-091-20260811-1925.dump \
      ~/vaultchat-backups/pre-092-20260812-023916.dump
```

**Step 5 — stop the class of problem recurring.** The ad-hoc dumps exist because
pre-migration snapshots are taken by hand and land outside the rotation. Extend
it to cover them, so the next one expires on its own:

```bash
# in backup.sh, alongside the existing find:
find "$DIR" -name 'pre-*.dump' -mtime +$KEEP -delete
```

## Not covered by any of the above

WAL: `archive_mode=off`, 0 replication slots, 0 standbys, `wal_keep_size=0`,
`checkpoint_timeout=300` — WAL is recycled within roughly ten minutes and is not
a retention vector. Verified, not assumed.

Redis: 9 keys, no ciphertext. Kafka: running, but `EVENT_BUS` is unset for
go-api, so no message payloads are produced to it.
