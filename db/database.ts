// db/database.ts — op-sqlite (JSI) database + migration runner (Task 3).
//
// This is the local-first SOURCE OF TRUTH for chats/messages/contacts. The UI
// reads from here synchronously and never awaits the network to render; a
// background sync merges server rows in.
//
// One database file `vaultchat.db`, opened lazily on first use with
//   PRAGMA journal_mode=WAL;    — concurrent reads during writes, fast
//   PRAGMA synchronous=NORMAL;  — durable enough for a cache, much faster
//   PRAGMA foreign_keys=ON;     — outbox.message_id → messages(id)
//
// Schema versioning is keyed on PRAGMA user_version: each migration bumps it,
// so a fresh install and an upgrade-from-existing both converge to the latest.

import { open, type DB } from '@op-engineering/op-sqlite';

const DB_NAME = 'vaultchat.db';

let _db: DB | null = null;

/** Lazily open the database + run migrations. Safe to call repeatedly. */
export function getDb(): DB {
  if (_db) return _db;
  const db = open({ name: DB_NAME });
  db.executeSync('PRAGMA journal_mode=WAL;');
  db.executeSync('PRAGMA synchronous=NORMAL;');
  db.executeSync('PRAGMA foreign_keys=ON;');
  runMigrations(db);
  _db = db;
  return db;
}

// ── Migration runner ────────────────────────────────────────────────
// Ordered list; index+1 is the target user_version. To add schema, push a new
// entry — never edit an existing one (installed devices have already run it).
type Migration = (db: DB) => void;

const MIGRATIONS: Migration[] = [
  // v1 — initial schema
  (db) => {
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS chats (
        id                   TEXT PRIMARY KEY,
        type                 TEXT,
        title                TEXT,
        last_message_id      TEXT,
        last_message_preview TEXT,
        last_message_at      INTEGER,
        unread_count         INTEGER DEFAULT 0,
        pinned               INTEGER DEFAULT 0,
        updated_at           INTEGER,
        -- Full server ChatSummary JSON (photoURL, muted, archived, peer* …) so
        -- the rich list UI renders from the store without a schema column per
        -- field. Typed columns above drive ordering/preview; this drives render.
        data                 TEXT
      );
    `);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,   -- client-generated UUID v4
        chat_id          TEXT,
        sender_id        TEXT,
        kind             TEXT,               -- text|image|video|file|...
        body             TEXT,               -- decrypted plaintext, device-local only
        media_local_path TEXT,
        media_remote_key TEXT,
        created_at       INTEGER,
        server_ts        INTEGER,
        status           TEXT CHECK(status IN ('pending','sent','delivered','read','failed'))
      );
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages (chat_id, created_at);`);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS contacts (
        id                TEXT PRIMARY KEY,
        display_name      TEXT,
        avatar_local_path TEXT,
        last_seen         INTEGER,
        updated_at        INTEGER
      );
    `);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS outbox (
        message_id   TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        attempts     INTEGER DEFAULT 0,
        next_retry_at INTEGER,
        created_at   INTEGER
      );
    `);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  },
];

function runMigrations(db: DB): void {
  const res = db.executeSync('PRAGMA user_version;');
  // PRAGMA user_version returns a single row { user_version: N }.
  const row = res.rows?.[0] as Record<string, number> | undefined;
  let current = Number(row?.user_version ?? 0);

  for (let v = current; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](db);
    db.executeSync(`PRAGMA user_version = ${v + 1};`);
    current = v + 1;
  }
}

/** Current schema version (for diagnostics/tests). */
export function schemaVersion(): number {
  const res = getDb().executeSync('PRAGMA user_version;');
  const row = res.rows?.[0] as Record<string, number> | undefined;
  return Number(row?.user_version ?? 0);
}

/** Test/reset helper — drops every row (keeps schema). Not used in prod flows. */
export function _wipeAll(): void {
  const db = getDb();
  db.executeSync('DELETE FROM outbox;');
  db.executeSync('DELETE FROM messages;');
  db.executeSync('DELETE FROM chats;');
  db.executeSync('DELETE FROM contacts;');
  db.executeSync('DELETE FROM sync_state;');
}
