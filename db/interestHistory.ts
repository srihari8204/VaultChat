// db/interestHistory.ts — on-device SQLite history for the interest calculator.
//
// Fully local (no backend). Own DB file so it never touches the messaging
// schema. Rows are tagged with the current VaultChat user_id + user_name.

import * as SQLite from 'expo-sqlite';

export interface InterestRow {
  id: string;
  user_id: string;
  user_name: string;
  type: 'simple' | 'compound';
  principal: number;
  rate: number;
  time_years: number;
  frequency: number | null;   // NULL for simple
  interest: number;
  total_amount: number;
  created_at: number;         // epoch ms
}

let _db: SQLite.SQLiteDatabase | null = null;

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('interest.db');
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS interest_history (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      user_name     TEXT NOT NULL,
      type          TEXT NOT NULL,
      principal     REAL NOT NULL,
      rate          REAL NOT NULL,
      time_years    REAL NOT NULL,
      frequency     INTEGER,
      interest      REAL NOT NULL,
      total_amount  REAL NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_interest_user ON interest_history(user_id, created_at DESC);
  `);
  return _db;
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function insertInterest(
  row: Omit<InterestRow, 'id' | 'created_at'> & { id?: string; created_at?: number },
): Promise<InterestRow> {
  const d = await db();
  const full: InterestRow = { ...row, id: row.id ?? uuid(), created_at: row.created_at ?? Date.now() } as InterestRow;
  await d.runAsync(
    `INSERT INTO interest_history
       (id, user_id, user_name, type, principal, rate, time_years, frequency, interest, total_amount, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [full.id, full.user_id, full.user_name, full.type, full.principal, full.rate,
     full.time_years, full.frequency, full.interest, full.total_amount, full.created_at],
  );
  return full;
}

export async function listInterest(userId: string): Promise<InterestRow[]> {
  const d = await db();
  return d.getAllAsync<InterestRow>(
    `SELECT * FROM interest_history WHERE user_id = ? ORDER BY created_at DESC`, [userId],
  );
}

export async function deleteInterest(id: string): Promise<void> {
  const d = await db();
  await d.runAsync(`DELETE FROM interest_history WHERE id = ?`, [id]);
}

export default { insertInterest, listInterest, deleteInterest };
