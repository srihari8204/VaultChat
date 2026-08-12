// Package jobs — the periodic background jobs that lived in Node's server.js,
// ported so a Go-only prod (Node API decommissioned) loses nothing:
//
//   - expired-messages sweep   (disappearing messages hard-delete, 5 min)
//   - delete-on-delivery       (env-gated DELETE_ON_DELIVERY, 5 min)
//   - media retention          (purge delivered/TTL attachment bytes, 5 min)
//   - scheduled-messages       (claim + insert + fan-out, 30 s)
//   - expired-stories sweep    (24 h TTL, 5 min)
//
// (The VaultBeam relay sweep already runs from main.go.) SQL is verbatim from
// server.js; cadences and env knobs identical. Each job also fires once at
// boot, like Node, so long downtime doesn't leave stale content visible.
package jobs

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/storage"
)

const sweepInterval = 5 * time.Minute
const schedInterval = 30 * time.Second

// Expiry runs far more often than the other sweeps. Those trim things that are
// merely stale; this one enforces a stated retention guarantee, and the promise
// is "three hours", not "three hours give or take the sweep interval". One
// minute keeps the observable overshoot inside a rounding error while still
// being a trivial query — it is an index-free scan of a table that ACK deletion
// has usually already emptied.
const bodySweepInterval = time.Minute

func envInt(k string, def int) int {
	if v, ok := httpx.ParseIntPrefix(os.Getenv(k)); ok {
		return int(v)
	}
	return def
}

// StartAll launches every job. ctx cancellation stops them (process lifetime).
func StartAll(ctx context.Context) {
	run := func(name string, every time.Duration, f func(context.Context)) {
		go func() {
			f(ctx) // boot kick, like Node
			t := time.NewTicker(every)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					f(ctx)
				}
			}
		}()
		log.Printf("[jobs] %s every %s", name, every)
	}

	run("sweep-expired-messages", sweepInterval, sweepExpiredMessages)
	run("media-retention", sweepInterval, sweepDeliveredAttachments)
	run("sweep-expired-stories", sweepInterval, sweepExpiredStories)
	// Broadcast recordings had no lifecycle at all — see sweepEndedBroadcasts.
	run("broadcast-retention", sweepInterval, sweepEndedBroadcasts)
	run("scheduled-messages", schedInterval, sweepScheduledMessages)

	// Keep the message_bodies partition window ahead of the clock. Creation
	// only — see partitions.go for why dropping is not in this file yet.
	StartPartitionMaintenance(ctx)
	RegisterPartitionGauge()
	// Unknown-purpose objects are never deleted (by design). Surface them, or
	// "safe to retain" turns into unbounded storage nobody is looking at.
	RegisterAttachmentPurposeGauges()
	if os.Getenv("DELETE_ON_DELIVERY") == "true" {
		log.Println("[delete-on-delivery] ENABLED")
		run("delete-on-delivery", sweepInterval, sweepDeliveredMessages)
		// The body-store twin of the same rule. Runs under the SAME flag because
		// it is the same policy applied to the new storage location — enabling
		// one and not the other would leave whichever store is live unreclaimed.
		run("delete-on-delivery-bodies", sweepInterval, sweepDeliveredBodies)
	}

	// The hard ceiling, independent of delivery and independent of the flag
	// above. ACK deletion is an OPTIMISATION — it reclaims early. This is the
	// GUARANTEE, and it must hold even if nothing is ever acknowledged, so it is
	// deliberately not gated on DELETE_ON_DELIVERY.
	//
	// Why a bounded DELETE and not DROP PARTITION alone: an hourly partition
	// [H, H+1) holds bodies whose deadlines are spread across that hour, so the
	// partition only becomes wholly reclaimable at H+4h. Waiting for that would
	// let the earliest body in each partition live up to four hours — a real
	// breach of a three-hour promise. So expiry is enforced to the second by
	// this sweep, and the partition drop below reclaims the space afterwards.
	// The sweep stays cheap precisely because ACK deletion has usually emptied
	// the rows before it arrives.
	run("expire-bodies", bodySweepInterval, sweepExpiredBodies)
	run("drop-body-partitions", sweepInterval, DropExpiredPartitions)
}

