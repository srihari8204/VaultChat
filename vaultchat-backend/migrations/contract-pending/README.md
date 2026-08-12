# Contract phase — PREPARED, NOT APPLIED

Nothing in this directory has been run, and `migrate.js` does not scan
subdirectories, so nothing here can be applied by an ordinary `migrate.js up`.
Moving a file up one level into `migrations/` is the deliberate act that arms it.

These are the **irreversible** half of the expand/contract migration that
introduced `message_bodies` (migration 099). The expand half is additive and
reversible; everything here destroys data or removes a fallback path.

## Preconditions — ALL must hold before any of this runs

- [ ] `MESSAGE_BODIES=1` has run in production for a full soak window
- [ ] Real-device acceptance tests passed (text, photo, video, file, audio)
- [ ] Multi-device delivery verified with a genuinely offline second device
- [ ] `message_bodies_overdue` has sat at ~0 for the whole soak
- [ ] `partition_drop_blocked_total` is 0 (no partition ever aged out non-empty)
- [ ] No client older than the body-aware build remains in the fleet

The last one is the one that gets skipped. `messages.content` is the fallback
that keeps a pre-cutover client working; dropping it while such clients exist
makes every message they read come back empty.

## Order

1. `900_drop_messages_content.sql` — drops the legacy column
2. Remove the `COALESCE(b.content, m.content)` fallback in
   `internal/routes/chats.go` (`chatsMsgSelBody`) and the `bodiesEnabled()`
   branches in `chats_helpers.go`
3. `legacy-backup-purge.md` — retire dumps containing legacy ciphertext

Step 2 must ship **before** step 1: code that still references a dropped column
fails at query time, not at deploy time.

## Rollback

Step 1 is not reversible. The column can be re-added empty, but its data is
gone — which is the point, and is why the preconditions above are a gate rather
than a checklist to initial.

Steps 2 and 3 are ordinary reverts.
