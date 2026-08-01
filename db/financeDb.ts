// db/financeDb.ts — shared SQLite handle + helpers for the Vault Finance hub.
//
// Every finance store (ledger, chitti, reminders, timeline) shares one on-device
// database file (`interest.db`, the same one the calculator already uses) so all
// finance data lives together and nothing touches the messaging schema. Fully
// offline; rows are tagged with the current user_id.

import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;
let _ready: Promise<SQLite.SQLiteDatabase> | null = null;

/** Open (once) the shared finance DB and ensure every finance table exists. */
export async function financeDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (_ready) return _ready;
  _ready = (async () => {
    const d = await SQLite.openDatabaseAsync('interest.db');
    await d.execAsync(SCHEMA);
    _db = d;
    return d;
  })();
  return _ready;
}

/** RFC4122-ish v4 id (Math.random is fine — ids are local-only). */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const now = () => Date.now();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  direction     TEXT NOT NULL,          -- 'lend' | 'borrow'
  name          TEXT NOT NULL,
  mobile        TEXT,
  interest_type TEXT NOT NULL,          -- 'simple' | 'compound'
  principal     REAL NOT NULL,
  rate          REAL NOT NULL,
  rate_mode     TEXT NOT NULL,          -- 'rupees' | 'percent'
  period        TEXT NOT NULL,          -- 'daily'|'weekly'|'monthly'|'yearly'
  start_date    INTEGER NOT NULL,
  end_date      INTEGER,
  remaining     REAL NOT NULL,
  status        TEXT NOT NULL,          -- 'running' | 'overdue' | 'completed'
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  last_updated  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_updates (
  id         TEXT PRIMARY KEY,
  ledger_id  TEXT NOT NULL,
  received   REAL NOT NULL,
  remaining  REAL NOT NULL,
  note       TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledupd_ledger ON ledger_updates(ledger_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS finance_timeline (
  id        TEXT PRIMARY KEY,
  ref_type  TEXT NOT NULL,             -- 'ledger' | 'chitti'
  ref_id    TEXT NOT NULL,
  kind      TEXT NOT NULL,             -- 'created' | 'update' | 'reminder' | 'edit' | 'note'
  detail    TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_ref ON finance_timeline(ref_type, ref_id, at DESC);

CREATE TABLE IF NOT EXISTS chitti_groups (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  chit_value  REAL NOT NULL,
  installment REAL NOT NULL,
  members     INTEGER NOT NULL,
  duration    INTEGER NOT NULL,        -- months
  start_date  INTEGER NOT NULL,
  foreman     TEXT,
  status      TEXT NOT NULL,           -- 'active' | 'closed' | 'draft'
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chitti_user ON chitti_groups(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chitti_members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT,
  number     INTEGER NOT NULL,         -- member number in the group
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cmember_group ON chitti_members(group_id, number ASC);

CREATE TABLE IF NOT EXISTS chitti_collections (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  month      INTEGER NOT NULL,         -- installment month index (1-based)
  amount     REAL NOT NULL,
  status     TEXT NOT NULL,            -- 'paid' | 'pending' | 'overdue'
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccoll_group ON chitti_collections(group_id, month ASC);

CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  ref_type   TEXT,                     -- 'ledger' | 'chitti' | null (custom)
  ref_id     TEXT,
  title      TEXT NOT NULL,
  freq       TEXT NOT NULL,            -- 'once'|'daily'|'weekly'|'monthly'|'yearly'
  next_at    INTEGER NOT NULL,
  status     TEXT NOT NULL,            -- 'active' | 'done'
  notif_id   TEXT,                     -- expo-notifications identifier
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminder_user ON reminders(user_id, next_at ASC);
`;

export default financeDb;
