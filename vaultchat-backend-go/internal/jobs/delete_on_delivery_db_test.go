// delete_on_delivery_db_test.go — runs the REAL deliveredMessagesSQL against a
// real Postgres.
//
// delete_on_delivery_test.go asserts the statement's TEXT: that the safety
// clauses are present. That catches a deletion, but it cannot catch a clause
// that is present and wrong, and it cannot check the meta split at all — the
// jsonb rewrite either produces the right object or it does not, and only
// Postgres can answer that.
//
// This is the most destructive statement in the product. It permanently
// discards user content, and the two ways it can be wrong are silent in
// opposite directions: reclaim too little and thumbnails live on the server
// forever; reclaim too much and a message nobody received is destroyed.
//
// Skipped unless TEST_PG_URL is set, so `go test ./...` stays green without a
// database. To run it:
//
//	initdb -D /tmp/pg -U postgres --auth=trust
//	pg_ctl -D /tmp/pg -o "-p 55433 -h 127.0.0.1" -w start
//	TEST_PG_URL=postgres://postgres@127.0.0.1:55433/postgres go test ./internal/jobs/ -run TestDeliveredSweepAgainstPostgres -v
package jobs

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

const fixtureDDL = `
DROP TABLE IF EXISTS messages, chat_members, chat_device_delivery, user_sync_devices;
CREATE TABLE messages (
  id         bigint PRIMARY KEY,
  chat_id    text NOT NULL,
  sender_id  text NOT NULL,
  content    text,
  meta       jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE TABLE chat_members (
  chat_id text NOT NULL, user_id text NOT NULL,
  left_at timestamptz, last_delivered_message_id bigint
);
CREATE TABLE chat_device_delivery (
  chat_id text NOT NULL, user_id text NOT NULL, device_id text NOT NULL,
  last_delivered_message_id bigint
);
CREATE TABLE user_sync_devices (
  user_id text NOT NULL, device_id text NOT NULL, last_sync_at timestamptz
);
`

