// db/shopLists.ts — on-device reusable shopping lists for SHOP BOOK (Phase 2).
//
// Fully local (no backend) — a shopping list is a private, reusable set of
// item names the customer can push into a cart in one tap. Own DB file so it
// never touches the messaging schema. Rows are tagged with the VaultChat user.

import * as SQLite from 'expo-sqlite';

export interface ShopList {
  id: string;
  user_id: string;
  name: string;
  items: string;        // newline-separated item names
  created_at: number;   // epoch ms
}

let _db: SQLite.SQLiteDatabase | null = null;

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('shopbook_lists.db');
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS shop_lists (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      items      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shop_lists_user ON shop_lists(user_id, created_at DESC);
  `);
  return _db;
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function listShopLists(userId: string): Promise<ShopList[]> {
  const d = await db();
  return d.getAllAsync<ShopList>(
    `SELECT * FROM shop_lists WHERE user_id=? ORDER BY created_at DESC`, [userId],
  );
}

export async function saveShopList(
  row: { id?: string; user_id: string; name: string; items: string },
): Promise<ShopList> {
  const d = await db();
  const full: ShopList = {
    id: row.id ?? uuid(),
    user_id: row.user_id,
    name: row.name,
    items: row.items,
    created_at: Date.now(),
  };
  await d.runAsync(
    `INSERT INTO shop_lists (id, user_id, name, items, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, items=excluded.items`,
    [full.id, full.user_id, full.name, full.items, full.created_at],
  );
  return full;
}

export async function deleteShopList(id: string): Promise<void> {
  const d = await db();
  await d.runAsync(`DELETE FROM shop_lists WHERE id=?`, [id]);
}

export default {};