// ── disappearing messages ──────────────────────────────────────────────

// P4.1: sweeps used to be single unbounded statements — one DELETE holding
// row locks (and bloating one WAL burst) for however many rows had expired.
// batchedSweep runs the statement in bounded batches (ctid subselect) with a
// per-tick iteration cap, so a huge backlog is trimmed across ticks instead
// of locking the table in one shot.
const sweepBatch = 5000
const sweepMaxIters = 10

func batchedSweep(ctx context.Context, name, batchSQL string) {
	var total int64
	for i := 0; i < sweepMaxIters; i++ {
		tag, err := db.SysPool.Exec(ctx, batchSQL, sweepBatch)
		if err != nil {
			log.Printf("[%s] failed: %v", name, err)
			return
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < sweepBatch {
			break // backlog drained
		}
	}
	if total > 0 {
		log.Printf("[%s] swept %d row(s)", name, total)
	}
}

func sweepExpiredMessages(ctx context.Context) {
	batchedSweep(ctx, "sweep",
		`DELETE FROM messages
		  WHERE ctid IN (SELECT ctid FROM messages
		                  WHERE expires_at IS NOT NULL AND expires_at <= NOW()
		                  LIMIT $1)`)
}

// ── delete-on-delivery (WhatsApp model; env-gated) ─────────────────────

func sweepDeliveredMessages(ctx context.Context) {
	grace := envInt("DELETE_ON_DELIVERY_GRACE_SEC", 120)
	maxDays := envInt("DELETE_ON_DELIVERY_MAX_AGE_DAYS", 0)
	// How long a device may be silent before the sweep stops waiting for it.
	// Too low destroys messages for someone on holiday; too high lets one
	// retired handset pin an account's history on the server indefinitely.
	staleDays := envInt("DELETE_ON_DELIVERY_DEVICE_STALE_DAYS", 30)
	// P4.1: batched like the other sweeps — the one-shot UPDATE rewrote every
	// eligible row in a single statement (lock + WAL burst scaling with backlog).
	var purged int64
	for i := 0; i < sweepMaxIters; i++ {
		tag, err := db.SysPool.Exec(ctx,
			`UPDATE messages m
			    SET content = NULL
			  WHERE m.ctid IN (
			    SELECT m2.ctid FROM messages m2
			     WHERE m2.content IS NOT NULL
			       AND m2.deleted_at IS NULL
			       AND m2.created_at < NOW() - ($1 || ' seconds')::interval
			       AND EXISTS (
			         SELECT 1 FROM chat_members o
			          WHERE o.chat_id = m2.chat_id AND o.left_at IS NULL AND o.user_id <> m2.sender_id
			       )
			       AND NOT EXISTS (
			         SELECT 1 FROM chat_members cm
			          WHERE cm.chat_id = m2.chat_id
			            AND cm.left_at IS NULL
			            AND cm.user_id <> m2.sender_id
			            AND (cm.last_delivered_message_id IS NULL OR cm.last_delivered_message_id < m2.id)
			       )
			       -- ...and no ACTIVE DEVICE of any other member is behind it.
			       -- The account-level check above is not sufficient on a
			       -- multi-device account: the first device to ack advances the
			       -- shared pointer, and nulling the body here would destroy a
			       -- message a second device never received. Devices that have
			       -- not synced within the staleness window are ignored, or a
			       -- lost/sold handset would pin history on the server forever.
			       AND NOT EXISTS (
			         SELECT 1
			           FROM chat_members cm2
			           JOIN user_sync_devices usd ON usd.user_id = cm2.user_id
			           LEFT JOIN chat_device_delivery cdd
			                  ON cdd.chat_id = m2.chat_id
			                 AND cdd.user_id = cm2.user_id
			                 AND cdd.device_id = usd.device_id
			          WHERE cm2.chat_id = m2.chat_id
			            AND cm2.left_at IS NULL
			            AND cm2.user_id <> m2.sender_id
			            AND usd.last_sync_at > NOW() - ($3 || ' days')::interval
			            AND (cdd.last_delivered_message_id IS NULL OR cdd.last_delivered_message_id < m2.id)
			       )
			     LIMIT $2)`, strconv.Itoa(grace), sweepBatch, strconv.Itoa(staleDays))
		if err != nil {
			log.Printf("[delete-on-delivery] failed: %v", err)
			return
		}
		purged += tag.RowsAffected()
		if tag.RowsAffected() < sweepBatch {
			break
		}
	}
	if maxDays > 0 {
		for i := 0; i < sweepMaxIters; i++ {
			t2, err := db.SysPool.Exec(ctx,
				`UPDATE messages SET content = NULL
				  WHERE ctid IN (SELECT ctid FROM messages
				                  WHERE content IS NOT NULL AND deleted_at IS NULL
				                    AND created_at < NOW() - ($1 || ' days')::interval
				                  LIMIT $2)`, strconv.Itoa(maxDays), sweepBatch)
			if err != nil {
				break
			}
			purged += t2.RowsAffected()
			if t2.RowsAffected() < sweepBatch {
				break
			}
		}
	}
	if purged > 0 {
		log.Printf("[delete-on-delivery] purged %d delivered message bodies", purged)
	}
}

// ── ephemeral body reclaim (migration 099) ─────────────────────────────

// sweepDeliveredBodies is delete-on-delivery for the body store.
//
// The multi-device safety condition is COPIED VERBATIM from
// sweepDeliveredMessages below — same three layers, same staleness window:
//
//	chat_members.last_delivered_message_id   account-level pointer
//	chat_device_delivery                     per-DEVICE pointer (migration 078)
//	user_sync_devices.last_sync_at           ignores lost/sold handsets
//
// Reproducing rather than re-deriving it is deliberate. The rule is subtle and
// was already got wrong once: on a multi-device account the first device to ack
// advances the shared pointer, so an account-level check alone destroys a body
// a second device never received. Any change here must be made in both places.
//
// The difference from the legacy sweep is only the verb: that one NULLs a
// column and leaves the old heap tuple holding ciphertext until autovacuum;
// this DELETEs the row, and its partition is dropped whole later. The bytes
// actually go.
func sweepDeliveredBodies(ctx context.Context) {
	grace := envInt("DELETE_ON_DELIVERY_GRACE_SEC", 120)
	staleDays := envInt("DELETE_ON_DELIVERY_DEVICE_STALE_DAYS", 30)
	var purged int64
	for i := 0; i < sweepMaxIters; i++ {
		tag, err := db.SysPool.Exec(ctx,
			`DELETE FROM message_bodies b
			  USING messages m
			  WHERE b.message_id = m.id
			    AND b.created_at = m.created_at
			    AND m.created_at < NOW() - ($1 || ' seconds')::interval
			    AND EXISTS (
			      SELECT 1 FROM chat_members o
			       WHERE o.chat_id = m.chat_id AND o.left_at IS NULL AND o.user_id <> m.sender_id
			    )
			    AND NOT EXISTS (
			      SELECT 1 FROM chat_members cm
			       WHERE cm.chat_id = m.chat_id
			         AND cm.left_at IS NULL
			         AND cm.user_id <> m.sender_id
			         AND (cm.last_delivered_message_id IS NULL OR cm.last_delivered_message_id < m.id)
			    )
			    AND NOT EXISTS (
			      SELECT 1
			        FROM chat_members cm2
			        JOIN user_sync_devices usd ON usd.user_id = cm2.user_id
			        LEFT JOIN chat_device_delivery cdd
			               ON cdd.chat_id = m.chat_id
			              AND cdd.user_id = cm2.user_id
			              AND cdd.device_id = usd.device_id
			       WHERE cm2.chat_id = m.chat_id
			         AND cm2.left_at IS NULL
			         AND cm2.user_id <> m.sender_id
			         AND usd.last_sync_at > NOW() - ($3 || ' days')::interval
			         AND (cdd.last_delivered_message_id IS NULL OR cdd.last_delivered_message_id < m.id)
			    )
			    AND b.ctid IN (SELECT ctid FROM message_bodies LIMIT $2)`,
			strconv.Itoa(grace), sweepBatch, strconv.Itoa(staleDays))
		if err != nil {
			log.Printf("[delete-on-delivery-bodies] failed: %v", err)
			return
		}
		purged += tag.RowsAffected()
		if tag.RowsAffected() < sweepBatch {
			break
		}
	}
	if purged > 0 {
		metrics.Add("messages_deleted_on_ack_total", uint64(purged))
		log.Printf("[delete-on-delivery-bodies] reclaimed %d body(ies)", purged)
	}
}

// sweepExpiredBodies enforces the hard ceiling. No delivery condition, no
// exceptions: past body_expires_at the ciphertext goes, acknowledged or not.
//
// This is the statement that makes the three-hour promise true. Everything else
// in this file reclaims EARLIER than it; nothing may reclaim later.
func sweepExpiredBodies(ctx context.Context) {
	var purged int64
	for i := 0; i < sweepMaxIters; i++ {
		tag, err := db.SysPool.Exec(ctx,
			`DELETE FROM message_bodies
			  WHERE ctid IN (SELECT ctid FROM message_bodies
			                  WHERE body_expires_at <= NOW()
			                  LIMIT $1)`, sweepBatch)
		if err != nil {
			metrics.Inc("message_expiration_failures_total")
			log.Printf("[expire-bodies] failed: %v", err)
			return
		}
		purged += tag.RowsAffected()
		if tag.RowsAffected() < sweepBatch {
			break
		}
	}
	if purged > 0 {
		metrics.Add("messages_expired_total", uint64(purged))
		log.Printf("[expire-bodies] expired %d body(ies)", purged)
	}
}

// ── broadcast recordings ───────────────────────────────────────────────

// sweepEndedBroadcasts reclaims HLS segments for broadcasts that ended long
// enough ago.
//
// Nothing reclaimed them before — not by oversight exactly, but because they
// were unreachable: segments live in BROADCAST_BUCKET with no row in
// `attachments`, and every storage-deleting job enumerates `FROM attachments`.
// So every 4-second segment of every broadcast ever made was retained forever,
// on the box that also runs Postgres. That is an unbounded disk leak
// independent of the privacy problem, and it grows fastest exactly when the
// product is working.
//
// Driven by ended_at, NOT by the end of the stream: deleting at broadcastEnd
// would destroy replay the instant a host stops. The window is what decides how
// long a recording stays watchable, so it is a product knob with a
// conservative default rather than a constant.
func sweepEndedBroadcasts(ctx context.Context) {
	days := envInt("BROADCAST_RETENTION_DAYS", 30)
	if days <= 0 {
		return // 0 disables reclaim entirely — keep recordings forever
	}
	rows, err := db.SysPool.Query(ctx,
		`SELECT id::text FROM broadcast_sessions
		  WHERE ended_at IS NOT NULL
		    AND ended_at < NOW() - ($1 || ' days')::interval
		    AND segments_purged_at IS NULL
		  LIMIT 100`, strconv.Itoa(days))
	if err != nil {
		// The column arrives with migration 101; before that this is a no-op
		// rather than a log line every five minutes.
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	purged := 0
	for _, id := range ids {
		// Prefix delete: segments are <id>/index.m3u8 and <id>/segment*.
		storage.DeleteBroadcastPrefix(ctx, id+"/")
		if _, err := db.SysPool.Exec(ctx,
			`UPDATE broadcast_sessions SET segments_purged_at = NOW() WHERE id = $1::uuid`,
			id); err == nil {
			purged++
		}
	}
	if purged > 0 {
		metrics.Add("broadcast_segments_purged_total", uint64(purged))
		log.Printf("[broadcast-retention] purged segments for %d ended broadcast(s)", purged)
	}
}

// ── media retention ────────────────────────────────────────────────────

func uploadDir() string {
	if d := os.Getenv("UPLOAD_DIR"); d != "" {
		return d
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, "uploads")
}

// mediaHardTTL is the ceiling on how long an encrypted media object may sit in
// object storage.
//
// WHY THREE HOURS IS COHERENT HERE, NOT ARBITRARY
// -----------------------------------------------
// A media blob is useless without its per-file AES key, and that key does not
// live beside it: lib/sendMedia packs it into the message CONTENT, which the
// Double Ratchet encrypts and which now expires with message_bodies. So once a
// message body is reclaimed, any recipient who had not already received it can
// never decrypt the blob — the object is ciphertext nobody holds a key for.
// Keeping it for another fourteen days protects nothing and stores everything.
//
// WHAT IT COSTS, SAID PLAINLY
// ---------------------------
// A recipient who received the message (and therefore the key) but has NOT yet
// downloaded the bytes — auto-download off, on mobile data, a large video —
// loses the ability to tap-to-download after the deadline. That is a real
// behaviour change, not a free win, and it is the direct consequence of the
// requirement that no server-side encrypted copy outlive three hours.
//
// The early-purge path is unchanged and still does most of the work: an object
// whose recipients have all downloaded it is removed immediately, long before
// this deadline is reached.
func mediaHardTTL() time.Duration {
	if v, ok := httpx.ParseIntPrefix(os.Getenv("MEDIA_TTL_HOURS")); ok && v > 0 {
		if d := time.Duration(v) * time.Hour; d < 3*time.Hour {
			return d // may only TIGHTEN, never extend — same asymmetry as bodyTTL
		}
	}
	return 3 * time.Hour
}

func sweepDeliveredAttachments(ctx context.Context) {
	// Legacy window stays in force until bodies are enabled, so a deployment
	// with the flag off behaves exactly as it does today. Turning MESSAGE_BODIES
	// on switches media onto the same three-hour ceiling as the text it
	// accompanies — the two must move together, or the key expires while the
	// blob it unlocks lingers for a fortnight.
	// TWO CUTOFFS, AND THE DIFFERENCE IS LOAD-BEARING.
	//
	// `attachments` is NOT a chat-only table. Profile avatars
	// (app/(tabs)/profile.tsx, lib/onboarding.ts), story media, and every
	// mini-app upload go through the same routes/uploads.go path and land in
	// the same table. The only thing that makes a row "chat media" is a message
	// somewhere referencing it via meta->>'attachmentId'.
	//
	// The chat-retention cutoff must therefore apply ONLY to rows that are
	// actually chat media. Without that scoping, turning on the body store
	// would have applied a THREE HOUR ttl to every avatar on the service —
	// every user's profile photo deleted three hours after upload, by a job
	// whose name says "media retention" and whose intent was chat.
	//
	// So:
	//   chatCutoff  — short (3h with bodies on): only for message-referenced rows
	//   orphanCutoff— the long legacy window: everything else, unchanged
	//
	// Orphan cleanup is deliberately left exactly as it was. It is what reclaims
	// an upload that was never sent, and narrowing it here would trade a data-loss
	// bug for a storage leak.
	chatCutoff := strconv.Itoa(envInt("MEDIA_TTL_DAYS", 14)) + " days"
	if bodyStoreEnabled() {
		chatCutoff = strconv.FormatInt(int64(mediaHardTTL()/time.Second), 10) + " seconds"
	}

	// PURPOSE-AWARE. The question is no longer "does a message reference this
	// object" — that is a side effect, not a purpose, and inferring retention
	// from it failed in BOTH directions (migration 100 documents the two live
	// bugs). Each class now answers for itself:
	//
	//   chat      chat-media retention: delivered-to-everyone, else the cutoff
	//   story     survives until the STORY expires; sweepExpiredStories deletes
	//             the story row, and only then is the object reclaimable
	//   profile   until the user changes or deletes it — never by age
	//   group     until the group photo changes or is deleted — never by age
	//   mini_app  the mini-app's own lifecycle — never here
	//   unknown   NEVER. Kept and surfaced, never destroyed.
	//
	// profile/group/mini_app/unknown are absent from this statement entirely.
	// That is deliberate: a class this job does not name cannot be deleted by
	// it, so the failure mode of forgetting a class is retention, not loss.
	rows, err := db.SysPool.Query(ctx,
		`SELECT a.id, a.storage_path, a.storage_backend
		   FROM attachments a
		  WHERE a.purged_at IS NULL
		    AND a.storage_path IS NOT NULL
		    AND (
		      -- CHAT: delivered to every eligible recipient → reclaim early.
		      (a.purpose = 'chat'
		        AND (SELECT COUNT(*) FROM attachment_deliveries d WHERE d.attachment_id = a.id) > 0
		        AND (SELECT COUNT(*) FROM attachment_deliveries d WHERE d.attachment_id = a.id)
		            >= (SELECT COUNT(DISTINCT cm.user_id)
		                  FROM messages m
		                  JOIN chat_members cm ON cm.chat_id = m.chat_id
		                                      AND cm.left_at IS NULL
		                                      AND cm.user_id <> a.owner_user_id
		                 WHERE m.meta->>'attachmentId' = a.id::text))
		      -- CHAT: past the chat-retention window regardless of delivery.
		      OR (a.purpose = 'chat' AND a.created_at < NOW() - $1::INTERVAL)
		      -- STORY: only once the story it belongs to is gone. The story
		      -- row carries the authoritative expiry (24h) and is removed by
		      -- sweepExpiredStories; until then this object must survive, which
		      -- is why age alone can never make it eligible.
		      OR (a.purpose = 'story'
		        AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.attachment_id = a.id))
		    )
		  LIMIT 500`, chatCutoff)
	if err != nil {
		log.Printf("[media-retention] failed: %v", err)
		return
	}
	type att struct {
		id, path string
		backend  *string
	}
	var list []att
	for rows.Next() {
		var a att
		if rows.Scan(&a.id, &a.path, &a.backend) == nil {
			list = append(list, a)
		}
	}
	rows.Close()

	purged := 0
	for _, a := range list {
		if a.backend != nil && *a.backend == "s3" {
			storage.DeleteObject(ctx, a.path)
		} else {
			_ = os.Remove(filepath.Join(uploadDir(), filepath.FromSlash(a.path)))
		}
		if _, err := db.SysPool.Exec(ctx,
			`UPDATE attachments SET purged_at = NOW() WHERE id = $1`, a.id); err == nil {
			purged++
		}
	}
	if purged > 0 {
		log.Printf("[media-retention] purged %d delivered/expired attachment(s)", purged)
	}
}

// ── stories 24h TTL ────────────────────────────────────────────────────

func sweepExpiredStories(ctx context.Context) {
	batchedSweep(ctx, "sweep stories",
		`DELETE FROM stories
		  WHERE ctid IN (SELECT ctid FROM stories
		                  WHERE expires_at <= NOW()
		                  LIMIT $1)`)
}

// ── scheduled messages ─────────────────────────────────────────────────

func sweepScheduledMessages(ctx context.Context) {
	const batch = 50
	type claim struct {
		id                      int64
		userID, chatID, msgType string
		content                 *string
		meta                    []byte
		replyToID               *int64
	}
	// Claim in a tx so FOR UPDATE SKIP LOCKED actually holds across the batch
	// (multi-replica safe; single instance behaves like Node).
	tx, err := db.SysPool.Begin(ctx)
	if err != nil {
		log.Printf("[sched sweep] %v", err)
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx,
		`SELECT id, user_id, chat_id, type, content, meta, reply_to_id
		   FROM scheduled_messages
		  WHERE sent_at IS NULL AND send_at <= NOW()
		  ORDER BY send_at
		  FOR UPDATE SKIP LOCKED
		  LIMIT $1`, batch)
	if err != nil {
		log.Printf("[sched sweep] %v", err)
		return
	}
	var claims []claim
	for rows.Next() {
		var c claim
		if rows.Scan(&c.id, &c.userID, &c.chatID, &c.msgType, &c.content, &c.meta, &c.replyToID) == nil {
			claims = append(claims, c)
		}
	}
	rows.Close()

	delivered := 0
	for _, c := range claims {
		if err := deliverScheduled(ctx, tx, c.id, c.userID, c.chatID, c.msgType, c.content, c.meta, c.replyToID); err != nil {
			log.Printf("[sched %d] %v", c.id, err)
		} else {
			delivered++
		}
	}
	// Prune sent rows older than 30 d (same statement as Node).
	_, _ = tx.Exec(ctx,
		`DELETE FROM scheduled_messages
		  WHERE sent_at IS NOT NULL AND sent_at < NOW() - INTERVAL '30 days'`)
	if err := tx.Commit(ctx); err != nil {
		log.Printf("[sched sweep] commit: %v", err)
		return
	}
	if delivered > 0 {
		log.Printf("[sched] delivered %d scheduled message(s)", delivered)
	}
}

func deliverScheduled(ctx context.Context, tx pgx.Tx, schedID int64, userID, chatID, msgType string, content *string, meta []byte, replyToID *int64) error {
	// Skip if the sender left after scheduling — stamp sent, no message.
	var one int
	if err := tx.QueryRow(ctx,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, userID).Scan(&one); err != nil {
		if db.NoRows(err) {
			// Sender left the chat after scheduling: stamp it sent, deliver
			// nothing — and still drop the ciphertext. This branch never
			// produces a message, so the payload has no remaining purpose and
			// would otherwise sit here until the 30-day prune.
			_, e := tx.Exec(ctx,
				`UPDATE scheduled_messages SET sent_at = NOW(), content = NULL WHERE id = $1`, schedID)
			return e
		}
		return err
	}

	var (
		msgID                             int64
		mChatID, mSenderID, mType         string
		mContent                          *string
		mMeta                             []byte
		mReplyToID                        *int64
		mEditedAt, mDeletedAt, mExpiresAt *time.Time
		mCreatedAt                        time.Time
	)
	if err := tx.QueryRow(ctx,
		`INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id, expires_at)
		 SELECT $1, $2, $3, $4, $5, $6,
		        CASE WHEN c.disappearing_seconds IS NOT NULL
		             THEN NOW() + (c.disappearing_seconds || ' seconds')::INTERVAL
		             ELSE NULL END
		   FROM chats c WHERE c.id = $1
		 RETURNING id, chat_id, sender_id, type, content, meta, reply_to_id,
		           edited_at, deleted_at, created_at, expires_at`,
		chatID, userID, msgType, content, meta, replyToID).
		Scan(&msgID, &mChatID, &mSenderID, &mType, &mContent, &mMeta, &mReplyToID,
			&mEditedAt, &mDeletedAt, &mCreatedAt, &mExpiresAt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE chats SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
		msgID, mCreatedAt, chatID); err != nil {
		return err
	}
	// Drop the scheduled copy of the ciphertext the moment it has been handed to
	// the messages table.
	//
	// It used to survive here for 30 days: the row is only pruned by the
	// `sent_at < NOW() - 30 days` statement below, and nothing ever cleared
	// `content`. So a scheduled message left a SECOND server-side copy of its
	// ciphertext that outlived the message's own retention by a month, in a
	// table nobody looks at. Verified on production — one row was holding
	// post-delivery ciphertext when this was found.
	//
	// The row itself stays (sent_at, message_id are the delivery record the UI
	// reads); only the payload goes. Pre-send retention is unchanged and is a
	// genuine exception: a message scheduled for next week must keep its
	// ciphertext until then, because nothing else holds it.
	if _, err := tx.Exec(ctx,
		`UPDATE scheduled_messages SET sent_at = NOW(), message_id = $2, content = NULL WHERE id = $1`,
		schedID, msgID); err != nil {
		return err
	}

	// Broadcast — same key set as Node's scheduled worker payload; BIGINT ids
	// as strings + JS-shaped timestamps (node-pg parity).
	var metaVal any
	if len(mMeta) > 0 {
		_ = json.Unmarshal(mMeta, &metaVal)
	}
	var replyVal any
	if mReplyToID != nil {
		replyVal = jsonBigStr(*mReplyToID)
	}
	payload := map[string]any{
		"id":        jsonBigStr(msgID),
		"chatId":    mChatID,
		"senderId":  mSenderID,
		"type":      mType,
		"content":   mContent,
		"meta":      metaVal,
		"replyToId": replyVal,
		"editedAt":  httpx.JST(mEditedAt),
		"deletedAt": httpx.JST(mDeletedAt),
		"createdAt": httpx.JSTime(mCreatedAt),
		"expiresAt": httpx.JST(mExpiresAt),
	}
	emitx.ChatNewMessage(chatID, payload)
	return nil
}

// node-pg returns BIGINT columns as strings; keep that shape.
func jsonBigStr(n int64) string { return strconv.FormatInt(n, 10) }
