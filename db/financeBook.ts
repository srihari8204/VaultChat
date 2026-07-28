// db/financeBook.ts — local lending ledger (Lend/Borrow) for the Book tab.
// Fully on-device SQLite (shares interest.db). Tagged with the current user.

import * as SQLite from 'expo-sqlite';

export interface BookEntry {
  id: string;
  user_id: string;
  direction: 'lend' | 'borrow';
  name: string;
  mobile: string | null;
  interest_type: 'simple' | 'compound';
  principal: number;
  rate: number;
  rate_mode: 'rupees' | 'percent';
  from_date: number;    // epoch ms
  notes: string | null;
  created_at: number;
}

let _db: SQLite.SQLiteDatabase | null = null;
async function db(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('interest.db');
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS book_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      name TEXT NOT NULL,
      mobile TEXT,
      interest_type TEXT NOT NULL,
      principal REAL NOT NULL,
      rate REAL NOT NULL,
      rate_mode TEXT NOT NULL,
      from_date INTEGER NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_book_user ON book_entries(user_id, created_at DESC);
  `);
  return _db;
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function insertBook(row: Omit<BookEntry, 'id' | 'created_at'>): Promise<BookEntry> {
  const d = await db();
  const full: BookEntry = { ...row, id: uuid(), created_at: Date.now() };
  await d.runAsync(
    `INSERT INTO book_entries (id,user_id,direction,name,mobile,interest_type,principal,rate,rate_mode,from_date,notes,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.user_id, full.direction, full.name, full.mobile, full.interest_type,
     full.principal, full.rate, full.rate_mode, full.from_date, full.notes, full.created_at],
  );
  return full;
}

export async function listBook(userId: string): Promise<BookEntry[]> {
  const d = await db();
  return d.getAllAsync<BookEntry>(`SELECT * FROM book_entries WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

export async function deleteBook(id: string): Promise<void> {
  const d = await db();
  await d.runAsync(`DELETE FROM book_entries WHERE id = ?`, [id]);
}

export default { insertBook, listBook, deleteBook };