func TestDeliveredSweepAgainstPostgres(t *testing.T) {
	url := os.Getenv("TEST_PG_URL")
	if url == "" {
		t.Skip("TEST_PG_URL not set — see the file header to run this")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	if _, err := conn.Exec(ctx, fixtureDDL); err != nil {
		t.Fatalf("ddl: %v", err)
	}

	// Every message is 4 hours old, so the 3-hour grace is satisfied and the
	// only thing deciding each outcome is the delivery predicate.
	seed := `
-- 1: fully delivered, rich meta. THE case the feature exists for.
INSERT INTO messages VALUES (1,'c1','alice','ciphertext-1',
  '{"attachmentId":"a1","thumb":"BASE64JPEG","filename":"holiday.jpg","mime":"image/jpeg","encrypted":true}',
  NULL, NOW() - interval '4 hours');
-- 2: NOT delivered — bob's pointer is behind it.
INSERT INTO messages VALUES (2,'c2','alice','ciphertext-2','{"thumb":"SECRET"}',NULL,NOW() - interval '4 hours');
-- 3: account pointer says delivered, but bob's SECOND device is behind and active.
INSERT INTO messages VALUES (3,'c3','alice','ciphertext-3','{"thumb":"SECRET"}',NULL,NOW() - interval '4 hours');
-- 4: same, but that device has been silent past the staleness window.
INSERT INTO messages VALUES (4,'c4','alice','ciphertext-4','{"thumb":"GONE"}',NULL,NOW() - interval '4 hours');
-- 5: nobody else is in the chat at all.
INSERT INTO messages VALUES (5,'c5','alice','ciphertext-5','{"thumb":"SECRET"}',NULL,NOW() - interval '4 hours');
-- 6: delivered poll — options must become optionCount.
INSERT INTO messages VALUES (6,'c6','alice','ciphertext-6',
  '{"options":["Pizza","Pasta","Salad"],"allowMultiple":true}',NULL,NOW() - interval '4 hours');
-- 7: delivered message with mentions — names go, ids stay.
INSERT INTO messages VALUES (7,'c7','alice','ciphertext-7',
  '{"mentions":[{"userId":"u9","name":"Bob"},{"userId":"u8","name":"Cara"}]}',NULL,NOW() - interval '4 hours');
-- 8: delivered, but NULL meta — must stay NULL, not become '{}'.
INSERT INTO messages VALUES (8,'c8','alice','ciphertext-8',NULL,NULL,NOW() - interval '4 hours');

INSERT INTO chat_members VALUES
  ('c1','alice',NULL,1),('c1','bob',NULL,1),
  ('c2','alice',NULL,2),('c2','bob',NULL,1),          -- behind message 2
  ('c3','alice',NULL,3),('c3','bob',NULL,3),
  ('c4','alice',NULL,4),('c4','bob',NULL,4),
  ('c5','alice',NULL,5),                               -- sender only
  ('c6','alice',NULL,6),('c6','bob',NULL,6),
  ('c7','alice',NULL,7),('c7','bob',NULL,7),
  ('c8','alice',NULL,8),('c8','bob',NULL,8);

-- bob's phone is current everywhere; his tablet is behind in c3 and c4.
INSERT INTO user_sync_devices VALUES
  ('bob','phone',NOW()), ('bob','tablet-live',NOW()), ('bob','tablet-stale',NOW() - interval '400 days');
-- EVERY live device needs a row, or it counts as behind. That is the correct
-- reading and this fixture originally got it wrong: tablet-live had no row for
-- c1/c4, so the sweep refused to reclaim them and the test caught it.
INSERT INTO chat_device_delivery VALUES
  ('c1','bob','phone',1),('c1','bob','tablet-live',1),
  ('c3','bob','phone',3),('c3','bob','tablet-live',2),   -- live tablet behind
  ('c4','bob','phone',4),('c4','bob','tablet-live',4),
                         ('c4','bob','tablet-stale',3),  -- stale tablet behind
  ('c6','bob','phone',6),('c6','bob','tablet-live',6),
  ('c7','bob','phone',7),('c7','bob','tablet-live',7),
  ('c8','bob','phone',8),('c8','bob','tablet-live',8);
`
	if _, err := conn.Exec(ctx, seed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Real parameters: the shipping 3-hour grace, the shipping batch size, the
	// 30-day staleness floor, and the SAME allow-list the write side splits on.
	if _, err := conn.Exec(ctx, deliveredMessagesSQL,
		strconv.Itoa(3*60*60), 5000, strconv.Itoa(30), MetaPublicKeys); err != nil {
		t.Fatalf("the sweep statement failed to execute: %v", err)
	}

	type row struct {
		content *string
		meta    *string
	}
	get := func(id int) row {
		var r row
		if err := conn.QueryRow(ctx,
			`SELECT content, meta::text FROM messages WHERE id = $1`, id).Scan(&r.content, &r.meta); err != nil {
			t.Fatalf("read %d: %v", id, err)
		}
		return r
	}
	reclaimed := func(id int) bool { return get(id).content == nil }

	// ── what must be reclaimed ─────────────────────────────────────────
	t.Run("a fully delivered message loses its body", func(t *testing.T) {
		if !reclaimed(1) {
			t.Fatal("message 1 was delivered to every device and kept its content")
		}
	})

	t.Run("and loses its thumbnail, filename and mime", func(t *testing.T) {
		m := *get(1).meta
		for _, leak := range []string{"BASE64JPEG", "holiday.jpg", "image/jpeg", "thumb", "filename", "mime"} {
			if strings.Contains(m, leak) {
				t.Fatalf(`meta still contains %q after reclaim: %s

This is the whole point of the change. Nulling content while leaving meta keeps
a legible preview of the photo on the server forever.`, leak, m)
			}
		}
		// ...while keeping exactly what the server still needs to route it.
		for _, keep := range []string{"attachmentId", "a1", "encrypted"} {
			if !strings.Contains(m, keep) {
				t.Fatalf("meta lost %q, which server code reads: %s", keep, m)
			}
		}
	})

	t.Run("a stale device does not hold a message hostage", func(t *testing.T) {
		if !reclaimed(4) {
			t.Fatal("a device silent for 400 days still pinned message 4 on the server")
		}
	})

	// ── what must NOT be reclaimed ─────────────────────────────────────
	t.Run("an undelivered message is untouched", func(t *testing.T) {
		if reclaimed(2) {
			t.Fatal(`message 2 was destroyed and bob never received it.

The server held the only copy that could still reach him.`)
		}
		if !strings.Contains(*get(2).meta, "SECRET") {
			t.Fatal("message 2's meta was stripped even though it was never delivered")
		}
	})

	t.Run("a live second device still behind it protects it", func(t *testing.T) {
		if reclaimed(3) {
			t.Fatal(`message 3 was destroyed while bob's tablet had never received it.

The account pointer is advanced by whichever device acks FIRST, so it cannot be
the only check on a multi-device account.`)
		}
	})

	t.Run("a chat with no other member is left alone", func(t *testing.T) {
		if reclaimed(5) {
			t.Fatal(`message 5 was destroyed in a chat with no other members.

NOT EXISTS over an empty set is TRUE, so without the EXISTS guard every message
in a chat whose members all left is reclaimed immediately.`)
		}
	})

	// ── the derivations ────────────────────────────────────────────────
	t.Run("poll options become optionCount", func(t *testing.T) {
		m := *get(6).meta
		if strings.Contains(m, "Pizza") {
			t.Fatalf("poll option TEXT survived reclaim: %s", m)
		}
		if !strings.Contains(m, `"optionCount": 3`) && !strings.Contains(m, `"optionCount":3`) {
			t.Fatalf(`optionCount was not derived: %s

The vote handler falls back to len(options) when optionCount is absent, so
stripping options without deriving it breaks voting on every existing poll.`, m)
		}
		if !strings.Contains(m, "allowMultiple") {
			t.Fatalf("allowMultiple is public and should have survived: %s", m)
		}
	})

	t.Run("mention names go, mention ids stay", func(t *testing.T) {
		m := *get(7).meta
		if strings.Contains(m, "Bob") || strings.Contains(m, "Cara") {
			t.Fatalf("mention display names survived reclaim: %s", m)
		}
		if !strings.Contains(m, "u9") || !strings.Contains(m, "u8") {
			t.Fatalf(`mentionUserIds was not derived: %s

chatsSendMessagePush needs the ids to override a muted chat for a mentioned user.`, m)
		}
	})

	t.Run("a NULL meta stays NULL", func(t *testing.T) {
		if m := get(8).meta; m != nil {
			t.Fatalf("meta was NULL and became %q — an empty object is not the same value", *m)
		}
	})

	// ── idempotence ────────────────────────────────────────────────────
	t.Run("a second pass changes nothing", func(t *testing.T) {
		before := *get(1).meta
		tag, err := conn.Exec(ctx, deliveredMessagesSQL,
			strconv.Itoa(3*60*60), 5000, strconv.Itoa(30), MetaPublicKeys)
		if err != nil {
			t.Fatalf("second pass: %v", err)
		}
		if tag.RowsAffected() != 0 {
			t.Fatalf(`the sweep rewrote %d already-reclaimed rows.

Every tick would emit a new heap tuple and a WAL record for no change at all.`, tag.RowsAffected())
		}
		if after := *get(1).meta; after != before {
			t.Fatalf("meta changed on a second pass: %s -> %s", before, after)
		}
	})
}
